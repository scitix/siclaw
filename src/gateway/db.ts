/**
 * MySQL connection pool for the Siclaw Agent Runtime.
 *
 * The Runtime shares a MySQL instance with Upstream.
 * Uses `mysql2/promise` directly — no ORM needed for now.
 */

import mysql from "mysql2/promise";

let pool: mysql.Pool | null = null;

export function initDb(databaseUrl: string): mysql.Pool {
  pool = mysql.createPool({
    uri: databaseUrl,
    waitForConnections: true,
    connectionLimit: 10,
    idleTimeout: 60_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30_000,
  });
  return pool;
}

export function getDb(): mysql.Pool {
  if (!pool) throw new Error("Database not initialized");
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
