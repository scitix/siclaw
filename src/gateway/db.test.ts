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
  // Ensure state is reset between tests; dynamic import used below so
  // module state is shared across tests.
  const { closeDb } = await import("./db.js");
  try { await closeDb(); } catch { /* ignore */ }
  createdPools.length = 0;
});

describe("initDb / getDb / closeDb", () => {
  it("initDb creates a pool and getDb returns it", async () => {
    const { initDb, getDb } = await import("./db.js");
    const pool = initDb("mysql://user:pw@host/db");
    expect(pool).toBeDefined();
    expect(getDb()).toBe(pool);
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
    await closeDb(); // ensure clean state in case of shared module state
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
