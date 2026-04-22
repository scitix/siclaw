/**
 * Tests for MemoryIndexer.startWatching() / stopWatching() / close() lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryIndexer } from "./indexer.js";
import type { EmbeddingProvider } from "./types.js";

const noopEmbedding: EmbeddingProvider = {
  async embed(texts: string[]) {
    return texts.map(() => [0, 0, 0, 0]);
  },
  dimensions: 4,
  model: "noop",
};

describe("MemoryIndexer watching lifecycle", () => {
  let tmpDir: string;
  let memoryDir: string;
  let dbPath: string;
  let indexer: MemoryIndexer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-indexer-watch-"));
    memoryDir = path.join(tmpDir, "memory");
    dbPath = path.join(tmpDir, "memory.db");
    fs.mkdirSync(memoryDir, { recursive: true });
    indexer = new MemoryIndexer(dbPath, memoryDir, noopEmbedding);
  });

  afterEach(() => {
    try {
      indexer.close();
    } catch {
      // already closed
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("startWatching is idempotent — calling twice keeps a single watcher", () => {
    indexer.startWatching();
    const first = (indexer as any)._watcher;
    indexer.startWatching();
    const second = (indexer as any)._watcher;
    expect(first).toBe(second); // same instance
    expect(first).not.toBeNull();
  });

  it("stopWatching clears watcher and debounce", () => {
    indexer.startWatching();
    expect((indexer as any)._watcher).not.toBeNull();
    indexer.stopWatching();
    expect((indexer as any)._watcher).toBeNull();
    expect((indexer as any)._watchDebounce).toBeNull();
  });

  it("stopWatching is safe to call when not watching", () => {
    expect(() => indexer.stopWatching()).not.toThrow();
  });

  it("close() stops the watcher and closes the db", () => {
    indexer.startWatching();
    indexer.close();
    expect((indexer as any)._closed).toBe(true);
    expect((indexer as any)._watcher).toBeNull();
  });

  it("startWatching is a no-op after close()", () => {
    indexer.close();
    indexer.startWatching();
    expect((indexer as any)._watcher).toBeNull();
  });

  it("startWatching tolerates watcher errors (e.g. missing dir) without throwing", () => {
    // Close the existing indexer and open one with a non-existent memoryDir
    indexer.close();
    const missing = path.join(tmpDir, "not-there");
    const i2 = new MemoryIndexer(":memory:", missing, noopEmbedding);
    try {
      expect(() => i2.startWatching()).not.toThrow();
    } finally {
      i2.close();
    }
  });
});
