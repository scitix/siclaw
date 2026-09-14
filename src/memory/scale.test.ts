import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { LocalMemoryStore } from "./local-store.js";
import { indexedMemoryTerms } from "./recall.js";

it.each([100, 1000, 10000])(
  "keeps exact entity recall available at %i records and makes broad scans explicit",
  async (size) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-scale-"));
    const store = new LocalMemoryStore(dir),
      db = new DatabaseSync(path.join(dir, "memory-v2.db"));
    try {
      db.exec("BEGIN");
      const insert = db.prepare("INSERT INTO memories VALUES (?,0,?,?)"),
        index = db.prepare("INSERT INTO recall_index VALUES (?,0,?)"),
        term = db.prepare("INSERT OR IGNORE INTO recall_terms VALUES (0,?,?)");
      const now = Date.now(),
        expiry = now + 86400_000;
      for (let i = 0; i < size; i++) {
        const id = createHash("sha256").update(String(i)).digest("hex"),
          v = {
            id,
            scope: `project${i}`,
            claim: "incident",
            summary: `Project${i} incident evidence`,
            keywords: "",
            text: `Synthetic outcome ${i}`,
            kind: "task",
            status: "uncertain",
            superseded: "",
            source: {
              id,
              role: "user",
              text: `Synthetic goal ${i}`,
              sourceSessionId: `session${i % 4}`,
              sourceEntryId: id,
              createdAt: now,
              expiresAt: expiry,
            },
          };
        const words = [...indexedMemoryTerms(v)];
        insert.run(id, expiry, JSON.stringify(v));
        index.run(id, JSON.stringify(words));
        for (const w of words) term.run(w, id);
      }
      db.exec("COMMIT");
      const samples: number[] = [];
      for (let i = 0; i < 20; i++) {
        const start = performance.now(),
          page = await store.search({
            queries: [`Project${size - 1} incident`],
          });
        samples.push(performance.now() - start);
        expect(page.matches).toHaveLength(1);
        expect(page.matches[0].scope).toBe(`project${size - 1}`);
      }
      samples.sort((a, b) => a - b);
      console.info("[memory-scale]", {
        size,
        p50Ms: samples[10],
        p95Ms: samples[18],
      });
      const broad = await store.search({ queries: ["incident"] });
      expect(broad.refine_query ?? false).toBe(size > 1000);
      if (size <= 1000) expect(broad.matches).toHaveLength(5);
    } finally {
      db.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  20000,
);
