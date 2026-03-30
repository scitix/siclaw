/**
 * Knowledge Doc Repository — CRUD for knowledge base documents
 */

import crypto from "node:crypto";
import { eq, desc } from "drizzle-orm";
import type { Database } from "../index.js";
import { knowledgeDocs } from "../schema.js";

export class KnowledgeDocRepository {
  constructor(private db: Database) {}

  async list() {
    return this.db.select().from(knowledgeDocs).orderBy(desc(knowledgeDocs.createdAt));
  }

  async getById(id: string) {
    const rows = await this.db
      .select()
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async getByName(name: string) {
    const rows = await this.db
      .select()
      .from(knowledgeDocs)
      .where(eq(knowledgeDocs.name, name))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: {
    id?: string;
    name: string;
    filePath: string;
    content?: string;
    sizeBytes: number;
    uploadedBy?: string;
  }): Promise<string> {
    const id = data.id ?? crypto.randomBytes(12).toString("hex");
    const now = new Date();
    await this.db.insert(knowledgeDocs).values({
      id,
      name: data.name,
      filePath: data.filePath,
      content: data.content ?? null,
      sizeBytes: data.sizeBytes,
      chunkCount: 0,
      uploadedBy: data.uploadedBy ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async updateChunkCount(id: string, count: number): Promise<void> {
    await this.db
      .update(knowledgeDocs)
      .set({ chunkCount: count })
      .where(eq(knowledgeDocs.id, id));
  }

  async updateContent(id: string, content: string): Promise<void> {
    await this.db
      .update(knowledgeDocs)
      .set({ content })
      .where(eq(knowledgeDocs.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, id));
  }
}
