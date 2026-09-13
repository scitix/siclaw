import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { initMemoryDb } from "../memory/schema.js";

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

export function restoreInvestigationRows(memoryDir: string): void {
  const file = path.join(memoryDir, ".investigations.json");
  if (!fs.existsSync(file)) return;
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.format !== "siclaw-investigations-v1" || !Array.isArray(value.rows) || value.rows.length > 100_000) throw new Error("Invalid investigation snapshot");
  const db = initMemoryDb(path.join(memoryDir, ".memory.db"));
  try {
    const columns = new Set((db.prepare("PRAGMA table_info(investigations)").all() as { name: string }[]).map(c => c.name));
    db.exec("BEGIN");
    for (const row of value.rows) {
      if (!row || typeof row.id !== "string" || typeof row.question !== "string") throw new Error("Invalid investigation row");
      const names = Object.keys(row);
      if (names.some(name => !columns.has(name))) throw new Error("Unknown investigation column");
      const values = names.map(name => row[name]);
      if (values.some(v => v !== null && typeof v !== "string" && typeof v !== "number")) throw new Error("Invalid investigation value");
      db.prepare(`INSERT OR REPLACE INTO investigations (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...values as SQLInputValue[]);
    }
    db.exec("COMMIT");
  } finally { db.close(); }
}
