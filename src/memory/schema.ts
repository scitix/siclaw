import { DatabaseSync } from "node:sqlite";

export function initMemoryDb(dbPath: string): DatabaseSync {
  // allowExtension enables loading native extensions like sqlite-vec
  const db = new DatabaseSync(dbPath, { allowExtension: true } as Record<string, unknown>);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      path      TEXT PRIMARY KEY,
      mtime_ms  INTEGER NOT NULL,
      hash      TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      heading   TEXT NOT NULL DEFAULT '',
      content   TEXT NOT NULL,
      embedding BLOB,
      model     TEXT NOT NULL DEFAULT '',
      UNIQUE(file_path, heading, content)
    );

    CREATE TABLE IF NOT EXISTS embedding_cache (
      content_hash TEXT NOT NULL,
      model        TEXT NOT NULL,
      embedding    BLOB NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (content_hash, model)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content, heading,
      content='chunks',
      content_rowid='id'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content, heading) VALUES (new.id, new.content, new.heading);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, heading) VALUES ('delete', old.id, old.content, old.heading);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content, heading) VALUES ('delete', old.id, old.content, old.heading);
      INSERT INTO chunks_fts(rowid, content, heading) VALUES (new.id, new.content, new.heading);
    END;
  `);

  // Migrations
  const cols = db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "model")) {
    db.exec("ALTER TABLE chunks ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.some((c) => c.name === "start_line")) {
    db.exec("ALTER TABLE chunks ADD COLUMN start_line INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.some((c) => c.name === "end_line")) {
    db.exec("ALTER TABLE chunks ADD COLUMN end_line INTEGER NOT NULL DEFAULT 0");
  }

  return db;
}
