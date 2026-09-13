import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Portable authoritative rows; vector/FTS caches and live WAL files stay local. */
export function exportInvestigationRows(memoryDir: string): void {
  const file = path.join(memoryDir, ".memory.db");
  if (!fs.existsSync(file)) return;
  if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error("Unsafe memory database");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='investigations'").get();
    const rows = exists ? db.prepare("SELECT * FROM investigations ORDER BY id").all() : [];
    const data = JSON.stringify({ format: "siclaw-investigations-v1", rows });
    if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error("Investigation export limit exceeded");
    fs.writeFileSync(path.join(memoryDir, ".investigations.json"), data, { mode: 0o600 });
    db.exec("COMMIT");
  } finally { db.close(); }
}
