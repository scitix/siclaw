import fs from "node:fs/promises";
import path from "node:path";
import { serializeToolOutputWrites } from "./tool-result-artifact.js";
import { sweepStaleTaskOutputs } from "../tools/cmd-exec/disk-output.js";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 10 * 60 * 1000;
const ID = /^tra_[0-9a-f]{32}$/;
const scopes = /^[0-9a-f]{64}$/;
const registered = new Map<string, ReturnType<typeof setInterval>>();
async function isDirectory(directory: string): Promise<boolean> {
  try { const s = await fs.lstat(directory); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}

/** Startup + periodic cleanup also finds prior-process artifacts. Never follow directory symlinks. */
export async function sweepSessionToolOutputs(base: string, now = Date.now()): Promise<void> {
  if (!await isDirectory(base)) return;
  for (const session of await fs.readdir(base, { withFileTypes: true })) {
    if (!session.isDirectory() || session.isSymbolicLink()) continue;
    const root = path.join(base, session.name, ".tool-results");
    if (!await isDirectory(root)) continue;
    await serializeToolOutputWrites(root, async () => {
      for (const scope of await fs.readdir(root, { withFileTypes: true })) {
        if (!scope.isDirectory() || scope.isSymbolicLink() || !scopes.test(scope.name)) continue;
        const directory = path.join(root, scope.name);
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (!entry.isFile() || entry.isSymbolicLink()) continue;
          const file = path.join(directory, entry.name);
          const id = entry.name.replace(/\.(json|txt)$/, "");
          if (ID.test(id) && entry.name.endsWith(".json")) {
            try {
              const meta = JSON.parse(await fs.readFile(file, "utf8"));
              const expiry = Date.parse(meta.expiresAt);
              if (!Number.isFinite(expiry) || expiry <= now) {
                await fs.rm(file, { force: true });
                await fs.rm(path.join(directory, `${id}.txt`), { force: true });
              }
            } catch { /* Keep fresh/in-flight data; old malformed/orphan files are handled below. */ }
          }
          // Crash leftovers (.tmp or orphan .txt/.json) expire by mtime.
          try {
            const stat = await fs.lstat(file);
            if (now - stat.mtimeMs > RETENTION_MS &&
                (entry.name.endsWith(".tmp") || ID.test(id))) {
              await fs.rm(file, { force: true });
            }
          } catch { /* removed above */ }
        }
        const tasks = path.join(directory, "tasks");
        if (await isDirectory(tasks)) await sweepStaleTaskOutputs(RETENTION_MS, undefined, tasks);
      }
    });
  }
}

export function scheduleToolOutputCleanup(base: string): void {
  base = path.resolve(base);
  if (registered.has(base)) return;
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try { await sweepSessionToolOutputs(base); }
    catch (error) { console.warn("[tool-output] cleanup failed:", error instanceof Error ? error.message : String(error)); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void sweep(); }, INTERVAL_MS);
  timer.unref();
  registered.set(base, timer);
  void sweep();
}
