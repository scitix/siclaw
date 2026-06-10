import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SessionCheckpointer, type CheckpointTransport } from "./session-checkpointer.js";
import { packSessionDir } from "../shared/session-checkpoint.js";

const SESSION = "sess-1";

/** In-memory transport with the same semantics as the checkpoint.* RPC handlers. */
class FakeTransport implements CheckpointTransport {
  rows = new Map<number, { sha256: string; size_bytes: number; data_base64: string }>();
  saveCalls: number[] = [];
  loadCalls = 0;
  failNextSave = false;

  async saveSessionCheckpoint(p: { session_id: string; revision: number; sha256: string; size_bytes: number; data_base64: string }) {
    this.saveCalls.push(p.revision);
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("transport down");
    }
    const latest = this.latest();
    if (latest !== null && p.revision <= latest) {
      return { ok: false, error: "revision_conflict", latest };
    }
    this.rows.set(p.revision, { sha256: p.sha256, size_bytes: p.size_bytes, data_base64: p.data_base64 });
    return { ok: true, revision: p.revision };
  }

  async loadSessionCheckpoint(_sessionId: string, opts?: { beforeRevision?: number; metaOnly?: boolean }) {
    this.loadCalls++;
    const candidates = [...this.rows.keys()]
      .filter((r) => (opts?.beforeRevision != null ? r < opts.beforeRevision : true))
      .sort((a, b) => b - a);
    if (candidates.length === 0) return { found: false };
    const revision = candidates[0];
    const row = this.rows.get(revision)!;
    return {
      found: true,
      revision,
      sha256: row.sha256,
      size_bytes: row.size_bytes,
      ...(opts?.metaOnly ? {} : { data_base64: row.data_base64 }),
    };
  }

  latest(): number | null {
    return this.rows.size === 0 ? null : Math.max(...this.rows.keys());
  }
}

let tmpRoot: string;
let transport: FakeTransport;
let checkpointer: SessionCheckpointer;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "checkpointer-test-"));
  transport = new FakeTransport();
  checkpointer = new SessionCheckpointer(transport);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function sessionDir(name = "dir"): string {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonl(dir: string, content: string): void {
  fs.writeFileSync(path.join(dir, "session.jsonl"), content);
}

/** Seed the fake server with a checkpoint packed from real fixture content. */
async function seedServer(revision: number, content: string): Promise<void> {
  const src = sessionDir(`seed-${revision}`);
  writeJsonl(src, content);
  const packed = (await packSessionDir(src))!;
  transport.rows.set(revision, {
    sha256: packed.sha256,
    size_bytes: packed.sizeBytes,
    data_base64: packed.data.toString("base64"),
  });
}

describe("hydrate", () => {
  it("skips when the dir already has a jsonl", async () => {
    const dir = sessionDir();
    writeJsonl(dir, "live");
    expect(await checkpointer.hydrate(SESSION, dir)).toBe("skipped");
    expect(transport.loadCalls).toBe(0);
  });

  it("returns fresh when nothing is stored", async () => {
    expect(await checkpointer.hydrate(SESSION, sessionDir())).toBe("fresh");
  });

  it("restores the latest checkpoint and dedups the next no-op upload", async () => {
    await seedServer(4, `{"m":1}\n`);
    const dir = sessionDir();
    expect(await checkpointer.hydrate(SESSION, dir)).toBe("restored");
    expect(fs.readFileSync(path.join(dir, "session.jsonl"), "utf8")).toBe(`{"m":1}\n`);

    // Unchanged content → no upload at release time
    await checkpointer.checkpoint(SESSION, dir, "release");
    expect(transport.saveCalls).toEqual([]);
  });

  it("walks back past a corrupt head and saves above the head afterwards", async () => {
    await seedServer(4, `{"m":"good"}\n`);
    await seedServer(5, `{"m":"head"}\n`);
    transport.rows.get(5)!.data_base64 = Buffer.from("corrupted").toString("base64");

    const dir = sessionDir();
    expect(await checkpointer.hydrate(SESSION, dir)).toBe("restored");
    expect(fs.readFileSync(path.join(dir, "session.jsonl"), "utf8")).toBe(`{"m":"good"}\n`);

    // New content must save as rev 6 (above the corrupt head 5, not 4+1)
    writeJsonl(dir, `{"m":"new"}\n`);
    await checkpointer.checkpoint(SESSION, dir, "release");
    expect(transport.saveCalls).toEqual([6]);
    expect(transport.latest()).toBe(6);
  });

  it("degrades to fresh when no revision verifies, still saving above the head", async () => {
    await seedServer(2, "x");
    await seedServer(3, "y");
    transport.rows.get(2)!.sha256 = "0".repeat(64);
    transport.rows.get(3)!.sha256 = "0".repeat(64);

    const dir = sessionDir();
    expect(await checkpointer.hydrate(SESSION, dir)).toBe("fresh");

    writeJsonl(dir, "new");
    await checkpointer.checkpoint(SESSION, dir, "release");
    expect(transport.saveCalls).toEqual([4]);
  });

  it("degrades to fresh when the transport throws", async () => {
    transport.loadSessionCheckpoint = async () => { throw new Error("gateway down"); };
    expect(await checkpointer.hydrate(SESSION, sessionDir())).toBe("fresh");
  });
});

describe("checkpoint", () => {
  it("does nothing for an empty session dir", async () => {
    await checkpointer.checkpoint(SESSION, sessionDir(), "release");
    expect(transport.saveCalls).toEqual([]);
  });

  it("saves monotonically as content changes and dedups unchanged content", async () => {
    const dir = sessionDir();
    await checkpointer.hydrate(SESSION, dir); // fresh → counter 0

    writeJsonl(dir, "v1");
    await checkpointer.checkpoint(SESSION, dir, "release");
    writeJsonl(dir, "v2");
    await checkpointer.checkpoint(SESSION, dir, "release");
    await checkpointer.checkpoint(SESSION, dir, "release"); // unchanged

    expect(transport.saveCalls).toEqual([1, 2]);
    expect(transport.latest()).toBe(2);
  });

  it("re-syncs the revision counter via meta load when it has none", async () => {
    await seedServer(7, "old");
    const dir = sessionDir();
    writeJsonl(dir, "live-content"); // dir already live → hydrate never ran
    await checkpointer.checkpoint(SESSION, dir, "release");
    expect(transport.saveCalls).toEqual([8]);
  });

  it("recovers from a single revision conflict by re-syncing once", async () => {
    const dir = sessionDir();
    await checkpointer.hydrate(SESSION, dir); // counter 0
    await seedServer(3, "someone-else"); // server moved ahead behind our back

    writeJsonl(dir, "mine");
    await checkpointer.checkpoint(SESSION, dir, "release");
    expect(transport.saveCalls).toEqual([1, 4]); // conflict at 1, retry at latest+1
    expect(transport.latest()).toBe(4);
  });

  it("stops writing a session after repeated conflicts (split-brain)", async () => {
    const dir = sessionDir();
    await checkpointer.hydrate(SESSION, dir);

    // A competing writer that always stays ahead: force conflicts on every save.
    transport.saveSessionCheckpoint = async (p) => {
      transport.saveCalls.push(p.revision);
      return { ok: false, error: "revision_conflict", latest: p.revision + 10 };
    };

    writeJsonl(dir, "mine");
    await checkpointer.checkpoint(SESSION, dir, "release");
    expect(transport.saveCalls.length).toBe(2); // initial + one re-sync, then stop

    writeJsonl(dir, "more");
    await checkpointer.checkpoint(SESSION, dir, "release");
    expect(transport.saveCalls.length).toBe(2); // poisoned — no further writes
  });

  it("propagates transport errors so callers can log and retry next trigger", async () => {
    const dir = sessionDir();
    await checkpointer.hydrate(SESSION, dir);
    writeJsonl(dir, "v1");
    transport.failNextSave = true;
    await expect(checkpointer.checkpoint(SESSION, dir, "release")).rejects.toThrow(/transport down/);

    // Next trigger succeeds and still uses revision 1
    await checkpointer.checkpoint(SESSION, dir, "release");
    expect(transport.latest()).toBe(1);
  });

  it("forget() drops tracking so a closed session re-syncs from the server", async () => {
    const dir = sessionDir();
    await checkpointer.hydrate(SESSION, dir);
    writeJsonl(dir, "v1");
    await checkpointer.checkpoint(SESSION, dir, "release");
    checkpointer.forget(SESSION);

    writeJsonl(dir, "v2");
    await checkpointer.checkpoint(SESSION, dir, "release");
    expect(transport.latest()).toBe(2);
  });
});

describe("hydrate + checkpoint roundtrip", () => {
  it("simulates pod restart: checkpoint, wipe dir, hydrate, continue", async () => {
    const dir = sessionDir();
    await checkpointer.hydrate(SESSION, dir);
    writeJsonl(dir, `{"turn":1}\n`);
    fs.writeFileSync(path.join(dir, ".plan-ledger.json"), `{"tasks":["a"]}`);
    await checkpointer.checkpoint(SESSION, dir, "release");

    // Pod restart: emptyDir wiped, new process
    fs.rmSync(dir, { recursive: true, force: true });
    const fresh = new SessionCheckpointer(transport);
    const newDir = sessionDir("after-restart");
    expect(await fresh.hydrate(SESSION, newDir)).toBe("restored");
    expect(fs.readFileSync(path.join(newDir, "session.jsonl"), "utf8")).toBe(`{"turn":1}\n`);
    expect(fs.readFileSync(path.join(newDir, ".plan-ledger.json"), "utf8")).toBe(`{"tasks":["a"]}`);

    // Conversation continues; next checkpoint builds on the restored revision
    fs.appendFileSync(path.join(newDir, "session.jsonl"), `{"turn":2}\n`);
    await fresh.checkpoint(SESSION, newDir, "release");
    expect(transport.latest()).toBe(2);
    const head = await transport.loadSessionCheckpoint(SESSION);
    expect(crypto.createHash("sha256").update(Buffer.from(head.data_base64!, "base64")).digest("hex"))
      .toBe(head.sha256);
  });
});
