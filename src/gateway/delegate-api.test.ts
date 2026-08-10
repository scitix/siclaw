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
const getMessages = vi.fn(async () => [] as any[]);
vi.mock("./chat-repo.js", () => ({
  ensureChatSession: (...a: any[]) => ensureChatSession(...a),
  appendMessage: (...a: any[]) => appendMessage(...a),
  getMessages: (...a: any[]) => getMessages(...a),
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

import { getRemoteDelegationIdleTimeoutMs, handleDelegate } from "./delegate-api.js";
import { sessionTurnLocks } from "./session-turn-lock.js";

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
  destroyed: boolean;
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
    destroyed: false,
    triggerClose() { this.destroyed = true; this._close?.(); },
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
  const eventHandlers = new Map<string, (data: unknown) => boolean | void>();
  const request = vi.fn(async (method: string) => {
    if (method === "config.getDelegates") {
      return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
    }
    if (method === "chat.resolveSession") return resolveSessionResult;
    if (method === "chat.recentDelegationSessions") return { ids: [] };
    if (method === "delegation.resolveRoute") return { local: true, sourceRuntimeId: "rt1", targetRuntimeId: "rt1" };
    return {};
  });
  return {
    agentBoxManager: { getOrCreate: vi.fn(async () => ({ endpoint: "https://box" })) } as any,
    agentBoxTlsOptions: undefined,
    frontendClient: {
      request,
      emitEvent: vi.fn(),
      subscribe: vi.fn((channel: string, handler: (data: unknown) => boolean | void) => {
        eventHandlers.set(channel, handler);
        return () => eventHandlers.delete(channel);
      }),
    } as any,
    eventHandlers,
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

  it("does not dispatch after the coordinator disconnects during route resolution", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    let releaseRoute: ((route: unknown) => void) | undefined;
    deps.frontendClient.request = vi.fn(async (method: string) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") {
        return new Promise((resolve) => { releaseRoute = resolve; });
      }
      return {};
    });
    const res = makeRes();
    const pending = handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);
    for (let i = 0; i < 20 && !releaseRoute; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(releaseRoute).toBeTruthy();

    res.triggerClose();
    releaseRoute?.({ local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" });
    await pending;

    expect(ensureChatSession).not.toHaveBeenCalled();
    expect(deps.agentBoxManager.getOrCreate).not.toHaveBeenCalled();
    expect(deps.frontendClient.request).not.toHaveBeenCalledWith("delegation.start", expect.anything());
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

describe("handleDelegate — cross-Runtime routing", () => {
  it("routes a remote peer through Sicore and never creates it in the coordinator AgentBoxManager", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    deps.frontendClient.request = vi.fn(async (method: string, params: any) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "chat.resolveSession") return { found: true, user_id: "u", agent_id: COORD };
      if (method === "chat.recentDelegationSessions") return { ids: [] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      if (method === "delegation.start") {
        getMessages.mockResolvedValueOnce([
          { role: "user", content: "inspect", delegationId: params.delegationId, metadata: null },
          { role: "assistant", content: "aries result", delegationId: null, metadata: null },
        ] as any);
        const relay = deps.eventHandlers.get("delegation.event")!;
        relay({
          delegationId: params.delegationId,
          sessionId: params.sessionId,
          event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "aries result" }] } },
        });
        relay({ delegationId: params.delegationId, sessionId: params.sessionId, event: { type: "prompt_done" } });
        return { ok: true, targetRuntimeId: "aries" };
      }
      return {};
    });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect", parentSessionId: "own-sess" }), res as any, identity, deps);

    expect(deps.agentBoxManager.getOrCreate).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
    const startCall = deps.frontendClient.request.mock.calls.find(([method]: any[]) => method === "delegation.start");
    expect(startCall?.[1]).toMatchObject({
      coordinatorAgentId: COORD,
      peerAgentId: PEER,
      prompt: {
        agentId: PEER,
        text: "inspect",
        skipInitialPersistence: true,
        delegation: { parentAgentId: COORD },
      },
    });
    expect(delegateResult(res)).toMatchObject({ ok: true, status: "done", finalText: "aries result" });
  });

  it("fails closed when the control plane cannot resolve the peer Runtime", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    deps.frontendClient.request = vi.fn(async (method: string) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") throw new Error("unknown method");
      return {};
    });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);

    expect(res.statusCode).toBe(503);
    expect(deps.agentBoxManager.getOrCreate).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("fails closed when the route envelope omits its source Runtime", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    deps.frontendClient.request = vi.fn(async (method: string) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") return { local: false, targetRuntimeId: "aries" };
      return {};
    });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);

    expect(res.statusCode).toBe(503);
    expect(deps.frontendClient.request).not.toHaveBeenCalledWith("delegation.start", expect.anything());
  });

  it("does not start a remote turn when its delegated session cannot be persisted", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    deps.frontendClient.request = vi.fn(async (method: string) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      return {};
    });
    ensureChatSession.mockRejectedValueOnce(new Error("database unavailable"));
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);

    expect(res.statusCode).toBe(503);
    expect(deps.frontendClient.request).not.toHaveBeenCalledWith("delegation.start", expect.anything());
    expect(deps.agentBoxManager.getOrCreate).not.toHaveBeenCalled();
  });

  it("surfaces a remote peer stream_error instead of returning false success", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    deps.frontendClient.request = vi.fn(async (method: string, params: any) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      if (method === "delegation.start") {
        const relay = deps.eventHandlers.get("delegation.event")!;
        relay({ delegationId: params.delegationId, sessionId: params.sessionId, event: { type: "stream_error", error: { message: "provider unavailable" } } });
        relay({ delegationId: params.delegationId, sessionId: params.sessionId, event: { type: "prompt_done" } });
        return { ok: true };
      }
      return {};
    });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);

    expect(delegateResult(res)).toMatchObject({ ok: false, status: "failed", error: "provider unavailable" });
  });

  it("treats an aborted terminal as failure even when partial assistant text was persisted", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    deps.frontendClient.request = vi.fn(async (method: string, params: any) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      if (method === "delegation.start") {
        deps.eventHandlers.get("delegation.event")!({
          delegationId: params.delegationId,
          sessionId: params.sessionId,
          event: { type: "prompt_done", aborted: true, reason: "box_rolled" },
        });
        return { ok: true };
      }
      return {};
    });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);

    expect(delegateResult(res)).toMatchObject({ ok: false, status: "failed" });
    expect(delegateResult(res)?.error).toContain("box_rolled");
    expect(delegateResult(res)?.finalText).toBeUndefined();
    expect(getMessages).not.toHaveBeenCalled();
  });

  it("recovers a persisted assistant answer when the live message frame was lost", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    deps.frontendClient.request = vi.fn(async (method: string, params: any) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      if (method === "delegation.start") {
        getMessages.mockResolvedValueOnce([
          { role: "user", content: "inspect", delegationId: params.delegationId, metadata: null },
          { role: "assistant", content: "durable aries result", delegationId: null, metadata: null },
        ] as any);
        deps.eventHandlers.get("delegation.event")!({
          delegationId: params.delegationId,
          sessionId: params.sessionId,
          event: { type: "prompt_done" },
        });
        return { ok: true };
      }
      return {};
    });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);

    expect(getMessages).toHaveBeenCalledWith(expect.any(String), { limit: 500 });
    expect(delegateResult(res)).toMatchObject({ ok: true, status: "done", finalText: "durable aries result" });
  });

  it("uses the durable answer when the live relay delivered only part of the assistant output", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    deps.frontendClient.request = vi.fn(async (method: string, params: any) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      if (method === "delegation.start") {
        getMessages.mockResolvedValueOnce([
          { role: "user", content: "inspect", delegationId: params.delegationId, metadata: null },
          { role: "assistant", content: "complete durable answer", delegationId: null, metadata: null },
        ] as any);
        const relay = deps.eventHandlers.get("delegation.event")!;
        relay({
          delegationId: params.delegationId,
          sessionId: params.sessionId,
          event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } },
        });
        relay({
          delegationId: params.delegationId,
          sessionId: params.sessionId,
          event: { type: "prompt_done" },
        });
        return { ok: true };
      }
      return {};
    });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);

    expect(delegateResult(res)).toMatchObject({ ok: true, status: "done", finalText: "complete durable answer" });
  });

  it("fails instead of returning an empty success when no durable result can be recovered", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    deps.frontendClient.request = vi.fn(async (method: string, params: any) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      if (method === "delegation.start") {
        getMessages.mockResolvedValueOnce([
          { role: "user", content: "inspect", delegationId: params.delegationId, metadata: null },
        ] as any);
        deps.eventHandlers.get("delegation.event")!({
          delegationId: params.delegationId,
          sessionId: params.sessionId,
          event: { type: "prompt_done" },
        });
        return { ok: true };
      }
      return {};
    });
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);

    expect(delegateResult(res)).toMatchObject({ ok: false, status: "failed" });
  });

  it("does not dispatch a remote turn when Stop arrives while waiting for the session lock", async () => {
    const peerSessionId = "blocked-peer-session";
    const release = await sessionTurnLocks.acquire(peerSessionId);
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    deps.frontendClient.request = vi.fn(async (method: string) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "chat.resolveSession") return { found: true, user_id: "u", agent_id: COORD };
      if (method === "chat.recentDelegationSessions") return { ids: [peerSessionId] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      return {};
    });
    const res = makeRes();
    const pending = handleDelegate(
      makeReq({ peerAgentId: PEER, text: "inspect", parentSessionId: "own-sess", peerSessionId }),
      res as any,
      identity,
      deps,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    res.triggerClose();
    release();
    await pending;

    expect(deps.frontendClient.request).not.toHaveBeenCalledWith("delegation.start", expect.anything());
  });

  it("refreshes the remote timeout on matching relay activity instead of capping total duration", async () => {
    vi.useFakeTimers();
    const previousTimeout = process.env.SICLAW_REMOTE_DELEGATION_IDLE_TIMEOUT;
    process.env.SICLAW_REMOTE_DELEGATION_IDLE_TIMEOUT = "1";
    try {
      const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
      let remoteParams: any;
      deps.frontendClient.request = vi.fn(async (method: string, params: any) => {
        if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
        if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
        if (method === "delegation.start") {
          remoteParams = params;
          getMessages.mockResolvedValueOnce([
            { role: "user", content: "inspect", delegationId: params.delegationId, metadata: null },
            { role: "assistant", content: "still active", delegationId: null, metadata: null },
          ] as any);
          return { ok: true };
        }
        return {};
      });
      const res = makeRes();
      const pending = handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);
      for (let i = 0; i < 20 && !remoteParams; i += 1) {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
      }
      expect(remoteParams).toBeTruthy();

      await vi.advanceTimersByTimeAsync(800);
      deps.eventHandlers.get("delegation.event")!({
        delegationId: remoteParams.delegationId,
        sessionId: remoteParams.sessionId,
        event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "still active" }] } },
      });
      await vi.advanceTimersByTimeAsync(800);
      deps.eventHandlers.get("delegation.event")!({
        delegationId: remoteParams.delegationId,
        sessionId: remoteParams.sessionId,
        event: { type: "prompt_done" },
      });
      await pending;

      expect(delegateResult(res)).toMatchObject({ ok: true, status: "done", finalText: "still active" });
      expect(deps.frontendClient.request).not.toHaveBeenCalledWith("delegation.abort", expect.anything(), expect.anything());
    } finally {
      if (previousTimeout === undefined) delete process.env.SICLAW_REMOTE_DELEGATION_IDLE_TIMEOUT;
      else process.env.SICLAW_REMOTE_DELEGATION_IDLE_TIMEOUT = previousTimeout;
      vi.useRealTimers();
    }
  });
});

describe("getRemoteDelegationIdleTimeoutMs", () => {
  it("reads seconds from the environment and rejects invalid values", () => {
    expect(getRemoteDelegationIdleTimeoutMs({ SICLAW_REMOTE_DELEGATION_IDLE_TIMEOUT: "42" } as NodeJS.ProcessEnv)).toBe(42_000);
    expect(getRemoteDelegationIdleTimeoutMs({ SICLAW_REMOTE_DELEGATION_IDLE_TIMEOUT: "0" } as NodeJS.ProcessEnv)).toBe(600_000);
    expect(getRemoteDelegationIdleTimeoutMs({ SICLAW_REMOTE_DELEGATION_IDLE_TIMEOUT: "invalid" } as NodeJS.ProcessEnv)).toBe(600_000);
  });
});
