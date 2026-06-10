/**
 * checkpoint.save / checkpoint.load RPC handlers against a real SQLite DB —
 * exercises BLOB round-tripping, monotonic revision enforcement and keep-3 GC
 * (contract: docs/design/2026-06-10-session-checkpoint-db.md §3).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { initDb, closeDb, getDb } from "../gateway/db.js";
import { runPortalMigrations } from "./migrate.js";
import { buildAdapterRpcHandlers } from "./adapter.js";

const AGENT = "11111111-1111-1111-1111-111111111111";
const SESSION = "22222222-2222-2222-2222-222222222222";

function payload(revision: number, content: string) {
  const data = Buffer.from(content, "utf8");
  return {
    agent_id: AGENT,
    session_id: SESSION,
    revision,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
    size_bytes: data.length,
    data_base64: data.toString("base64"),
  };
}

let save: (params: any, agentId: string) => Promise<any>;
let load: (params: any, agentId: string) => Promise<any>;

beforeEach(async () => {
  initDb("sqlite::memory:");
  await runPortalMigrations();
  const handlers = buildAdapterRpcHandlers();
  save = handlers.get("checkpoint.save")!;
  load = handlers.get("checkpoint.load")!;
});

afterEach(async () => {
  await closeDb();
});

describe("checkpoint.save / checkpoint.load", () => {
  it("round-trips blob bytes and metadata", async () => {
    const p = payload(1, "jsonl-bytes-\x00\x01\x02-binary-safe");
    expect(await save(p, AGENT)).toEqual({ ok: true, revision: 1 });

    const result = await load({ agent_id: AGENT, session_id: SESSION }, AGENT);
    expect(result.found).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.sha256).toBe(p.sha256);
    expect(result.size_bytes).toBe(p.size_bytes);
    expect(Buffer.from(result.data_base64, "base64").toString("utf8"))
      .toBe("jsonl-bytes-\x00\x01\x02-binary-safe");
  });

  it("returns found:false when nothing is stored", async () => {
    expect(await load({ agent_id: AGENT, session_id: SESSION }, AGENT)).toEqual({ found: false });
  });

  it("rejects non-monotonic revisions with a structured conflict", async () => {
    await save(payload(3, "v3"), AGENT);
    expect(await save(payload(3, "v3-again"), AGENT))
      .toEqual({ ok: false, error: "revision_conflict", latest: 3 });
    expect(await save(payload(2, "v2-stale"), AGENT))
      .toEqual({ ok: false, error: "revision_conflict", latest: 3 });
    // The stored blob is untouched by conflicting writes
    const result = await load({ agent_id: AGENT, session_id: SESSION }, AGENT);
    expect(Buffer.from(result.data_base64, "base64").toString("utf8")).toBe("v3");
  });

  it("keeps only the last 3 revisions", async () => {
    for (let r = 1; r <= 5; r++) await save(payload(r, `v${r}`), AGENT);
    const db = getDb();
    const [rows] = await db.query<Array<{ revision: number }>>(
      "SELECT revision FROM session_checkpoints WHERE agent_id = ? AND session_id = ? ORDER BY revision",
      [AGENT, SESSION],
    );
    expect(rows.map((r) => Number(r.revision))).toEqual([3, 4, 5]);
  });

  it("load with before_revision walks back to an older revision", async () => {
    for (let r = 1; r <= 3; r++) await save(payload(r, `v${r}`), AGENT);
    const result = await load(
      { agent_id: AGENT, session_id: SESSION, before_revision: 3 }, AGENT,
    );
    expect(result.revision).toBe(2);
    expect(Buffer.from(result.data_base64, "base64").toString("utf8")).toBe("v2");
  });

  it("load with meta_only omits the blob", async () => {
    await save(payload(1, "v1"), AGENT);
    const result = await load(
      { agent_id: AGENT, session_id: SESSION, meta_only: true }, AGENT,
    );
    expect(result.found).toBe(true);
    expect(result.revision).toBe(1);
    expect(result.data_base64).toBeUndefined();
  });

  it("rejects a save whose sha256 does not match the bytes", async () => {
    const p = payload(1, "v1");
    p.sha256 = "0".repeat(64);
    await expect(save(p, AGENT)).rejects.toThrow(/sha256 mismatch/);
  });

  it("rejects malformed saves", async () => {
    await expect(save({ agent_id: AGENT, session_id: SESSION, revision: 0, sha256: "x", data_base64: "" }, AGENT))
      .rejects.toThrow(/requires/);
  });

  it("scopes checkpoints by agent and session", async () => {
    await save(payload(1, "mine"), AGENT);
    expect(await load({ agent_id: AGENT, session_id: "other-session" }, AGENT)).toEqual({ found: false });
    expect(await load({ agent_id: "other-agent", session_id: SESSION }, AGENT)).toEqual({ found: false });
  });
});
