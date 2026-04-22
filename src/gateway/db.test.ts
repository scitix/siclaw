import { describe, it, expect, afterEach, vi } from "vitest";

// Mock mysql2/promise before importing db.ts so createPool returns a fake
// pool without attempting any network connection.

interface FakePool {
  _opts: unknown;
  end: () => Promise<void>;
  _ended: boolean;
}

const createdPools: FakePool[] = [];

vi.mock("mysql2/promise", () => {
  return {
    default: {
      createPool: (opts: unknown) => {
        const pool: FakePool = {
          _opts: opts,
          _ended: false,
          end: async () => { pool._ended = true; },
        };
        createdPools.push(pool);
        return pool;
      },
    },
  };
});

afterEach(async () => {
  const { closeDb } = await import("./db.js");
  try { await closeDb(); } catch { /* ignore */ }
  createdPools.length = 0;
});

describe("initDb / getDb / closeDb (MySQL)", () => {
  it("initDb creates a pool and getDb returns it", async () => {
    const { initDb, getDb } = await import("./db.js");
    const db = initDb("mysql://user:pw@host/db");
    expect(db.driver).toBe("mysql");
    expect(getDb()).toBe(db);
  });

  it("initDb passes uri plus keepalive/pool options to mysql.createPool", async () => {
    const { initDb } = await import("./db.js");
    initDb("mysql://u:p@h/d");
    expect(createdPools).toHaveLength(1);
    const opts = createdPools[0]._opts as Record<string, unknown>;
    expect(opts.uri).toBe("mysql://u:p@h/d");
    expect(opts.enableKeepAlive).toBe(true);
    expect(opts.waitForConnections).toBe(true);
    expect(opts.connectionLimit).toBe(10);
    expect(opts.idleTimeout).toBe(60_000);
    expect(opts.keepAliveInitialDelay).toBe(30_000);
  });

  it("getDb throws before initDb is called", async () => {
    const { getDb, closeDb } = await import("./db.js");
    await closeDb();
    expect(() => getDb()).toThrow(/not initialized/);
  });

  it("closeDb ends the pool and clears the module-level ref", async () => {
    const { initDb, closeDb, getDb } = await import("./db.js");
    initDb("mysql://x/y");
    await closeDb();
    expect(createdPools[0]._ended).toBe(true);
    expect(() => getDb()).toThrow(/not initialized/);
  });

  it("closeDb is a no-op when no pool exists", async () => {
    const { closeDb } = await import("./db.js");
    await expect(closeDb()).resolves.toBeUndefined();
  });
});

describe("SQLite driver (:memory:)", () => {
  it("initDb routes sqlite::memory: to SqliteDb", async () => {
    const { initDb } = await import("./db.js");
    const db = initDb("sqlite::memory:");
    expect(db.driver).toBe("sqlite");
  });

  it("executes DDL, INSERT, SELECT, UPDATE, DELETE and returns mysql2-shaped results", async () => {
    const { initDb } = await import("./db.js");
    const db = initDb("sqlite::memory:");

    await db.query(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
    );

    const [insertResult] = await db.query<{ affectedRows: number; insertId?: number }>(
      "INSERT INTO t (name) VALUES (?)",
      ["alice"],
    );
    expect(insertResult.affectedRows).toBe(1);
    expect(insertResult.insertId).toBeGreaterThan(0);

    const [rows] = await db.query<Array<{ id: number; name: string }>>(
      "SELECT id, name FROM t WHERE name = ?",
      ["alice"],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("alice");

    const [updateResult] = await db.query<{ affectedRows: number }>(
      "UPDATE t SET name = ? WHERE id = ?",
      ["bob", rows[0].id],
    );
    expect(updateResult.affectedRows).toBe(1);

    const [deleteResult] = await db.query<{ affectedRows: number }>(
      "DELETE FROM t WHERE id = ?",
      [rows[0].id],
    );
    expect(deleteResult.affectedRows).toBe(1);
  });

  it("preprocessSql strips CURRENT_TIMESTAMP(3) and NOW(3) defensively", async () => {
    const { initDb } = await import("./db.js");
    const db = initDb("sqlite::memory:");
    await db.query("CREATE TABLE t (id INTEGER PRIMARY KEY, ts TIMESTAMP)");
    // These would fail on raw node:sqlite without preprocessing.
    await db.query("INSERT INTO t (ts) VALUES (CURRENT_TIMESTAMP(3))");
    await db.query("INSERT INTO t (ts) VALUES (NOW(3))");
    const [rows] = await db.query<Array<{ c: number }>>("SELECT COUNT(*) AS c FROM t");
    expect(Number(rows[0].c)).toBe(2);
  });

  it("undefined params are normalised to NULL (mysql2 compat)", async () => {
    const { initDb } = await import("./db.js");
    const db = initDb("sqlite::memory:");
    await db.query("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    await db.query("INSERT INTO t (val) VALUES (?)", [undefined]);
    const [rows] = await db.query<Array<{ val: string | null }>>("SELECT val FROM t");
    expect(rows[0].val).toBeNull();
  });

  it("Date params are converted to ISO strings", async () => {
    const { initDb } = await import("./db.js");
    const db = initDb("sqlite::memory:");
    await db.query("CREATE TABLE t (id INTEGER PRIMARY KEY, ts TIMESTAMP)");
    const now = new Date("2026-04-22T12:34:56.000Z");
    await db.query("INSERT INTO t (ts) VALUES (?)", [now]);
    const [rows] = await db.query<Array<{ ts: string }>>("SELECT ts FROM t");
    // Date → dialect-neutral SQL timestamp (MySQL-compatible, no trailing Z)
    expect(rows[0].ts).toBe("2026-04-22 12:34:56.000");
  });

  it("boolean params are converted to 0/1", async () => {
    const { initDb } = await import("./db.js");
    const db = initDb("sqlite::memory:");
    await db.query("CREATE TABLE t (id INTEGER PRIMARY KEY, flag INT)");
    await db.query("INSERT INTO t (flag) VALUES (?)", [true]);
    await db.query("INSERT INTO t (flag) VALUES (?)", [false]);
    const [rows] = await db.query<Array<{ flag: number }>>("SELECT flag FROM t ORDER BY id");
    expect(rows[0].flag).toBe(1);
    expect(rows[1].flag).toBe(0);
  });

  it("getConnection supports manual transaction commit", async () => {
    const { initDb } = await import("./db.js");
    const db = initDb("sqlite::memory:");
    await db.query("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("INSERT INTO t (val) VALUES (?)", ["x"]);
      await conn.query("INSERT INTO t (val) VALUES (?)", ["y"]);
      await conn.commit();
    } finally {
      conn.release();
    }

    const [rows] = await db.query<Array<{ c: number }>>("SELECT COUNT(*) AS c FROM t");
    expect(Number(rows[0].c)).toBe(2);
  });

  it("getConnection supports transaction rollback", async () => {
    const { initDb } = await import("./db.js");
    const db = initDb("sqlite::memory:");
    await db.query("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("INSERT INTO t (val) VALUES (?)", ["x"]);
      await conn.rollback();
    } finally {
      conn.release();
    }

    const [rows] = await db.query<Array<{ c: number }>>("SELECT COUNT(*) AS c FROM t");
    expect(Number(rows[0].c)).toBe(0);
  });

  it("getConnection mutex serialises concurrent transactions", async () => {
    const { initDb } = await import("./db.js");
    const db = initDb("sqlite::memory:");

    const first = await db.getConnection();
    let secondAcquired = false;
    const secondPromise = db.getConnection().then((c) => {
      secondAcquired = true;
      return c;
    });

    // Give the second acquire a tick to race.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondAcquired).toBe(false);

    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    second.release();
  });

  it("URL schemes route correctly", async () => {
    const { initDb, closeDb } = await import("./db.js");
    const a = initDb("sqlite::memory:");
    expect(a.driver).toBe("sqlite");
    await closeDb();

    const b = initDb("sqlite://:memory:");
    expect(b.driver).toBe("sqlite");
    await closeDb();
  });

  it("unknown scheme throws a clear error", async () => {
    const { initDb } = await import("./db.js");
    expect(() => initDb("postgres://x/y")).toThrow(/Unsupported DATABASE_URL scheme/);
  });

  it("execute() returns {affectedRows, insertId}", async () => {
    const { initDb } = await import("./db.js");
    const db = initDb("sqlite::memory:");
    await db.query("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    const res = await db.execute("INSERT INTO t (val) VALUES (?)", ["x"]);
    expect(res.affectedRows).toBe(1);
    expect(res.insertId).toBeGreaterThan(0);
  });
});
