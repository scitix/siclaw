import { describe, it, expect, beforeEach, vi } from "vitest";
import { Readable } from "node:stream";

/**
 * Tests for the delegation transport (handleDelegate) — focused on the
 * correctness/security boundaries a prior review flagged:
 *   - parentSessionId MUST be bound to the caller's mTLS identity (agent_id).
 *   - a model-level failure surfaced by consumeAgentSse.errorMessage MUST become
 *     a failed delegate_result, not a false ok:true "done".
 */

// ── Mocks (hoisted) ───────────────────────────────────────────────────

let consumeReturn: { resultText: string; taskReportText: string; errorMessage: string; eventCount: number; durationMs: number };
let consumeEvents: Array<Record<string, unknown>> = [];
const consumeAgentSse = vi.fn(async (opts: any) => {
  for (const e of consumeEvents) opts.onEvent?.(e);
  return consumeReturn;
});
vi.mock("./sse-consumer.js", () => ({ consumeAgentSse: (o: any) => consumeAgentSse(o) }));

const ensureChatSession = vi.fn(async () => {});
const appendMessage = vi.fn(async () => {});
vi.mock("./chat-repo.js", () => ({
  ensureChatSession: (...a: any[]) => ensureChatSession(...a),
  appendMessage: (...a: any[]) => appendMessage(...a),
  incrementMessageCount: vi.fn(async () => {}),
  updateMessage: vi.fn(async () => {}),
}));

vi.mock("./agent-model-binding.js", () => ({
  resolveAgentModelBinding: vi.fn(async () => ({ modelProvider: "p", modelId: "m", modelConfig: undefined, modelRouting: undefined, systemPrompt: undefined })),
}));

const promptMock = vi.fn(async () => ({ ok: true, sessionId: "peer-sess" }));
const abortSessionMock = vi.fn(async () => {});
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    constructor(_e: string, _t?: number, _tls?: unknown) {}
    prompt = promptMock;
    abortSession = abortSessionMock;
  },
}));

import { handleDelegate } from "./delegate-api.js";

// ── Fakes ─────────────────────────────────────────────────────────────

function makeReq(body: unknown): any {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]);
  return r;
}

interface FakeRes {
  statusCode?: number;
  headers?: Record<string, string>;
  frames: any[];
  jsonBody?: unknown;
  ended: boolean;
  _close?: () => void;
  triggerClose: () => void;
  writeHead: (s: number, h?: Record<string, string>) => void;
  write: (chunk: string) => boolean;
  end: (data?: string) => void;
  on: (ev: string, cb: () => void) => void;
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    frames: [],
    ended: false,
    triggerClose() { this._close?.(); },
    writeHead(s, h) { this.statusCode = s; this.headers = h; },
    write(chunk: string) {
      // SSE frames: "data: {json}\n\n"
      for (const line of chunk.split("\n")) {
        if (line.startsWith("data: ")) {
          try { this.frames.push(JSON.parse(line.slice(6))); } catch { /* ignore */ }
        }
      }
      return true;
    },
    end(data?: string) {
      if (data && this.statusCode && this.statusCode !== 200) {
        try { this.jsonBody = JSON.parse(data); } catch { this.jsonBody = data; }
      }
      this.ended = true;
    },
    on(ev: string, cb: () => void) { if (ev === "close") this._close = cb; },
  };
  return res;
}

const COORD = "coord-agent";
const PEER = "peer-agent";

function makeDeps(resolveSessionResult: unknown) {
  const request = vi.fn(async (method: string) => {
    if (method === "config.getDelegates") {
      return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
    }
    if (method === "chat.resolveSession") return resolveSessionResult;
    if (method === "chat.recentDelegationSessions") return { ids: [] };
    return {};
  });
  return {
    agentBoxManager: { getOrCreate: vi.fn(async () => ({ endpoint: "https://box" })) } as any,
    agentBoxTlsOptions: undefined,
    frontendClient: { request, emitEvent: vi.fn() } as any,
  };
}

const identity = { agentId: COORD, orgId: "" } as any;

function delegateResult(res: FakeRes) {
  return res.frames.find((f) => f?.type === "delegate_result")?.result;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  consumeReturn = { resultText: "ok", taskReportText: "", errorMessage: "", eventCount: 1, durationMs: 1 };
  consumeEvents = [];
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("handleDelegate — parentSessionId identity binding (P1)", () => {
  it("rejects a parentSessionId whose agent_id is not the calling coordinator (403, no peer run)", async () => {
    const deps = makeDeps({ found: true, user_id: "victim", agent_id: "SOMEONE-ELSE" });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "foreign-sess" }), res as any, identity, deps);

    expect(res.statusCode).toBe(403);
    expect((res.jsonBody as any)?.error).toMatch(/does not belong to this coordinator/);
    // The peer turn must never start on a spoofed parent.
    expect(promptMock).not.toHaveBeenCalled();
    expect(consumeAgentSse).not.toHaveBeenCalled();
  });

  it("proceeds when the parent session belongs to the calling coordinator", async () => {
    const deps = makeDeps({ found: true, user_id: "real-user", agent_id: COORD });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "own-sess" }), res as any, identity, deps);

    expect(res.statusCode).toBe(200);
    expect(promptMock).toHaveBeenCalledTimes(1);
    expect(delegateResult(res)?.ok).toBe(true);
  });

  it("fails closed (503) when parent validation cannot complete (RPC throws)", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    // Make chat.resolveSession throw — we cannot verify ownership → must not proceed.
    deps.frontendClient.request = vi.fn(async (method: string) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "chat.resolveSession") throw new Error("portal RPC down");
      return {};
    });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "own-sess" }), res as any, identity, deps);

    expect(res.statusCode).toBe(503);
    expect(promptMock).not.toHaveBeenCalled();
    // No peer session persisted under an unverified parent.
    expect(ensureChatSession).not.toHaveBeenCalled();
  });
});

describe("handleDelegate — cancellation during cold spawn (P1)", () => {
  it("does not prompt the peer if the coordinator disconnects during getOrCreate", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    const res = makeRes();
    // Simulate the client disconnecting WHILE the peer pod is cold-spawning: getOrCreate
    // fires the response 'close' handler (which aborts peerAbort) before it resolves.
    deps.agentBoxManager.getOrCreate = vi.fn(async () => {
      res.triggerClose();
      return { endpoint: "https://box" };
    });
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "own-sess" }), res as any, identity, deps);

    // The turn was cancelled before dispatch — the peer must never be prompted.
    expect(promptMock).not.toHaveBeenCalled();
  });
});

describe("handleDelegate — input_required propagation (P1)", () => {
  it("reports status input_required with the question when the peer calls request_input", async () => {
    consumeEvents = [{ type: "input_required", question: "which cluster do you mean?" }];
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "own-sess" }), res as any, identity, deps);

    const result = delegateResult(res);
    expect(result?.status).toBe("input_required");
    expect(result?.inputQuestion).toMatch(/which cluster/);
    expect(result?.peerSessionId).toBeTruthy();
  });
});

describe("handleDelegate — model-failure propagation (P1)", () => {
  it("emits a failed delegate_result when consumeAgentSse reports an errorMessage (no false success)", async () => {
    consumeReturn = { resultText: "", taskReportText: "", errorMessage: "provider 429 rate limited", eventCount: 0, durationMs: 5 };
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "own-sess" }), res as any, identity, deps);

    const result = delegateResult(res);
    expect(result?.ok).toBe(false);
    expect(result?.status).toBe("failed");
    expect(result?.error).toMatch(/rate limited/);
  });

  it("emits ok:true done when there is no error", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "own-sess" }), res as any, identity, deps);

    const result = delegateResult(res);
    expect(result?.ok).toBe(true);
    expect(result?.status).toBe("done");
  });
});
