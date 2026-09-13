import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { PrivateWorkspace, captureWorkspaceFiles, safeWorkspacePath, type WorkspaceTransport } from "./private-workspace.js";
import { WorkspaceTransportError, type WorkspaceBinding, type WorkspaceObjectRef, type WorkspaceRequest } from "../shared/private-workspace.js";
import { privateWorkspaceRoots } from "../shared/private-workspace-paths.js";

const dirs: string[] = [];
function dir() { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "private-workspace-"))); dirs.push(d); return d; }
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

class Store implements WorkspaceTransport {
  objects = new Map<string, { ref: WorkspaceObjectRef; data: Buffer }>();
  binding: WorkspaceBinding = { spaceId: "space", workspaceId: "sid", revision: 0, epoch: 1, placementEpoch: 1, generation: 0, leaseUntil: Date.now() + 120000, manifest: null };
  loseCommitReply = false;
  receipts = new Map<string, number>();
  async exchange<T>(in_: WorkspaceRequest): Promise<T> {
    let result: unknown = { ok: true };
    if (in_.action === "acquire") result = { ...this.binding };
    if (in_.action === "put") {
      const data = Buffer.from(in_.data!, "base64"), id = randomUUID();
      const ref: WorkspaceObjectRef = { id, spaceId: "space", storageBackendId: "original-store", key: id, versionId: "v1", sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
      this.objects.set(id, { ref, data }); result = ref;
    }
    if (in_.action === "get") result = { data: this.objects.get(in_.objectId!)!.data.toString("base64") };
    if (in_.action === "commit") {
      const commit = in_.commit!;
      if (!this.receipts.has(commit.operationId)) {
        this.binding.revision++;
        this.binding.manifest = this.objects.get(commit.manifestId)!.ref;
        this.receipts.set(commit.operationId, this.binding.revision);
      }
      result = { revision: this.receipts.get(commit.operationId) };
      if (this.loseCommitReply) { this.loseCommitReply = false; throw new Error("reply lost"); }
    }
    return result as T;
  }
}

it("restores files and sidecars in a new runtime, including an ambiguous commit reply", async () => {
  const store = new Store(), original = new PrivateWorkspace(store, "sid", "space");
  await original.acquire(); store.loseCommitReply = true;
  await original.checkpoint(new Map([["sessions/sid/.plan-ledger.json", Buffer.from('[{"id":"1"}]')], ["files/report.txt", Buffer.from("verified result")]]));
  expect(store.receipts.size).toBe(1);
  await original.close();
  const target = dir(), restored = new PrivateWorkspace(store, "sid", "space");
  try {
    expect(await restored.restore({ sessions: path.join(target, "sessions"), files: path.join(target, "files") })).toBe(true);
    expect(fs.readFileSync(path.join(target, "files/report.txt"), "utf8")).toBe("verified result");
    expect(fs.statSync(path.join(target, "files/report.txt")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(target, "sessions/sid/.plan-ledger.json"), "utf8")).toBe('[{"id":"1"}]');
  } finally { await restored.close(); }
});

it("rejects corrupt objects instead of falling back to an empty local workspace", async () => {
  const store = new Store(), original = new PrivateWorkspace(store, "sid", "space");
  await original.acquire(); await original.checkpoint(new Map([["files/report.txt", Buffer.from("original")]])); await original.close();
  store.objects.get(store.binding.manifest!.id)!.data = Buffer.from("corrupt");
  const restored = new PrivateWorkspace(store, "sid", "space");
  try { await expect(restored.restore({ files: path.join(dir(), "files") })).rejects.toThrow(/integrity/); }
  finally { await restored.close(); }
});

it("restores all roots below user-data when the application directory is read-only", async () => {
  const store = new Store(), original = new PrivateWorkspace(store, "sid", "space");
  await original.acquire();
  await original.checkpoint(new Map([
    ["sessions/sid/.pi-session.json", Buffer.from("session state")],
    ["reports/result.md", Buffer.from("report")],
    ["traces/trace.json", Buffer.from("trace")],
  ]));
  await original.close();
  const cwd = dir(), stateDir = path.join(cwd, ".siclaw");
  fs.mkdirSync(path.join(stateDir, "user-data"), { recursive: true });
  fs.chmodSync(stateDir, 0o555);
  fs.chmodSync(cwd, 0o555);
  const restored = new PrivateWorkspace(store, "sid", "space");
  try {
    const roots = privateWorkspaceRoots(cwd, ".siclaw/user-data");
    expect(await restored.restore(roots)).toBe(true);
    expect(fs.readFileSync(path.join(roots.reports, "result.md"), "utf8")).toBe("report");
    expect(fs.readFileSync(path.join(roots.traces, "trace.json"), "utf8")).toBe("trace");
    expect(fs.readdirSync(stateDir)).toEqual(["user-data"]);
  } finally {
    fs.chmodSync(cwd, 0o700);
    fs.chmodSync(stateDir, 0o700);
    await restored.close();
  }
});

it("rejects links and traversal and excludes derived SQLite files", () => {
  for (const p of ["../secret", "/secret", "files/../secret", "files\\secret", "files//x"]) expect(() => safeWorkspacePath(p)).toThrow();
  const root = dir(); fs.writeFileSync(path.join(root, "memory.md"), "source"); fs.writeFileSync(path.join(root, ".memory.db"), "cache");
  expect([...captureWorkspaceFiles({ memory: root }).keys()]).toEqual(["memory/memory.md"]);
  fs.symlinkSync("memory.md", path.join(root, "alias"));
  expect(() => captureWorkspaceFiles({ memory: root })).toThrow(/Links/);
});

it("keeps user databases and temporary files as user data", () => {
  const root = dir(); fs.writeFileSync(path.join(root, "data.sqlite"), "user database"); fs.writeFileSync(path.join(root, "draft.tmp"), "draft");
  expect([...captureWorkspaceFiles({ files: root }).keys()]).toEqual(["files/data.sqlite", "files/draft.tmp"]);
});

it("removes uncommitted local data when the authoritative head is empty", async () => {
  const store = new Store(), target = dir(), files = path.join(target, "files"), skills = path.join(target, "skills");
  fs.mkdirSync(files); fs.mkdirSync(skills);
  fs.writeFileSync(path.join(files, "uncommitted.txt"), "partial first turn");
  fs.writeFileSync(path.join(skills, "SKILL.md"), "trusted resource");
  const workspace = new PrivateWorkspace(store, "sid", "space");
  try {
    expect(await workspace.restore({ files })).toBe(false);
    expect(fs.readdirSync(files)).toEqual([]);
    expect(fs.readFileSync(path.join(skills, "SKILL.md"), "utf8")).toBe("trusted resource");
  } finally { await workspace.close(); }
});

it("refuses work before acquire and after close, including old tool references", async () => {
  const store = new Store(), workspace = new PrivateWorkspace(store, "sid", "space");
  await expect(workspace.validateExecution()).rejects.toThrow(/not been acquired/);
  await workspace.acquire();
  await workspace.close();
  await expect(workspace.validateExecution()).rejects.toThrow(/closed/);
  await expect(workspace.search({ queries: ["anything"] })).rejects.toThrow(/closed/);
  await expect(workspace.checkpoint(new Map())).rejects.toThrow(/closed/);
  await expect(workspace.acquire()).rejects.toThrow(/closed/);
});

it("coalesces acquisition and renewals and never renews after releasing", async () => {
  const store = new Store();
  const original = store.exchange.bind(store);
  const actions: string[] = [];
  let finishRenew!: () => void;
  const gate = new Promise<void>(resolve => { finishRenew = resolve; });
  store.exchange = async request => {
    actions.push(request.action);
    if (request.action === "renew") await gate;
    return original(request);
  };
  const workspace = new PrivateWorkspace(store, "sid", "space");
  await Promise.all([workspace.acquire(), workspace.acquire()]);
  expect(actions).toEqual(["acquire"]);
  const first = workspace.validateExecution(), second = workspace.validateExecution();
  const validations = Promise.allSettled([first, second]);
  const closing = workspace.close();
  expect(actions).toEqual(["acquire", "renew"]);
  finishRenew();
  const result = await validations;
  await closing;
  expect(result.every(r => r.status === "rejected")).toBe(true);
  expect(actions).toEqual(["acquire", "renew", "release"]);
});

it("stops execution immediately while retaining storage authority for graceful checkpoint", async () => {
  const workspace = new PrivateWorkspace(new Store(), "sid", "space");
  try {
    await workspace.acquire();
    workspace.stopExecution();
    await expect(workspace.validateExecution()).rejects.toThrow(/stopped/);
    await workspace.checkpoint(new Map([["files/final.txt", Buffer.from("last output")]]));
  } finally { await workspace.close(); }
});

it("does not publish after being fenced during a slow upload", async () => {
  const store = new Store(), workspace = new PrivateWorkspace(store, "sid", "space");
  const original = store.exchange.bind(store);
  store.exchange = async request => {
    const result = await original(request);
    if (request.action === "put") workspace.markFailed();
    return result;
  };
  try {
    await workspace.acquire();
    await expect(workspace.checkpoint(new Map([["files/a", Buffer.from("output")]]))).rejects.toThrow(/recovery/);
    expect(store.binding.revision).toBe(0);
  } finally { await workspace.close(); }
});

const outage = () => new WorkspaceTransportError(503);

it.each([undefined, {}, { ok: false }])("refuses an invalid renewal acknowledgement: %j", async response => {
  const store = new Store(), original = store.exchange.bind(store);
  store.exchange = async <T>(request: WorkspaceRequest): Promise<T> => request.action === "renew" ? response as T : original(request);
  const workspace = new PrivateWorkspace(store, "sid", "space");
  try {
    await workspace.acquire();
    await expect(workspace.validateExecution()).rejects.toThrow(/recovery/);
  } finally { await workspace.close(); }
});

it("retries transient background renewals within the original window without bypassing tool validation", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const store = new Store(), original = store.exchange.bind(store);
  let unavailable = true, renewals = 0;
  store.exchange = async request => {
    if (request.action === "renew") {
      renewals++;
      if (unavailable) { const error = outage(); error.message = "private provider response"; throw error; }
    }
    return original(request);
  };
  const workspace = new PrivateWorkspace(store, "sid", "space");
  try {
    await workspace.acquire();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renewals).toBe(2);
    expect(() => workspace.assertHealthy()).not.toThrow();
    await expect(workspace.validateExecution()).rejects.toBeInstanceOf(WorkspaceTransportError);
    expect(warn.mock.calls).toEqual([["[private-workspace] lease renewal failed; retrying within existing validity window", { remainingValidityMs: 60_000 }]]);
    // A fresh validation can recover before the unchanged 90-second deadline.
    await vi.advanceTimersByTimeAsync(15_000); unavailable = false;
    await workspace.validateExecution();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(() => workspace.assertHealthy()).not.toThrow();
    expect(info.mock.calls).toEqual([["[private-workspace] lease renewal recovered"]]);
    unavailable = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private provider response");
  } finally { await workspace.close(); }
});

it("never refreshes local validity on transient failure and fences at the original deadline", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const store = new Store(), original = store.exchange.bind(store);
  let renewals = 0;
  store.exchange = async request => {
    if (request.action === "renew") { renewals++; throw outage(); }
    return original(request);
  };
  const workspace = new PrivateWorkspace(store, "sid", "space");
  try {
    await workspace.acquire();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(renewals).toBe(2);
    await expect(workspace.validateExecution()).rejects.toThrow(/recovery/);
    await expect(workspace.acquire()).rejects.toThrow(/recovery/);
    await expect(workspace.checkpoint(new Map())).rejects.toThrow(/recovery/);
    expect(store.receipts.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]).toEqual(["[private-workspace] lease validity expired; recovery required"]);
  } finally { await workspace.close(); }
});

it.each([409, 403, 400, "legacy"] as const)("permanently fences a %s rejection even before local expiry", async status => {
  const store = new Store(), original = store.exchange.bind(store);
  store.exchange = async request => {
    if (request.action === "renew") throw status === "legacy" ? new Error("unclassified rejection")
      : new WorkspaceTransportError(status);
    return original(request);
  };
  const workspace = new PrivateWorkspace(store, "sid", "space");
  try {
    await workspace.acquire();
    await expect(workspace.validateExecution()).rejects.toThrow(/recovery/);
    store.exchange = original;
    await expect(workspace.validateExecution()).rejects.toThrow(/recovery/);
    await expect(workspace.acquire()).rejects.toThrow(/recovery/);
  } finally { await workspace.close(); }
});

it.each(["expired", "fenced"])("does not revive an %s lease after a delayed successful renewal", async reason => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const store = new Store(), original = store.exchange.bind(store);
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  store.exchange = async request => { if (request.action === "renew") await gate; return original(request); };
  const workspace = new PrivateWorkspace(store, "sid", "space");
  try {
    await workspace.acquire();
    vi.setSystemTime(89_000);
    const validation = expect(workspace.validateExecution()).rejects.toThrow(/recovery/);
    if (reason === "expired") vi.setSystemTime(91_000); else workspace.markFailed();
    finish(); await validation;
    await expect(workspace.acquire()).rejects.toThrow(/recovery/);
  } finally { finish(); await workspace.close(); }
});

it("routes structured search and independent reads without a synthetic search query", async () => {
  const store = new Store(), original = store.exchange.bind(store), requests: WorkspaceRequest[] = [];
  store.exchange = async request => { requests.push(request); return original(request); };
  const workspace = new PrivateWorkspace(store, "sid", "space");
  try {
    await workspace.acquire();
    const search = { queries: ["harbor"], scope: "harbor", cursor: "page", max_results: 2 };
    const read = { path: `memory/${"a".repeat(64)}.md`, line_offset: 2, max_lines: 3 };
    await workspace.search(search); await workspace.read(read);
    expect(requests[1]).toMatchObject({ action: "memory_search", search });
    expect(requests[2]).toMatchObject({ action: "memory_read", read });
    expect(requests[2]).not.toHaveProperty("query");
  } finally { await workspace.close(); }
});
