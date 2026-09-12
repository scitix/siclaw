import fs from "node:fs";
import path from "node:path";

/** One CLI invocation owns one private snapshot root, including partial writes. */
export function createPortalSnapshotCache(cwd: string): { rootDir: string; cleanup: () => void } {
  const parent = path.resolve(cwd, ".siclaw/.portal-snapshot");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const rootDir = fs.mkdtempSync(path.join(parent, "run-"));
  return {
    rootDir,
    cleanup: () => {
      try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* best-effort on exit */ }
    },
  };
}
