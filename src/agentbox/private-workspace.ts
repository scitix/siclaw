import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  WORKSPACE_OBJECT_BYTES, WORKSPACE_MAX_OBJECTS, WorkspaceTransportError,
  type WorkspaceBinding, type WorkspaceObjectRef, type WorkspaceRequest,
} from "../shared/private-workspace.js";

export interface WorkspaceTransport { exchange<T>(request: WorkspaceRequest): Promise<T> }
export interface WorkspaceFile { path: string; size: number; sha256: string; chunks: WorkspaceObjectRef[] }
export interface WorkspaceManifest {
  format: "siclaw-workspace-v1";
  spaceId: string;
  sessionId: string;
  files: WorkspaceFile[];
}

const sha = (v: Buffer) => createHash("sha256").update(v).digest("hex");
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

export function safeWorkspacePath(name: string): string {
  if (!name || name.length > 1024 || name.startsWith("/") || name.includes("\\") ||
      /[\x00-\x1f\x7f]/.test(name) || name.split("/").some(v => !v || v === "." || v === "..")) {
    throw new Error("Invalid private workspace path");
  }
  return name;
}

/** Capture regular files only. No archive-controlled paths, links, owners or modes. */
export function captureWorkspaceFiles(roots: Record<string, string>): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let bytes = 0;
  for (const [prefix, root] of Object.entries(roots)) {
    const walk = (dir: string, relative: string) => {
      if (!fs.existsSync(dir)) return;
      if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error("Unsafe workspace directory");
      for (const name of fs.readdirSync(dir).sort()) {
        // Only the known local index is rebuildable. User databases and .tmp
        // files are user content and must survive checkpointing.
        if (prefix === "memory" && relative === "" && /^\.memory\.db(?:-wal|-shm)?$/.test(name)) continue;
        const full = path.join(dir, name), rel = relative ? `${relative}/${name}` : name;
        const stat = fs.lstatSync(full);
        if (stat.isDirectory()) { walk(full, rel); continue; }
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o6000)) throw new Error("Links and special files cannot be checkpointed");
        bytes += stat.size;
        if (bytes > MAX_TOTAL_BYTES || files.size >= WORKSPACE_MAX_OBJECTS) throw new Error("Private workspace checkpoint limit exceeded");
        const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const before = fs.fstatSync(fd);
          if (!before.isFile() || before.ino !== stat.ino || before.dev !== stat.dev || before.nlink !== 1) throw new Error("Workspace changed while capturing");
          const data = fs.readFileSync(fd), after = fs.fstatSync(fd);
          if (after.size !== data.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("Workspace changed while capturing");
          files.set(safeWorkspacePath(`${prefix}/${rel}`), data);
        } finally { fs.closeSync(fd); }
      }
    };
    walk(root, "");
  }
  return files;
}

export class PrivateWorkspace {
  private binding?: WorkspaceBinding;
  private timer?: ReturnType<typeof setInterval>;
  private failure?: Error;
  private validUntil = 0;
  private previous?: WorkspaceManifest;
  private pending: Promise<void> = Promise.resolve();
  private acquiring?: Promise<void>;
  private renewing?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private executionStopped = false;
  private renewalDelayed = false;
  readonly incarnation = randomUUID();

  constructor(
    private readonly transport: WorkspaceTransport,
    readonly sessionId: string,
    readonly spaceId: string,
  ) {}

  private request<T>(action: WorkspaceRequest["action"], extra: Partial<WorkspaceRequest> = {}): Promise<T> {
    return this.transport.exchange<T>({ action, sessionId: this.sessionId, incarnation: this.incarnation, binding: this.binding, ...extra });
  }

  async acquire(): Promise<void> {
    if (this.closed) throw new Error("Private workspace is closed");
    if (this.failure) throw this.failure;
    if (this.binding) { this.assertHealthy(); return; }
    if (this.acquiring) return this.acquiring;
    this.acquiring = this.acquireInner();
    try { await this.acquiring; } finally { this.acquiring = undefined; }
  }

  private async acquireInner(): Promise<void> {
    const started = Date.now();
    const b = await this.request<WorkspaceBinding>("acquire");
    if (b.spaceId !== this.spaceId || b.workspaceId !== this.sessionId || !Number.isSafeInteger(b.epoch) || b.epoch < 1) throw new Error("Workspace identity mismatch");
    this.binding = b;
    this.validUntil = started + 90_000;
    this.assertHealthy();
    this.timer = setInterval(() => {
      // renewInner classifies failures. A temporary outage must not permanently
      // fence a still-valid lease; the next interval may retry within its window.
      void this.renewLease().catch(() => {});
    }, 30_000);
    this.timer.unref();
  }

  assertHealthy(): void {
    if (this.closed) throw new Error("Private workspace is closed");
    if (this.failure) throw this.failure;
    if (!this.binding) throw new Error("Workspace has not been acquired");
    if (Date.now() >= this.validUntil) {
      console.warn("[private-workspace] lease validity expired; recovery required");
      this.markFailed(); throw this.failure;
    }
  }

  async validateExecution(): Promise<void> {
    if (this.executionStopped) throw new Error("Private workspace execution has stopped");
    await this.renewLease();
    if (this.executionStopped) throw new Error("Private workspace execution has stopped");
    this.assertHealthy();
  }

  private async renewLease(): Promise<void> {
    this.assertHealthy();
    if (this.renewing) return this.renewing;
    this.renewing = this.renewInner();
    try { await this.renewing; } finally { this.renewing = undefined; }
  }

  private async renewInner(): Promise<void> {
    const started = Date.now();
    try {
      const result = await this.request<{ ok: boolean }>("renew");
      if (result?.ok !== true) throw new Error("Invalid private workspace renewal response");
    }
    catch (error) {
      if (!(error instanceof WorkspaceTransportError) || !error.retriable) this.markFailed();
      // A failed renewal never extends validity. Even transient failures become
      // terminal once the old window expires; tool callers still receive an error.
      this.assertHealthy();
      if (!this.renewalDelayed) {
        this.renewalDelayed = true;
        // Log once per outage, without raw errors, identities or response bodies.
        console.warn("[private-workspace] lease renewal failed; retrying within existing validity window", {
          remainingValidityMs: Math.max(0, this.validUntil - Date.now()),
        });
      }
      throw error;
    }
    // Do not let a late success revive an expired, closed or fenced executor.
    this.assertHealthy();
    this.validUntil = started + 90_000;
    this.assertHealthy();
    if (this.renewalDelayed) {
      this.renewalDelayed = false;
      console.info("[private-workspace] lease renewal recovered");
    }
  }
  markFailed(): void { this.failure = new Error("Private workspace requires recovery"); }

  /** Fence tools immediately while retaining the lease for a final checkpoint. */
  stopExecution(): void { this.executionStopped = true; }

  async learn(): Promise<void> { this.assertHealthy(); await this.request("learn"); }

  async search(query: string): Promise<{ records: Array<{ id: string; kind: string; text: string; sourceSessionId: string; sourceEntryId: string; expiresAt: number }> }> {
    this.assertHealthy();
    return this.request("memory_search", { query });
  }

  private async get(ref: WorkspaceObjectRef): Promise<Buffer> {
    if (ref.spaceId !== this.spaceId || !ref.versionId || ref.versionId === "null" || ref.size > WORKSPACE_OBJECT_BYTES) throw new Error("Invalid workspace object reference");
    const result = await this.request<{ data: string }>("get", { objectId: ref.id });
    const data = Buffer.from(result.data, "base64");
    if (data.length !== ref.size || sha(data) !== ref.sha256) throw new Error("Workspace object integrity check failed");
    this.assertHealthy();
    return data;
  }

  async restore(roots: Record<string, string>): Promise<boolean> {
    await this.acquire();
    // An empty remote head is authoritative too. Discard local leftovers from a
    // failed first checkpoint instead of adopting an uncommitted transcript.
    const restored = !!this.binding!.manifest;
    const manifest: WorkspaceManifest = this.binding!.manifest
      ? JSON.parse((await this.get(this.binding!.manifest)).toString("utf8"))
      : { format: "siclaw-workspace-v1", spaceId: this.spaceId, sessionId: this.sessionId, files: [] };
    if (manifest.format !== "siclaw-workspace-v1" || manifest.spaceId !== this.spaceId || manifest.sessionId !== this.sessionId ||
      !Array.isArray(manifest.files) || manifest.files.length > WORKSPACE_MAX_OBJECTS) throw new Error("Invalid workspace manifest");
    const seen = new Set<string>();
    let total = 0, chunks = 0;
    // Validate and fetch everything before replacing any current local projection.
    const data = new Map<string, Buffer>();
    for (const f of manifest.files) {
      safeWorkspacePath(f.path);
      const [prefix, ...relative] = f.path.split("/");
      if (!roots[prefix] || !relative.length || seen.has(f.path) || !Number.isSafeInteger(f.size) || f.size < 0 || !Array.isArray(f.chunks)) throw new Error("Invalid workspace file");
      for (const old of seen) if (old.startsWith(`${f.path}/`) || f.path.startsWith(`${old}/`)) throw new Error("Conflicting workspace paths");
      seen.add(f.path); total += f.size;
      chunks += f.chunks.length;
      if (total > MAX_TOTAL_BYTES || chunks > WORKSPACE_MAX_OBJECTS) throw new Error("Workspace restore limit exceeded");
      const pieces: Buffer[] = [];
      let size = 0;
      for (const ref of f.chunks) { const chunk = await this.get(ref); pieces.push(chunk); size += chunk.length; if (size > f.size) throw new Error("Invalid workspace file length"); }
      const bytes = Buffer.concat(pieces);
      if (bytes.length !== f.size || sha(bytes) !== f.sha256) throw new Error("Workspace file integrity check failed");
      data.set(f.path, bytes);
    }
    for (const [prefix, root] of Object.entries(roots)) {
      this.assertHealthy();
      const parent = path.dirname(root);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (fs.realpathSync(parent) !== path.resolve(parent)) throw new Error("Unsafe restore parent");
      const stage = fs.mkdtempSync(path.join(parent, ".workspace-restore-"));
      const sharedFiles = prefix === "files" && process.platform === "linux" && process.getuid?.() === 1000;
      if (sharedFiles) { fs.chownSync(stage, 1000, 1001); fs.chmodSync(stage, 0o2750); }
      try {
        for (const [name, bytes] of data) {
          if (!name.startsWith(`${prefix}/`)) continue;
          const dest = path.join(stage, name.slice(prefix.length + 1));
          fs.mkdirSync(path.dirname(dest), { recursive: true, mode: sharedFiles ? 0o2750 : 0o700 });
          fs.writeFileSync(dest, bytes, { mode: sharedFiles ? 0o640 : 0o600, flag: "wx" });
          if (sharedFiles) fs.chmodSync(dest, 0o640);
        }
        if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error("Unsafe restore root");
        fs.rmSync(root, { force: true, recursive: true });
        fs.renameSync(stage, root);
      } finally { fs.rmSync(stage, { force: true, recursive: true }); }
    }
    this.previous = manifest;
    return restored;
  }

  /** Input bytes must be frozen at a quiescent tool/session boundary. */
  checkpoint(files: Map<string, Buffer>): Promise<void> {
    const run = this.pending.then(async () => {
      this.assertHealthy();
      if (!this.binding) throw new Error("Workspace has not been acquired");
      const old = new Map(this.previous?.files.map(f => [f.path, f]) ?? []);
      const manifest: WorkspaceManifest = { format: "siclaw-workspace-v1", spaceId: this.spaceId, sessionId: this.sessionId, files: [] };
      let total = 0, objects = 0;
      for (const [name, data] of files) {
        safeWorkspacePath(name); total += data.length;
        if (total > MAX_TOTAL_BYTES) throw new Error("Workspace checkpoint limit exceeded");
        const digest = sha(data), prev = old.get(name);
        if (prev?.sha256 === digest && prev.size === data.length) { manifest.files.push(prev); objects += prev.chunks.length; continue; }
        const chunks: WorkspaceObjectRef[] = [];
        for (let offset = 0; offset < data.length; offset += WORKSPACE_OBJECT_BYTES) {
          if (++objects >= WORKSPACE_MAX_OBJECTS) throw new Error("Workspace object limit exceeded");
          const piece = data.subarray(offset, offset + WORKSPACE_OBJECT_BYTES);
          const ref = await this.request<WorkspaceObjectRef>("put", { data: piece.toString("base64") });
          if (ref.spaceId !== this.spaceId || ref.size !== piece.length || ref.sha256 !== sha(piece)) throw new Error("Workspace upload mismatch");
          chunks.push(ref);
        }
        manifest.files.push({ path: name, size: data.length, sha256: digest, chunks });
      }
      const manifestBytes = Buffer.from(JSON.stringify(manifest));
      if (manifestBytes.length > WORKSPACE_OBJECT_BYTES || objects >= WORKSPACE_MAX_OBJECTS) throw new Error("Workspace manifest limit exceeded");
      const ref = await this.request<WorkspaceObjectRef>("put", { data: manifestBytes.toString("base64") });
      this.assertHealthy();
      const commit = { ...this.binding, operationId: randomUUID(), manifestId: ref.id, objectIds: [...new Set(manifest.files.flatMap(f => f.chunks.map(c => c.id)))] };
      // Preserve EXACT operation ID and content after an ambiguous response.
      let receipt: { revision: number };
      try { receipt = await this.request("commit", { commit }); }
      catch { this.assertHealthy(); receipt = await this.request("commit", { commit }); }
      if (receipt.revision !== this.binding.revision + 1) throw new Error("Workspace receipt mismatch");
      this.binding = { ...this.binding, revision: receipt.revision, manifest: ref };
      this.previous = manifest;
    });
    this.pending = run.catch(error => { this.markFailed(); throw error; });
    // The caller owns the error; avoid an unobserved queue rejection.
    void this.pending.catch(() => {});
    return run;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.closing = (async () => {
      // Finish in-flight transport calls before release: a delayed renewal
      // must not extend a lease that has already been relinquished.
      await Promise.allSettled([this.acquiring, this.renewing, this.pending]);
      if (this.binding) await this.request("release").catch(() => {});
      this.binding = undefined;
    })();
    return this.closing;
  }

  /** Stop this executor without handing its lease to another live writer. */
  abandon(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }
}
