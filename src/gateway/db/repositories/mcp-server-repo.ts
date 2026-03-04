/**
 * MCP Server Repository — CRUD for MCP server configurations
 */

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../index.js";
import { mcpServers } from "../schema.js";

export class McpServerRepository {
  constructor(private db: Database) {}

  async list() {
    return this.db.select().from(mcpServers);
  }

  async listEnabled() {
    return this.db.select().from(mcpServers).where(eq(mcpServers.enabled, true));
  }

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getByName(name: string) {
    const rows = await this.db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.name, name))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: {
    name: string;
    transport: string;
    url?: string;
    command?: string;
    argsJson?: string[];
    envJson?: Record<string, string>;
    headersJson?: Record<string, string>;
    enabled?: boolean;
    description?: string;
    source?: string;
    createdBy?: string;
  }): Promise<string> {
    const id = crypto.randomBytes(12).toString("hex");
    await this.db.insert(mcpServers).values({
      id,
      name: data.name,
      transport: data.transport,
      url: data.url ?? null,
      command: data.command ?? null,
      argsJson: data.argsJson ?? null,
      envJson: data.envJson ?? null,
      headersJson: data.headersJson ?? null,
      enabled: data.enabled ?? true,
      description: data.description ?? null,
      source: data.source ?? "db",
      createdBy: data.createdBy ?? null,
    });
    return id;
  }

  async update(
    id: string,
    data: {
      name?: string;
      transport?: string;
      url?: string;
      command?: string;
      argsJson?: string[];
      envJson?: Record<string, string>;
      headersJson?: Record<string, string>;
      enabled?: boolean;
      description?: string;
    },
  ): Promise<void> {
    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.transport !== undefined) updates.transport = data.transport;
    if (data.url !== undefined) updates.url = data.url;
    if (data.command !== undefined) updates.command = data.command;
    if (data.argsJson !== undefined) updates.argsJson = data.argsJson;
    if (data.envJson !== undefined) updates.envJson = data.envJson;
    if (data.headersJson !== undefined) updates.headersJson = data.headersJson;
    if (data.enabled !== undefined) updates.enabled = data.enabled;
    if (data.description !== undefined) updates.description = data.description;

    if (Object.keys(updates).length === 0) return;

    await this.db
      .update(mcpServers)
      .set(updates)
      .where(eq(mcpServers.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(mcpServers).where(eq(mcpServers.id, id));
  }
}
