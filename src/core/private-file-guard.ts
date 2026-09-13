import fs from "node:fs";
import path from "node:path";

/** Reject aliases and, in the private Linux Pod, paths writable by untrusted UIDs.
 * Root and the trusted agent process own the durable projection; sandbox may
 * only read it. Application path checks alone are not a process sandbox.
 */
export function assertPrivateFileHasNoLinks(file: string): void {
  const checkOwner = process.env.SICLAW_WORKSPACE_MODE === "remote" && process.platform === "linux";
  const trustedUid = checkOwner ? process.getuid?.() : undefined;
  if (checkOwner && (!Number.isSafeInteger(trustedUid) || trustedUid! < 0)) {
    throw new Error("Private file tools require a trusted process UID");
  }
  const target = path.resolve(file);
  for (let current = target; ; current = path.dirname(current)) {
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (current === target && stat.isFile() && stat.nlink !== 1)) {
        throw new Error("Private file access through links is not permitted");
      }
      if (checkOwner && ((stat.uid !== 0 && stat.uid !== trustedUid) || (stat.mode & 0o022) !== 0)) {
        throw new Error("Private file tools require paths writable only by the trusted owner");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === path.dirname(current)) break;
  }
}
