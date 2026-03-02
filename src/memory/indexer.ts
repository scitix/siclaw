import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { initMemoryDb } from "./schema.js";
import { chunkMarkdown } from "./chunker.js";
import { vectorToBlob, blobToVector } from "./embeddings.js";
import { tokenizeForFts } from "./stop-words.js";
import type { EmbeddingProvider, MemoryChunk, MemorySearchResult } from "./types.js";

const VECTOR_WEIGHT = 0.85;
const FTS_WEIGHT = 0.15;
const DEFAULT_MIN_SCORE = 0.35;

export class MemoryIndexer {
  private db: DatabaseSync;
  private memoryDir: string;
  private embedding: EmbeddingProvider;
  private _syncing: Promise<void> | null = null;
  private _closed = false;

  // Prepared statements (lazy)
  private _stmts?: {
    getFile: StatementSync;
    upsertFile: StatementSync;
    deleteFile: StatementSync;
    insertChunk: StatementSync;
    deleteChunks: StatementSync;
    allChunks: StatementSync;
    allFiles: StatementSync;
    getMeta: StatementSync;
    setMeta: StatementSync;
    getChunkById: StatementSync;
  };

  constructor(dbPath: string, memoryDir: string, embedding: EmbeddingProvider) {
    this.db = initMemoryDb(dbPath);
    this.memoryDir = memoryDir;
    this.embedding = embedding;
  }

  private get stmts() {
    if (!this._stmts) {
      this._stmts = {
        getFile: this.db.prepare("SELECT path, mtime_ms, hash FROM files WHERE path = ?"),
        upsertFile: this.db.prepare(
          "INSERT INTO files (path, mtime_ms, hash) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET mtime_ms=excluded.mtime_ms, hash=excluded.hash",
        ),
        deleteFile: this.db.prepare("DELETE FROM files WHERE path = ?"),
        insertChunk: this.db.prepare(
          "INSERT INTO chunks (file_path, heading, content, embedding, model) VALUES (?, ?, ?, ?, ?)",
        ),
        deleteChunks: this.db.prepare("DELETE FROM chunks WHERE file_path = ?"),
        allChunks: this.db.prepare("SELECT id, file_path, heading, content, embedding FROM chunks"),
        allFiles: this.db.prepare("SELECT path FROM files"),
        getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
        setMeta: this.db.prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ),
        getChunkById: this.db.prepare("SELECT file_path, heading, content FROM chunks WHERE id = ?"),
      };
    }
    return this._stmts;
  }

  /**
   * Sync all .md files from memoryDir into SQLite.
   * Only re-processes files whose mtime or hash changed.
   */
  async sync(): Promise<void> {
    if (this._closed) return;
    if (this._syncing) return this._syncing;
    this._syncing = this._doSync().finally(() => {
      this._syncing = null;
    });
    return this._syncing;
  }

  private async _doSync(): Promise<void> {
    // Check for embedding model change
    const currentModel = this.embedding.model;
    const storedModel = (this.stmts.getMeta.get("embedding_model") as { value: string } | undefined)?.value ?? "";
    const modelChanged = storedModel !== "" && storedModel !== currentModel;

    if (modelChanged) {
      console.log(`[memory-indexer] Embedding model changed: ${storedModel} → ${currentModel}, clearing all embeddings`);
      this.db.exec("UPDATE chunks SET embedding = NULL, model = ''");
    }

    // Record current model
    this.stmts.setMeta.run("embedding_model", currentModel);

    const mdFiles = await this.listMdFiles();
    const trackedPaths = new Set<string>();

    // Collect files that need updating
    const toUpdate: Array<{ relPath: string; absPath: string; content: string; hash: string; mtimeMs: number }> = [];

    for (const absPath of mdFiles) {
      const relPath = path.relative(this.memoryDir, absPath);
      trackedPaths.add(relPath);

      const stat = await fs.stat(absPath);
      const mtimeMs = Math.floor(stat.mtimeMs);

      const existing = this.stmts.getFile.get(relPath) as
        | { path: string; mtime_ms: number; hash: string }
        | undefined;

      if (existing && existing.mtime_ms === mtimeMs && !modelChanged) continue;

      const content = await fs.readFile(absPath, "utf-8");
      const hash = crypto.createHash("sha256").update(content).digest("hex");

      if (existing && existing.hash === hash && !modelChanged) {
        // Content unchanged, just update mtime
        this.stmts.upsertFile.run(relPath, mtimeMs, hash);
        continue;
      }

      toUpdate.push({ relPath, absPath, content, hash, mtimeMs });
    }

    // If model changed, also re-process files that weren't modified but have stale embeddings
    if (modelChanged) {
      const allTracked = this.stmts.allFiles.all() as Array<{ path: string }>;
      for (const row of allTracked) {
        if (!toUpdate.some((f) => f.relPath === row.path) && trackedPaths.has(row.path)) {
          const absPath = path.join(this.memoryDir, row.path);
          try {
            const content = await fs.readFile(absPath, "utf-8");
            const stat = await fs.stat(absPath);
            const hash = crypto.createHash("sha256").update(content).digest("hex");
            toUpdate.push({ relPath: row.path, absPath, content, hash, mtimeMs: Math.floor(stat.mtimeMs) });
          } catch {
            // File may have been deleted
          }
        }
      }
    }

    // Batch process changed files
    if (toUpdate.length > 0) {
      // Chunk all files
      const fileChunksMap = new Map<string, Array<{ heading: string; content: string }>>();
      const allChunkTexts: string[] = [];
      for (const file of toUpdate) {
        const chunks = chunkMarkdown(file.content);
        fileChunksMap.set(file.relPath, chunks);
        for (const chunk of chunks) {
          allChunkTexts.push(chunk.content);
        }
      }

      // Batch embed all chunks
      let embeddings: number[][] = [];
      if (allChunkTexts.length > 0) {
        try {
          embeddings = await this.embedding.embed(allChunkTexts);
        } catch (err) {
          console.warn(`[memory-indexer] Embedding failed, storing without vectors:`, err);
          embeddings = allChunkTexts.map(() => []);
        }
      }

      // Write to DB in a transaction
      this.db.exec("BEGIN");
      try {
        let chunkIdx = 0;
        for (const file of toUpdate) {
          this.stmts.deleteChunks.run(file.relPath);
          this.stmts.upsertFile.run(file.relPath, file.mtimeMs, file.hash);

          const chunks = fileChunksMap.get(file.relPath)!;
          for (const chunk of chunks) {
            const vec = embeddings[chunkIdx];
            const blob = vec && vec.length > 0 ? vectorToBlob(vec) : null;
            const chunkModel = blob ? currentModel : "";
            this.stmts.insertChunk.run(file.relPath, chunk.heading, chunk.content, blob, chunkModel);
            chunkIdx++;
          }
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }

      console.log(`[memory-indexer] Synced ${toUpdate.length} files, ${allChunkTexts.length} chunks`);
    }

    // Remove files that no longer exist
    const allTracked = this.stmts.allFiles.all() as Array<{ path: string }>;
    for (const row of allTracked) {
      if (!trackedPaths.has(row.path)) {
        this.stmts.deleteChunks.run(row.path);
        this.stmts.deleteFile.run(row.path);
        console.log(`[memory-indexer] Removed deleted file: ${row.path}`);
      }
    }
  }

  /**
   * Hybrid search: vector similarity (0.85) + FTS5 keyword (0.15).
   * Uses raw scores without normalization.
   */
  async search(query: string, topK = 10, minScore = DEFAULT_MIN_SCORE): Promise<MemorySearchResult> {
    const cleaned = query.trim();
    if (!cleaned) return { chunks: [], totalFiles: 0, totalChunks: 0 };

    const candidateK = Math.min(200, Math.max(1, topK * 4));

    // 1. Vector search
    let vectorResults: Array<{ id: number; score: number }> = [];
    try {
      const [queryVec] = await this.embedding.embed([cleaned]);
      if (queryVec && queryVec.length > 0 && queryVec.some((v) => v !== 0)) {
        vectorResults = this.vectorSearch(queryVec, candidateK);
      }
    } catch (err) {
      console.warn(`[memory-indexer] Vector search failed:`, err);
    }

    // 2. FTS5 search
    let ftsResults: Array<{ id: number; score: number }> = [];
    try {
      ftsResults = this.ftsSearch(cleaned, candidateK);
    } catch (err) {
      console.warn(`[memory-indexer] FTS search failed:`, err);
    }

    // 3. Fuse results using raw scores (no normalization)
    const scoreMap = new Map<number, { vectorScore: number; ftsScore: number }>();

    for (const r of vectorResults) {
      scoreMap.set(r.id, { vectorScore: r.score, ftsScore: 0 });
    }

    for (const r of ftsResults) {
      const entry = scoreMap.get(r.id) ?? { vectorScore: 0, ftsScore: 0 };
      entry.ftsScore = r.score;
      scoreMap.set(r.id, entry);
    }

    // Compute fused scores and sort
    const fused = Array.from(scoreMap.entries())
      .map(([id, { vectorScore, ftsScore }]) => ({
        id,
        score: VECTOR_WEIGHT * vectorScore + FTS_WEIGHT * ftsScore,
      }))
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // Fetch chunk details
    const chunks: MemoryChunk[] = [];
    for (const { id, score } of fused) {
      const row = this.stmts.getChunkById.get(id) as
        | { file_path: string; heading: string; content: string }
        | undefined;
      if (row) {
        chunks.push({
          file: row.file_path,
          heading: row.heading,
          content: row.content,
          score,
        });
      }
    }

    const totalFiles = (this.db.prepare("SELECT COUNT(*) AS c FROM files").get() as { c: number }).c;
    const totalChunks = (this.db.prepare("SELECT COUNT(*) AS c FROM chunks").get() as { c: number }).c;

    return { chunks, totalFiles, totalChunks };
  }

  close(): void {
    this._closed = true;
    this.db.close();
  }

  // --- Private helpers ---

  private async listMdFiles(): Promise<string[]> {
    const files: string[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        if (entry.isSymbolicLink()) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(full);
        }
      }
    };
    await walk(this.memoryDir);
    return files;
  }

  private vectorSearch(queryVec: number[], limit: number): Array<{ id: number; score: number }> {
    const rows = this.stmts.allChunks.all() as Array<{
      id: number;
      file_path: string;
      heading: string;
      content: string;
      embedding: Uint8Array | null;
    }>;

    const scored: Array<{ id: number; score: number }> = [];
    for (const row of rows) {
      if (!row.embedding) continue;
      const chunkVec = blobToVector(row.embedding);
      if (chunkVec.length !== queryVec.length) continue;
      const sim = cosineSimilarity(queryVec, chunkVec);
      if (Number.isFinite(sim)) {
        scored.push({ id: row.id, score: sim });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private ftsSearch(query: string, limit: number): Array<{ id: number; score: number }> {
    // Tokenize query: preserves underscores, generates CJK bigrams, filters stop words
    const tokens = tokenizeForFts(query);
    if (tokens.length === 0) return [];

    // Use OR for CJK-heavy queries (bigrams should match individually), AND otherwise
    const hasCjk = tokens.some((t) => /[\u4e00-\u9fff]/.test(t));
    const joiner = hasCjk ? " OR " : " AND ";
    const ftsQuery = tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(joiner);

    try {
      const rows = this.db
        .prepare(
          `SELECT rowid AS id, bm25(chunks_fts) AS rank
           FROM chunks_fts
           WHERE chunks_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as Array<{ id: number; rank: number }>;

      // BM25 rank is negative (lower is better), convert to bounded (0, 1] score
      return rows.map((r) => ({
        id: r.id,
        score: Number.isFinite(r.rank) ? 1 / (1 + Math.max(0, -r.rank)) : 0,
      }));
    } catch {
      return [];
    }
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
