/**
 * MySQL driver — thin wrapper around mysql2/promise to conform to the Db interface.
 */

import mysql from "mysql2/promise";
import type { Db, Conn } from "./db.js";

export class MysqlDb implements Db {
  readonly driver = "mysql" as const;
  private readonly pool: mysql.Pool;

  constructor(databaseUrl: string) {
    this.pool = mysql.createPool({
      uri: databaseUrl,
      waitForConnections: true,
      connectionLimit: 10,
      idleTimeout: 60_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 30_000,
    });
  }

  async query<T = any>(sql: string, params: any[] = []): Promise<[T, unknown]> {
    const [result, fields] = await this.pool.query(sql, params);
    return [result as T, fields];
  }

  async execute(sql: string, params: any[] = []): Promise<{ affectedRows: number; insertId?: string | number }> {
    const [result] = await this.pool.query(sql, params);
    const r = result as { affectedRows?: number; insertId?: number | string };
    return { affectedRows: r.affectedRows ?? 0, insertId: r.insertId };
  }

  async getConnection(): Promise<Conn> {
    const conn = await this.pool.getConnection();
    return new MysqlConn(conn);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class MysqlConn implements Conn {
  constructor(private readonly conn: mysql.PoolConnection) {}

  async query<T = any>(sql: string, params: any[] = []): Promise<[T, unknown]> {
    const [result, fields] = await this.conn.query(sql, params);
    return [result as T, fields];
  }

  async beginTransaction(): Promise<void> {
    await this.conn.beginTransaction();
  }

  async commit(): Promise<void> {
    await this.conn.commit();
  }

  async rollback(): Promise<void> {
    await this.conn.rollback();
  }

  release(): void {
    this.conn.release();
  }
}
