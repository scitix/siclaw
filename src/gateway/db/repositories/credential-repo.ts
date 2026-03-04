/**
 * Credential Repository — CRUD for per-user credentials
 */

import crypto from "node:crypto";
import { eq, and, inArray } from "drizzle-orm";
import type { Database } from "../index.js";
import { credentials } from "../schema.js";

export class CredentialRepository {
  constructor(private db: Database) {}

  async listForUser(userId: string, type?: string) {
    const conditions = [eq(credentials.userId, userId)];
    if (type) conditions.push(eq(credentials.type, type));

    return this.db
      .select()
      .from(credentials)
      .where(and(...conditions));
  }

  async getById(userId: string, id: string) {
    const rows = await this.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.userId, userId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: {
    userId: string;
    name: string;
    type: string;
    description?: string;
    configJson: Record<string, unknown>;
  }): Promise<string> {
    const id = crypto.randomBytes(12).toString("hex");
    await this.db.insert(credentials).values({
      id,
      userId: data.userId,
      name: data.name,
      type: data.type,
      description: data.description ?? null,
      configJson: data.configJson,
    });
    return id;
  }

  async update(
    userId: string,
    id: string,
    data: {
      name?: string;
      description?: string;
      configJson?: Record<string, unknown>;
    },
  ): Promise<void> {
    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.configJson !== undefined) updates.configJson = data.configJson;

    if (Object.keys(updates).length === 0) return;

    await this.db
      .update(credentials)
      .set(updates)
      .where(and(eq(credentials.id, id), eq(credentials.userId, userId)));
  }

  async delete(userId: string, id: string): Promise<void> {
    await this.db
      .delete(credentials)
      .where(and(eq(credentials.id, id), eq(credentials.userId, userId)));
  }

  async listByIds(userId: string, ids: string[]) {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(credentials)
      .where(and(eq(credentials.userId, userId), inArray(credentials.id, ids)));
  }
}
