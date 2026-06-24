import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { initDb, closeDb, getDb } from "../gateway/db.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { runPortalMigrations } from "./migrate.js";
import { registerA2aRoutes, __resetA2aGatewayState } from "./a2a-gateway.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

const API_KEY = "sk-a2a-test-key";

function keyHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fakeReq(opts: { url: string; method: string; headers?: Record<string, string>; body?: unknown }): any {
  const em = new EventEmitter() as any;
  em.url = opts.url;
  em.method = opts.method;
  em.headers = { host: "siclaw.test", ...(opts.headers ?? {}) };
  em.socket = { setNoDelay: vi.fn() };
  const originalOn = em.on.bind(em);
  em.on = (ev: string, listener: any) => {
    originalOn(ev, listener);
    if (ev === "data" && !em._emitted) {
      em._emitted = true;
      setImmediate(() => {
        if (opts.body !== undefined) em.emit("data", Buffer.from(JSON.stringify(opts.body)));
        em.emit("end");
      });
    }
    return em;
  };
  return em;
}

function fakeRes() {
  const r: any = new EventEmitter();
  r._status = 0;
  r._headers = {};
  r._body = "";
  r._chunks = [] as string[];
  r.headersSent = false;
  r.writableEnded = false;
  r.destroyed = false;
  r.socket = { setNoDelay: vi.fn() };
  r.writeHead = vi.fn((status: number, headers?: Record<string, string>) => {
    r._status = status;
    r._headers = headers ?? {};
    r.headersSent = true;
    return r;
  });
  r.write = vi.fn((chunk: string) => {
    r._chunks.push(chunk);
    return true;
  });
  r.end = vi.fn((body?: string) => {
    if (body) r._body += body;
    r.writableEnded = true;
    r.emit("finish");
    return r;
  });
  return r;
}

function parseJsonBody(res: any): any {
  return res._body ? JSON.parse(res._body) : null;
}

function parseSseDataChunks(res: any): any[] {
  return res._chunks
    .flatMap((chunk: string) => chunk.split("\n\n"))
    .filter((frame: string) => frame.startsWith("data: "))
    .map((frame: string) => JSON.parse(frame.slice("data: ".length)));
}

function runRoute(router: ReturnType<typeof createRestRouter>, req: any, res = fakeRes()): Promise<any> {
  return new Promise((resolve, reject) => {
    res.on("finish", () => resolve(res));
    const origEnd = res.end;
    res.end = (body?: string) => {
      origEnd.call(res, body);
      resolve(res);
      return res;
    };
    try { if (!router.handle(req, res)) reject(new Error("no route")); } catch (err) { reject(err); }
  });
}

function makeConnMap() {
  const handlers = new Set<(data: unknown) => void>();
  const map: RuntimeConnectionMap = {
    register: vi.fn(),
    unregister: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    sendCommand: vi.fn(async (_agentId: string, method: string, params: any) => {
      if (method === "chat.sessionStatus") return { ok: true, payload: { running: false } };
      if (method === "chat.send") return { ok: true, payload: { sessionId: params.sessionId } };
      if (method === "chat.abort") return { ok: true, payload: { ok: true } };
      return { ok: false, error: `unexpected method ${method}` };
    }),
    notify: vi.fn(),
    notifyMany: vi.fn(),
    subscribe: vi.fn((_agentId: string, channel: string, handler: (data: unknown) => void) => {
      expect(channel).toBe("chat.event");
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    connectedAgentIds: vi.fn().mockReturnValue(["runtime"]),
  };
  return {
    map,
    emit(data: unknown) {
      for (const handler of handlers) handler(data);
    },
  };
}

async function seedPortal(): Promise<void> {
  const db = getDb();
  await db.query("INSERT INTO siclaw_users (id, username, password_hash, role) VALUES (?, ?, ?, ?)", ["u1", "alice", "x", "user"]);
  await db.query(
    "INSERT INTO agents (id, name, model_provider, model_id, created_by) VALUES (?, ?, ?, ?, ?)",
    ["a1", "SRE", "openai", "gpt-4.1", "u1"],
  );
  await db.query(
    "INSERT INTO agents (id, name, model_provider, model_id, created_by) VALUES (?, ?, ?, ?, ?)",
    ["a2", "Other", "openai", "gpt-4.1", "u1"],
  );
  await db.query(
    "INSERT INTO model_providers (id, name, base_url, api_key, api_type) VALUES (?, ?, ?, ?, ?)",
    ["p1", "openai", "https://api.openai.com/v1", "sk-provider", "openai-completions"],
  );
  await db.query(
    "INSERT INTO model_entries (id, provider_id, model_id, name, reasoning, context_window, max_tokens) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["m1", "p1", "gpt-4.1", "GPT-4.1", 0, 128000, 4096],
  );
  await db.query(
    "INSERT INTO agent_api_keys (id, agent_id, name, key_hash, key_plain, key_prefix, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["k1", "a1", "a2a", keyHash(API_KEY), API_KEY, "sk-a2a-te", "u1"],
  );
}

async function makeRouter() {
  initDb("sqlite::memory:");
  await runPortalMigrations();
  await seedPortal();
  const router = createRestRouter();
  const conn = makeConnMap();
  registerA2aRoutes(router, conn.map);
  return { router, conn };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A2A trackers/subscribers/orphan timers are module-level; clear them so tasks created in
  // one test never leak in-memory state (e.g. a live tracker) into the next.
  __resetA2aGatewayState();
});

afterEach(async () => {
  __resetA2aGatewayState();
  await closeDb();
});

describe("registerA2aRoutes", () => {
  it("serves an Agent Card for a Siclaw agent", async () => {
    const { router } = await makeRouter();
    const res = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/.well-known/agent-card.json",
      method: "GET",
    }));

    expect(res._status).toBe(200);
    expect(res._headers["A2A-Version"]).toBe("1.0");
    const body = parseJsonBody(res);
    expect(body.name).toBe("Siclaw SRE Agent");
    expect(body.capabilities.streaming).toBe(true);
    expect(body.supportedInterfaces[0].url).toBe("http://siclaw.test/api/v1/a2a/agents/a1");
  });

  it("rejects an API key for a different agent", async () => {
    const { router } = await makeRouter();
    const res = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a2/message:send",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", parts: [{ text: "hi" }] } },
    }));

    expect(res._status).toBe(403);
    expect(res._headers["Content-Type"]).toContain("application/a2a+json");
    const error = parseJsonBody(res).error;
    expect(error.code).toBe(403);
    expect(error.status).toBe("PERMISSION_DENIED");
    expect(error.details[0].reason).toBe("FORBIDDEN");
  });

  it("creates an A2A task and dispatches chat.send", async () => {
    const { router, conn } = await makeRouter();
    const res = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/message:send",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", contextId: "ctx-1", parts: [{ text: "diagnose kube-system" }] } },
    }));

    expect(res._status).toBe(200);
    const body = parseJsonBody(res);
    expect(body.task.contextId).toBe("ctx-1");
    expect(body.task.status.state).toBe("TASK_STATE_WORKING");
    expect(conn.map.sendCommand).toHaveBeenCalledWith("a1", "chat.send", expect.objectContaining({
      agentId: "a1",
      userId: "u1",
      text: "diagnose kube-system",
      sessionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      mode: "a2a",
      origin: "a2a", // audit category
    }));

    const [rows] = await getDb().query<Array<{ state: string; context_id: string; session_id: string }>>(
      "SELECT state, context_id, session_id FROM a2a_tasks WHERE id = ?",
      [body.task.id],
    );
    expect(rows[0]).toMatchObject({ state: "TASK_STATE_WORKING", context_id: "ctx-1" });
    expect(rows[0].session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("maps a non-UUID A2A context to a stable internal Siclaw session", async () => {
    const { router, conn } = await makeRouter();
    const first = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/message:send",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", contextId: "external-context", parts: [{ text: "first" }] } },
    }));
    const second = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/message:send",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", contextId: "external-context", parts: [{ text: "second" }] } },
    }));

    expect(first._status).toBe(200);
    expect(second._status).toBe(200);
    const sendCalls = (conn.map.sendCommand as any).mock.calls.filter((call: any[]) => call[1] === "chat.send");
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0][2].sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sendCalls[1][2].sessionId).toBe(sendCalls[0][2].sessionId);
    expect(parseJsonBody(second).task.contextId).toBe("external-context");
  });

  it("rejects oversized A2A context identifiers before dispatching", async () => {
    const { router, conn } = await makeRouter();
    const res = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/message:send",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", contextId: "x".repeat(256), parts: [{ text: "too long" }] } },
    }));

    expect(res._status).toBe(400);
    expect(parseJsonBody(res).error.details[0].reason).toBe("INVALID_ARGUMENT");
    expect(conn.map.sendCommand).not.toHaveBeenCalledWith("a1", "chat.send", expect.anything());
  });

  it("returns RESOURCE_EXHAUSTED for bodies over the A2A size limit", async () => {
    const { router, conn } = await makeRouter();
    const res = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/message:send",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", parts: [{ text: "x".repeat(1024 * 1024) }] } },
    }));

    expect(res._status).toBe(413);
    const error = parseJsonBody(res).error;
    expect(error.status).toBe("RESOURCE_EXHAUSTED");
    expect(error.details[0].reason).toBe("RESOURCE_EXHAUSTED");
    expect(conn.map.sendCommand).not.toHaveBeenCalledWith("a1", "chat.send", expect.anything());
  });

  it("streams Siclaw text deltas and terminal status as A2A events", async () => {
    const { router, conn } = await makeRouter();
    const res = fakeRes();
    router.handle(fakeReq({
      url: "/api/v1/a2a/agents/a1/message:stream",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", parts: [{ text: "stream it" }] } },
    }), res);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const sent = (conn.map.sendCommand as any).mock.calls.find((call: any[]) => call[1] === "chat.send");
    const sessionId = sent[2].sessionId;
    conn.emit({ sessionId, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } } });
    conn.emit({ sessionId, event: { type: "prompt_done" } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const frames = parseSseDataChunks(res);
    expect(frames.some((f) => f.task?.status?.state === "TASK_STATE_WORKING")).toBe(true);
    expect(frames.some((f) => f.artifactUpdate?.artifact?.parts?.[0]?.text === "hello")).toBe(true);
    expect(frames.some((f) => f.statusUpdate?.status?.state === "TASK_STATE_COMPLETED")).toBe(true);
    expect(res.writableEnded).toBe(true);
  });

  it("lists A2A tasks with context and status filters", async () => {
    const { router } = await makeRouter();
    const createRes = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/message:send",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", contextId: "ctx-list", parts: [{ text: "list me" }] } },
    }));
    const created = parseJsonBody(createRes).task;

    const listRes = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/tasks?contextId=ctx-list&status=TASK_STATE_WORKING&pageSize=10",
      method: "GET",
      headers: { authorization: `Bearer ${API_KEY}` },
    }));

    expect(listRes._status).toBe(200);
    const body = parseJsonBody(listRes);
    expect(body.totalSize).toBe(1);
    expect(body.tasks[0].id).toBe(created.id);
    expect(body.tasks[0].contextId).toBe("ctx-list");
  });

  it("rejects subscribe after a task reaches a terminal state", async () => {
    const { router, conn } = await makeRouter();
    const createRes = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/message:send",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", parts: [{ text: "finish quickly" }] } },
    }));
    const taskId = parseJsonBody(createRes).task.id;
    const sent = (conn.map.sendCommand as any).mock.calls.find((call: any[]) => call[1] === "chat.send");
    conn.emit({ sessionId: sent[2].sessionId, event: { type: "prompt_done" } });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const subscribeRes = await runRoute(router, fakeReq({
      url: `/api/v1/a2a/agents/a1/tasks/${taskId}:subscribe`,
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: {},
    }));

    expect(subscribeRes._status).toBe(400);
    expect(parseJsonBody(subscribeRes).error.details[0].reason).toBe("UNSUPPORTED_OPERATION");
  });

  it("cancels a running A2A task via chat.abort", async () => {
    const { router, conn } = await makeRouter();
    const createRes = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/message:send",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", parts: [{ text: "long check" }] } },
    }));
    const taskId = parseJsonBody(createRes).task.id;

    const cancelRes = await runRoute(router, fakeReq({
      url: `/api/v1/a2a/agents/a1/tasks/${taskId}:cancel`,
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: {},
    }));

    expect(cancelRes._status).toBe(200);
    expect(parseJsonBody(cancelRes).task.status.state).toBe("TASK_STATE_CANCELED");
    expect(conn.map.sendCommand).toHaveBeenCalledWith("a1", "chat.abort", expect.objectContaining({
      agentId: "a1",
      userId: "u1",
    }));
  });

  it("keeps a freshly disconnected task WORKING within the grace window", async () => {
    const { router, conn } = await makeRouter();
    const createRes = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/message:send",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", parts: [{ text: "transient blip" }] } },
    }));
    const taskId = parseJsonBody(createRes).task.id;

    // Runtime momentarily unreachable (phone-home blip). Inside the grace window the task
    // must NOT be failed — chat.sessionStatus fails safe to running:false, so disconnect
    // alone is not proof the turn is dead.
    (conn.map.isConnected as any).mockReturnValue(false);
    const getRes = await runRoute(router, fakeReq({
      url: `/api/v1/a2a/agents/a1/tasks/${taskId}`,
      method: "GET",
      headers: { authorization: `Bearer ${API_KEY}` },
    }));

    expect(getRes._status).toBe(200);
    expect(parseJsonBody(getRes).task.status.state).toBe("TASK_STATE_WORKING");
  });

  it("fails an orphaned task once the runtime stays disconnected past the grace window", async () => {
    const prev = process.env.SICLAW_A2A_ORPHAN_GRACE_MS;
    process.env.SICLAW_A2A_ORPHAN_GRACE_MS = "0";
    try {
      const { router, conn } = await makeRouter();
      const createRes = await runRoute(router, fakeReq({
        url: "/api/v1/a2a/agents/a1/message:send",
        method: "POST",
        headers: { authorization: `Bearer ${API_KEY}` },
        body: { message: { role: "ROLE_USER", parts: [{ text: "orphan me" }] } },
      }));
      const taskId = parseJsonBody(createRes).task.id;

      (conn.map.isConnected as any).mockReturnValue(false);
      const getRes = await runRoute(router, fakeReq({
        url: `/api/v1/a2a/agents/a1/tasks/${taskId}`,
        method: "GET",
        headers: { authorization: `Bearer ${API_KEY}` },
      }));

      expect(getRes._status).toBe(200);
      expect(parseJsonBody(getRes).task.status.state).toBe("TASK_STATE_FAILED");
      const [rows] = await getDb().query<Array<{ state: string }>>(
        "SELECT state FROM a2a_tasks WHERE id = ?",
        [taskId],
      );
      expect(rows[0].state).toBe("TASK_STATE_FAILED");
    } finally {
      if (prev === undefined) delete process.env.SICLAW_A2A_ORPHAN_GRACE_MS;
      else process.env.SICLAW_A2A_ORPHAN_GRACE_MS = prev;
    }
  });

  it("fails a task orphaned by a Portal restart even while the runtime stays connected", async () => {
    const prev = process.env.SICLAW_A2A_ORPHAN_GRACE_MS;
    process.env.SICLAW_A2A_ORPHAN_GRACE_MS = "0";
    try {
      const { router, conn } = await makeRouter();
      const createRes = await runRoute(router, fakeReq({
        url: "/api/v1/a2a/agents/a1/message:send",
        method: "POST",
        headers: { authorization: `Bearer ${API_KEY}` },
        body: { message: { role: "ROLE_USER", parts: [{ text: "survive a restart" }] } },
      }));
      const taskId = parseJsonBody(createRes).task.id;

      // Simulate a Portal restart: the in-memory tracker driving the task is gone, but the
      // a2a_tasks row is still WORKING. The Runtime is reconnected (isConnected stays true)
      // and reports the session not running (default sessionStatus mock). Without the
      // no-tracker reconciliation this task would be stuck WORKING forever.
      __resetA2aGatewayState();

      const getRes = await runRoute(router, fakeReq({
        url: `/api/v1/a2a/agents/a1/tasks/${taskId}`,
        method: "GET",
        headers: { authorization: `Bearer ${API_KEY}` },
      }));

      expect(conn.map.isConnected).toHaveReturnedWith(true);
      expect(getRes._status).toBe(200);
      expect(parseJsonBody(getRes).task.status.state).toBe("TASK_STATE_FAILED");
    } finally {
      if (prev === undefined) delete process.env.SICLAW_A2A_ORPHAN_GRACE_MS;
      else process.env.SICLAW_A2A_ORPHAN_GRACE_MS = prev;
    }
  });

  it("sends the initial task snapshot before live deltas even when the snapshot is slow", async () => {
    const { router, conn } = await makeRouter();

    // Gate the snapshot's chat.sessionStatus round-trip so a delta can arrive while the
    // initial Task frame is still being produced.
    let releaseStatus: () => void = () => {};
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    (conn.map.sendCommand as any).mockImplementation(async (_agentId: string, method: string, params: any) => {
      if (method === "chat.send") return { ok: true, payload: { sessionId: params.sessionId } };
      if (method === "chat.sessionStatus") { await statusGate; return { ok: true, payload: { running: true } }; }
      if (method === "chat.abort") return { ok: true, payload: { ok: true } };
      return { ok: false, error: `unexpected method ${method}` };
    });

    const res = fakeRes();
    router.handle(fakeReq({
      url: "/api/v1/a2a/agents/a1/message:stream",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", parts: [{ text: "stream it" }] } },
    }), res);

    // Let the handler reach streamTask (subscription is registered, snapshot is gated).
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const sent = (conn.map.sendCommand as any).mock.calls.find((call: any[]) => call[1] === "chat.send");
    const sessionId = sent[2].sessionId;

    // Delta arrives before the snapshot is released — it must be buffered, not raced ahead.
    conn.emit({ sessionId, event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "early" } } });
    await new Promise((r) => setImmediate(r));
    releaseStatus();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

    const frames = parseSseDataChunks(res);
    const taskIdx = frames.findIndex((f) => f.task);
    const artIdx = frames.findIndex((f) => f.artifactUpdate?.artifact?.parts?.[0]?.text === "early");
    expect(taskIdx).toBe(0);
    expect(artIdx).toBeGreaterThan(taskIdx);
  });

  it("terminal state is immutable: a cancel cannot overwrite an already-failed task", async () => {
    const { router, conn } = await makeRouter();
    // Gate chat.abort so the cancel parks mid-abort while a runtime stream_error commits first.
    let releaseAbort: () => void = () => {};
    const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
    (conn.map.sendCommand as any).mockImplementation(async (_a: string, method: string, params: any) => {
      if (method === "chat.send") return { ok: true, payload: { sessionId: params.sessionId } };
      if (method === "chat.abort") { await abortGate; return { ok: true, payload: { ok: true } }; }
      if (method === "chat.sessionStatus") return { ok: true, payload: { running: false } };
      return { ok: false, error: `unexpected ${method}` };
    });

    const createRes = await runRoute(router, fakeReq({
      url: "/api/v1/a2a/agents/a1/message:send",
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: { message: { role: "ROLE_USER", parts: [{ text: "cancel vs error" }] } },
    }));
    const taskId = parseJsonBody(createRes).task.id;
    const sessionId = (conn.map.sendCommand as any).mock.calls.find((c: any[]) => c[1] === "chat.send")[2].sessionId;

    // Start the cancel; it loads the WORKING task, then parks on the gated chat.abort.
    const cancelP = runRoute(router, fakeReq({
      url: `/api/v1/a2a/agents/a1/tasks/${taskId}:cancel`,
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
      body: {},
    }));
    for (let i = 0; i < 50; i++) {
      if ((conn.map.sendCommand as any).mock.calls.some((c: any[]) => c[1] === "chat.abort")) break;
      await new Promise((r) => setImmediate(r));
    }

    // Runtime emits stream_error while the cancel is parked → the task commits FAILED first.
    conn.emit({ sessionId, event: { type: "stream_error", error: { message: "boom" } } });
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    // Let the cancel finish; its CANCELED write must NOT overwrite the committed FAILED.
    releaseAbort();
    const cancelRes = await cancelP;

    expect(parseJsonBody(cancelRes).task.status.state).toBe("TASK_STATE_FAILED");
    const [rows] = await getDb().query<Array<{ state: string }>>("SELECT state FROM a2a_tasks WHERE id = ?", [taskId]);
    expect(rows[0].state).toBe("TASK_STATE_FAILED");
  });
});
