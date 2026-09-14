import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { LocalMemoryStore } from "../memory/local-store.js";

/** Local user privacy control. Bump the authority generation instead of deleting
 * an open SQLite/WAL file; all resident sessions observe the same tombstone. */
export function clearUserMemory(userId: string, userDataBase: string): void {
  if (!userId) throw new Error("Memory owner is required");
  const directory = path.join(path.resolve(userDataBase), "memory-v2", createHash("sha256").update(userId).digest("hex"));
  if (!fs.existsSync(path.join(directory, "memory-v2.db"))) return;
  const memory = new LocalMemoryStore(directory);
  try { memory.clear(); } finally { memory.close(); }
}
