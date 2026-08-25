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
let consumeGate: Promise<void> | undefined;
const consumeAgentSse = vi.fn(async (opts: any) => {
  for (const e of consumeEvents) opts.onEvent?.(e);
  if (consumeGate) await consumeGate;
  return consumeReturn;
});
vi.mock("./sse-consumer.js", () => ({ consumeAgentSse: (o: any) => consumeAgentSse(o) }));

const ensureChatSession = vi.fn(async () => {});
// Returns an id: delegate-api keeps it so the row can be bound to a trace id after the ack.
const appendMessage = vi.fn(async () => "msg-user-1");
const bindMessageTraceId = vi.fn(async () => {});
const getMessages = vi.fn(async () => [] as any[]);
vi.mock("./chat-repo.js", () => ({
  ensureChatSession: (...a: any[]) => ensureChatSession(...a),
  appendMessage: (...a: any[]) => appendMessage(...a),
  bindMessageTraceId: (...a: any[]) => bindMessageTraceId(...a),
  getMessages: (...a: any[]) => getMessages(...a),
  incrementMessageCount: vi.fn(async () => {}),
  updateMessage: vi.fn(async () => {}),
}));

vi.mock("./agent-model-binding.js", () => ({
  resolveAgentModelBinding: vi.fn(async () => ({ modelProvider: "p", modelId: "m", modelConfig: undefined, modelRouting: undefined, systemPrompt: undefined })),
}));

const promptMock = vi.fn(async () => ({ ok: true, sessionId: "peer-sess" }));
const abortSessionCalls: Array<string | undefined> = [];
let abortSessionBehaviour: ((attempt: number) => Promise<void>) | undefined;
const abortSessionMock = vi.fn(async (_sessionId: string, turnId?: string) => {
  const attempt = abortSessionCalls.length + 1;
  abortSessionCalls.push(turnId);
  if (abortSessionBehaviour) await abortSessionBehaviour(attempt);
});
vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    constructor(_e: string, _t?: number, _tls?: unknown) {}
    prompt = promptMock;
    abortSession = abortSessionMock;
  },
}));

import { getRemoteDelegationIdleTimeoutMs, handleDelegate, isDelegationSettled, peerEffectiveTraceId } from "./delegate-api.js";
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
  consumeGate = undefined;
  abortSessionCalls.length = 0;
  abortSessionBehaviour = undefined;
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

describe("handleDelegate — the v1 request context", () => {
  const ctx = (over: Record<string, unknown> = {}) => ({
    schema_version: 1, mode: "snapshot", scope: "exact",
    targets: [{ type: "cluster", cluster_binding: "sh-1" }],
    ...over,
  });
  // The fixture roster member covers no clusters, so coverage tests need one that does.
  const withCoverage = (deps: any, clusters: string[], hosts: string[] = []) => {
    deps.frontendClient.request = vi.fn(async (method: string) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters, hosts }] };
      if (method === "chat.resolveSession") return { found: true, user_id: "u", agent_id: COORD };
      if (method === "chat.recentDelegationSessions") return { ids: [] };
      if (method === "delegation.resolveRoute") return { local: true, sourceRuntimeId: "rt1", targetRuntimeId: "rt1" };
      return {};
    });
    return deps;
  };

  it("renders the context into labelled blocks APPENDED to the task", async () => {
    const deps = withCoverage(makeDeps({ found: true, user_id: "u", agent_id: COORD }), ["sh-1"]);
    await handleDelegate(makeReq({
      peerAgentId: PEER, text: "why is coredns unhealthy", parentSessionId: "own-sess",
      requestContext: ctx({
        constraints: { user_requirements: ["do not restart anything"] },
        observations: [{ text: "cetus is only a candidate", source: "coordinator_tool" }],
      }),
    }), makeRes() as any, identity, deps);

    const sent = promptMock.mock.calls[0][0].text as string;
    // The objective in the user's own words still LEADS; the structure supports it.
    expect(sent.indexOf("why is coredns unhealthy")).toBe(0);
    expect(sent).toContain("[AUTHORITATIVE TARGETS]");
    expect(sent).toContain("[USER CONSTRAINTS]");
    expect(sent).toContain("do not restart anything");
    expect(sent).toContain("[UNVERIFIED OBSERVATIONS]");
    expect(sent).toContain("These are LEADS, not facts");
  });

  it("persists the RAW structure, not only the rendered text", async () => {
    // Rendered prose cannot answer "was a target dropped in transit", which is one of the
    // acceptance questions this contract is judged on.
    const deps = withCoverage(makeDeps({ found: true, user_id: "u", agent_id: COORD }), ["sh-1"]);
    await handleDelegate(makeReq({
      peerAgentId: PEER, text: "t", parentSessionId: "own-sess", requestContext: ctx(),
    }), makeRes() as any, identity, deps);

    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "user",
      metadata: expect.objectContaining({ request_context: expect.objectContaining({ scope: "exact" }) }),
    }));
  });

  it("rejects a target the peer does not cover — BEFORE any peer session or box exists", async () => {
    // The roster check authorizes the PEER, not the resource: today a delegation naming cluster A
    // can be handed to an agent bound only to B and nothing refuses it.
    const deps = withCoverage(makeDeps({ found: true, user_id: "u", agent_id: COORD }), ["other-cluster"]);
    const res = makeRes();
    await handleDelegate(makeReq({
      peerAgentId: PEER, text: "t", parentSessionId: "own-sess", requestContext: ctx(),
    }), res as any, identity, deps);

    expect(res.statusCode).toBe(400);
    expect((res.jsonBody as any)?.rejected_by).toBe("target_not_covered");
    // Nothing started: no box, no prompt, no session row.
    expect(promptMock).not.toHaveBeenCalled();
    expect(ensureChatSession).not.toHaveBeenCalled();
  });

  it("rejects a malformed context with a machine-readable reason", async () => {
    const deps = withCoverage(makeDeps({ found: true, user_id: "u", agent_id: COORD }), ["sh-1"]);
    const res = makeRes();
    // scope=discovery carrying targets: a guess presented as confirmed identity.
    await handleDelegate(makeReq({
      peerAgentId: PEER, text: "t", parentSessionId: "own-sess",
      requestContext: ctx({ scope: "discovery" }),
    }), res as any, identity, deps);

    expect(res.statusCode).toBe(400);
    // Assert the CODE, never the prose — a pinned sentence breaks on rewording and proves nothing.
    expect((res.jsonBody as any)?.rejected_by).toBe("scope_targets");
    expect(promptMock).not.toHaveBeenCalled();
  });

  // Contract §7 requires a read-only test on BOTH paths. A single-path test is exactly what let the
  // topology hole survive a green suite: the permission held for a same-Runtime peer and not for a
  // cross-Runtime one, so whether it applied depended on where the peer happened to be scheduled.
  it("LOCAL path: access_mode=read_only sets delegation.readOnly", async () => {
    const deps = withCoverage(makeDeps({ found: true, user_id: "u", agent_id: COORD }), ["sh-1"]);
    await handleDelegate(makeReq({
      peerAgentId: PEER, text: "t", parentSessionId: "own-sess",
      requestContext: ctx({ execution_policy: { access_mode: "read_only" } }),
    }), makeRes() as any, identity, deps);

    expect(promptMock.mock.calls[0][0].delegation.readOnly).toBe(true);
  });

  it("REMOTE path: access_mode travels as a REQUEST parameter, not a prompt field", async () => {
    // The router rebuilds prompt.delegation from trusted state precisely so nothing in the
    // caller's opaque payload can decide permissions — a value placed there is discarded silently.
    const deps = withCoverage(makeDeps({ found: true, user_id: "u", agent_id: COORD }), ["sh-1"]);
    deps.frontendClient.request = vi.fn(async (method: string) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: ["sh-1"], hosts: [] }] };
      if (method === "chat.resolveSession") return { found: true, user_id: "u", agent_id: COORD };
      if (method === "chat.recentDelegationSessions") return { ids: [] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "rt1", targetRuntimeId: "rt2" };
      return {};
    });
    // Not awaited: the cross-Runtime path then waits on the remote turn, which is not the subject.
    // What is under test is the SHAPE of the dispatch, so poll for the call and stop there.
    void handleDelegate(makeReq({
      peerAgentId: PEER, text: "t", parentSessionId: "own-sess",
      requestContext: ctx({ execution_policy: { access_mode: "read_only" } }),
    }), makeRes() as any, identity, deps).catch(() => { /* the remote turn itself is not the subject */ });

    const findStart = () => deps.frontendClient.request.mock.calls.find((c: any[]) => c[0] === "delegation.start");
    for (let i = 0; i < 200 && !findStart(); i += 1) await new Promise((r) => setTimeout(r, 5));
    const start = findStart();
    expect(start?.[1].access_mode).toBe("read_only");
    // Kept equal to the derivation so a mismatch between the two would be a bug, not a design.
    expect(start?.[1].prompt.delegation.readOnly).toBe(true);
  });

  it("omits access_mode entirely on the normal path — an older router sees no new field", async () => {
    const deps = withCoverage(makeDeps({ found: true, user_id: "u", agent_id: COORD }), ["sh-1"]);
    await handleDelegate(makeReq({
      peerAgentId: PEER, text: "t", parentSessionId: "own-sess", requestContext: ctx(),
    }), makeRes() as any, identity, deps);
    // Default is normal: the cautious-looking inverse would strip write tools from every existing
    // remediation delegation.
    expect(promptMock.mock.calls[0][0].delegation.readOnly).toBe(false);
  });

  it("refuses the retired field name rather than honouring it as a synonym", async () => {
    // A caller still sending requested_access_mode believes the field only advises; it now
    // enforces. Silently honouring it would give a peer fewer tools than the caller thinks it
    // asked for.
    const deps = withCoverage(makeDeps({ found: true, user_id: "u", agent_id: COORD }), ["sh-1"]);
    const res = makeRes();
    await handleDelegate(makeReq({
      peerAgentId: PEER, text: "t", parentSessionId: "own-sess",
      requestContext: ctx({ execution_policy: { requested_access_mode: "read_only" } }),
    }), res as any, identity, deps);

    expect(res.statusCode).toBe(400);
    expect((res.jsonBody as any)?.rejected_by).toBe("requested_access_mode_retired");
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("leaves an older caller completely unaffected", async () => {
    const deps = withCoverage(makeDeps({ found: true, user_id: "u", agent_id: COORD }), []);
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "just the task", parentSessionId: "own-sess" }), res as any, identity, deps);

    expect(res.statusCode).toBe(200);
    // No blocks appended, and no coverage check performed — absent means the pre-contract behaviour.
    expect(promptMock.mock.calls[0][0].text).toBe("just the task");
  });
});

describe("handleDelegate — the v1 result contract (C1 producer)", () => {
  it("a plan-only turn is completed + unknown — neither done nor failed", async () => {
    // The peer ended normally and called no protocol tool, so completeness is genuinely unknown.
    // This is the single most common thing the contract makes visible, and reading it as either
    // extreme restores the ambiguity being removed. Legacy `status` stays "done" for old readers —
    // which is exactly why it was never sufficient on its own.
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    const res = makeRes();
    // finalText accumulates from the peer's EVENTS, not from the consumer's return value.
    consumeEvents = [{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "I'll start by checking the pods" }] } }];
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "own-sess" }), res as any, identity, deps);

    const r = delegateResult(res);
    expect(r.schema_version).toBe(1);
    expect(r.turn_status).toBe("completed");
    expect(r.task_status).toBe("unknown");
    expect(r.payload_kind).toBe("narrative");
    expect(r.status).toBe("done");
  });

  it("carries the peer's SUBMITTED task_status through, never inferring it from the artifact", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    const res = makeRes();
    // The peer reported but said it did not finish. An artifact proves it REPORTED, not that it
    // FINISHED — inferring "complete" here is the defect the field exists to remove.
    consumeEvents = [{ type: "delegation_artifact", findings: "f", actions_taken: "none", residual_state: "half the clusters unchecked", task_status: "partial" }];
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "own-sess" }), res as any, identity, deps);

    const r = delegateResult(res);
    expect(r.task_status).toBe("partial");
    expect(r.payload_kind).toBe("artifact");
    // Legacy status is lossy on purpose: it says "done" for a partial result too.
    expect(r.status).toBe("done");
  });

  it("request_input is blocked + ask_user, and the turn still COMPLETED", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    const res = makeRes();
    consumeEvents = [{ type: "input_required", question: "which cluster?" }];
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "own-sess" }), res as any, identity, deps);

    const r = delegateResult(res);
    expect(r.turn_status).toBe("completed"); // blocking is a TASK state, not a transport failure
    expect(r.task_status).toBe("blocked");
    expect(r.next_action).toBe("ask_user");
    expect(r.inputQuestion).toBe("which cluster?");
  });

  it("emits v1 on the failure paths too — a v1 producer speaks v1 always", async () => {
    // Falling back to the old shape for an awkward turn would make schema_version unreliable as
    // the branch key, which is the one property the reader table depends on.
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    const res = makeRes();
    consumeReturn = { resultText: "", taskReportText: "", errorMessage: "model exploded", eventCount: 1, durationMs: 1 };
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "own-sess" }), res as any, identity, deps);

    const r = delegateResult(res);
    expect(r.schema_version).toBe(1);
    expect(r.turn_status).toBe("failed");
    expect(r.task_status).toBe("unknown"); // nobody reported, so the work's state is unknown
    expect(r.ok).toBe(false);
  });
});

describe("handleDelegate — trace context forwarding (C3)", () => {
  const TRACE = "0123456789abcdef0123456789abcdef";
  const SPAN = "0123456789abcdef";

  it("forwards traceId / parentSpanContext / toolCallId at the prompt's TOP LEVEL", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    await handleDelegate(makeReq({
      peerAgentId: PEER, text: "t", parentSessionId: "own-sess",
      traceId: TRACE,
      parentSpanContext: { traceId: TRACE, spanId: SPAN, traceFlags: 1 },
      toolCallId: "call-7",
    }), makeRes() as any, identity, deps);

    const sent = promptMock.mock.calls[0][0];
    expect(sent.traceId).toBe(TRACE);
    expect(sent.parentSpanContext).toEqual({ traceId: TRACE, spanId: SPAN, traceFlags: 1 });
    expect(sent.delegationToolCallId).toBe("call-7");
    // TOP LEVEL is a contract, not a style choice: the management plane's router RECONSTRUCTS
    // prompt.delegation, so a field nested inside it is dropped in transit. Asserting the absence
    // is what stops a future refactor from "tidying" these into the delegation object.
    expect(sent.delegation.traceId).toBeUndefined();
    expect(sent.delegation.parentSpanContext).toBeUndefined();
  });

  it("stamps the peer's rows and the delegated user row with a trace id (the DB half)", async () => {
    // Spans and rows are SEPARATE mechanisms. An earlier change propagated the span context and
    // called the chain complete, but every persisted peer row still landed with trace_id NULL —
    // and the delegation acceptance metrics (parent/child linkage, repeated identity resolution)
    // are answered from rows, not spans. Every other prompt entry point already did this backfill.
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    await handleDelegate(makeReq({
      peerAgentId: PEER, text: "t", parentSessionId: "own-sess", traceId: TRACE, toolCallId: "call-7",
    }), makeRes() as any, identity, deps);

    // The consumer stamps every row it persists.
    expect(consumeAgentSse).toHaveBeenCalledWith(expect.objectContaining({ traceId: TRACE }));
    // The opening user row is written BEFORE dispatch, so it is bound afterwards from the ack.
    expect(bindMessageTraceId).toHaveBeenCalledWith(expect.any(String), expect.any(String), TRACE);
    // Tool-call correlation is a DB join, so the id has to be on a row.
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      role: "user",
      metadata: { delegation_tool_call_id: "call-7" },
    }));
  });

  it("prefers the box's OWN trace id from the ack over the one we sent", async () => {
    // The box may not adopt what we sent (old build, tracing unattached), and its spans then carry
    // an id we never saw. Stamping rows with OUR id would split rows from spans in exactly that
    // case. Pinned separately because the previous test passes through the FALLBACK branch — the
    // ack carries no traceId there, so it proves nothing about which one wins.
    const BOX_TRACE = "fedcba9876543210fedcba9876543210";
    promptMock.mockResolvedValueOnce({ ok: true, sessionId: "peer-sess", traceId: BOX_TRACE } as any);
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    await handleDelegate(makeReq({
      peerAgentId: PEER, text: "t", parentSessionId: "own-sess", traceId: TRACE,
    }), makeRes() as any, identity, deps);

    expect(consumeAgentSse).toHaveBeenCalledWith(expect.objectContaining({ traceId: BOX_TRACE }));
    expect(bindMessageTraceId).toHaveBeenCalledWith(expect.any(String), expect.any(String), BOX_TRACE);
  });

  // The precedence rule is a pure function, pinned directly: driving the cross-Runtime path here
  // would wait on the remote turn, which is not the subject. startPrompt nests the peer's root
  // under parentSpanContext when present, so the root inherits THAT trace id and the DB id is read
  // back off the span — binding the row to the separate `traceId` field would split the delegation
  // across two traces, the defect C3 removes, reached by another route.
  it("peerEffectiveTraceId: parentSpanContext wins, and malformed yields nothing", () => {
    const A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(peerEffectiveTraceId(TRACE, { traceId: A, spanId: SPAN })).toBe(A);
    expect(peerEffectiveTraceId(TRACE, undefined)).toBe(TRACE);
    // A malformed parent falls through to traceId rather than poisoning the result.
    expect(peerEffectiveTraceId(TRACE, { traceId: "nope" })).toBe(TRACE);
    // Nothing usable means undefined. A NULL trace_id says "unknown"; a wrong one says something false.
    expect(peerEffectiveTraceId("not-a-trace-id", undefined)).toBeUndefined();
    expect(peerEffectiveTraceId(undefined, undefined)).toBeUndefined();
    expect(peerEffectiveTraceId("0".repeat(32), undefined)).toBeUndefined();
    expect(peerEffectiveTraceId(123, { traceId: 456 })).toBeUndefined();
  });

  it("leaves the row UNBOUND rather than binding a malformed trace id", async () => {
    // A NULL trace_id says "unknown"; a wrong one says something false. The peer's recorder rejects
    // an invalid id and generates its own, so binding to what we sent would name an id no span uses.
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    await handleDelegate(makeReq({
      peerAgentId: PEER, text: "t", parentSessionId: "own-sess", traceId: "not-a-trace-id",
    }), makeRes() as any, identity, deps);
    expect(bindMessageTraceId.mock.calls.filter((c) => c[2])).toHaveLength(0);
  });

  it("omits them when the caller sent none — an older caller must still work", async () => {
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    await handleDelegate(
      makeReq({ peerAgentId: PEER, text: "t", parentSessionId: "own-sess" }),
      makeRes() as any, identity, deps,
    );
    const sent = promptMock.mock.calls[0][0];
    // Absent means "no trace to join" — the peer then generates its own id, exactly as before.
    expect(sent.traceId).toBeUndefined();
    expect(sent.parentSpanContext).toBeUndefined();
    expect(sent.delegationToolCallId).toBeUndefined();
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

describe("handleDelegate — admission fence", () => {
  it("refuses a delegation once the Runtime is shutting down", async () => {
    // This endpoint starts AgentBox work of its own, so it honours the same fence as an
    // ordinary turn: a peer admitted now would run on a box that outlives the Runtime,
    // with a coordinator waiting on a result that never comes. Refusing is an answer.
    const deps = {
      ...makeDeps({ found: true, user_id: "u", agent_id: COORD }),
      shutdownGate: { isShuttingDown: () => true, register: () => () => {} },
    };
    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps as any);

    expect(res.statusCode).toBe(503);
    expect((res.jsonBody as any)?.error).toMatch(/shutting down/);
    expect(deps.agentBoxManager.getOrCreate).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
    // Not even the roster lookup: nothing about this request should reach the control plane.
    expect(deps.frontendClient.request).not.toHaveBeenCalled();
  });
  it("does not dispatch when shutdown begins during a pre-dispatch await", async () => {
    // One sample at entry proves nothing: the handler awaits the roster, the model
    // binding, the route, session reuse, persistence and the session lock before it
    // dispatches. Observing "not shutting down" and then pausing in any of those is
    // exactly how a turn reaches a box after shutdown has taken its one look.
    let shuttingDown = false;
    let releaseRoute: (() => void) | undefined;
    const deps: any = {
      ...makeDeps({ found: true, user_id: "u", agent_id: COORD }),
      shutdownGate: { isShuttingDown: () => shuttingDown, register: () => () => {} },
    };
    deps.frontendClient.request = vi.fn(async (method: string) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") {
        // Shutdown starts while this await is outstanding.
        await new Promise<void>((resolve) => { releaseRoute = resolve; });
        return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      }
      return {};
    });

    const res = makeRes();
    const handling = handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);
    await vi.waitFor(() => expect(releaseRoute).toBeDefined());
    shuttingDown = true;
    releaseRoute!();
    await handling;

    expect(deps.frontendClient.request).not.toHaveBeenCalledWith("delegation.start", expect.anything());
    expect(deps.agentBoxManager.getOrCreate).not.toHaveBeenCalled();
    expect(promptMock).not.toHaveBeenCalled();
  });

  it("hands the shutdown a wind-down it can WAIT for, not one it merely starts", async () => {
    // A client disconnect can fire and forget; a shutdown cannot. If the hook returns
    // before its abort lands, the transport closes and the process exits underneath it.
    let cancel: (() => Promise<void> | void) | undefined;
    let releaseAbort: (() => void) | undefined;
    let abortHeld = false;
    const deps: any = {
      ...makeDeps({ found: true, user_id: "u", agent_id: COORD }),
      shutdownGate: {
        isShuttingDown: () => false,
        register: (fn: () => Promise<void> | void) => { cancel = fn; return () => { cancel = undefined; }; },
      },
    };
    deps.frontendClient.request = vi.fn(async (method: string) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      if (method === "delegation.start") return { ok: true };
      if (method === "delegation.abort") {
        // Only the wind-down's own request is held; the handler's follow-up must not
        // deadlock the test.
        if (!abortHeld) {
          abortHeld = true;
          await new Promise<void>((resolve) => { releaseAbort = resolve; });
        }
        return { ok: true };
      }
      return {};
    });

    const res = makeRes();
    const handling = handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);
    await vi.waitFor(() => expect(cancel).toBeDefined());

    // What shutdown does with the hook: it awaits the returned promise.
    let windDownSettled = false;
    const windDown = Promise.resolve().then(() => cancel!()).then(() => { windDownSettled = true; });
    await vi.waitFor(() => expect(releaseAbort).toBeDefined());
    expect(windDownSettled).toBe(false);

    releaseAbort!();
    await windDown;
    expect(windDownSettled).toBe(true);
    await handling;
  });

  it("retries a refused abort, and keeps the hook until that attempt settles", async () => {
    // The LOCAL path, because there the wind-down is the only source of abortSession —
    // on the remote path the handler issues one of its own and the count proves nothing.
    //
    // Two ways this could look done while the peer keeps running: a refusal resolved as
    // success, and a disconnect-started attempt whose hook is released the moment the
    // handler settles, leaving a shutdown an instant later nothing to wait for.
    let openConsumer: (() => void) | undefined;
    consumeGate = new Promise<void>((resolve) => { openConsumer = resolve; });
    let releaseSecondAbort: (() => void) | undefined;
    abortSessionBehaviour = async (attempt) => {
      if (attempt === 1) throw new Error("box refused");
      if (attempt === 2) await new Promise<void>((resolve) => { releaseSecondAbort = resolve; });
    };

    let cancel: (() => Promise<void> | void) | undefined;
    const deps: any = {
      ...makeDeps({ found: true, user_id: "u", agent_id: COORD }),
      shutdownGate: {
        isShuttingDown: () => false,
        register: (fn: () => Promise<void> | void) => { cancel = fn; return () => { cancel = undefined; }; },
      },
    };

    const res = makeRes();
    const handling = handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);
    await vi.waitFor(() => expect(promptMock).toHaveBeenCalled());

    // A DISCONNECT starts the wind-down, fire and forget, and lets the handler finish.
    res.triggerClose();
    openConsumer!();
    await handling;

    // The refusal did not count as done — a second attempt is outstanding — and the hook
    // is still registered, so a shutdown now has that attempt to wait for.
    await vi.waitFor(() => expect(abortSessionCalls.length).toBe(2), { timeout: 3000 });
    expect(cancel).toBeDefined();

    const windDown = Promise.resolve().then(() => cancel!());
    releaseSecondAbort!();
    await windDown;
    // Settled: only now is the hook released.
    await vi.waitFor(() => expect(cancel).toBeUndefined(), { timeout: 3000 });
  });

  it("registers a wind-down so a shutdown reaches a delegation already under way", async () => {
    // Past refusing: the only thing left is the same wind-down a client disconnect
    // triggers, which is why it is registered rather than only checked.
    let cancel: (() => void) | undefined;
    const deps: any = {
      ...makeDeps({ found: true, user_id: "u", agent_id: COORD }),
      shutdownGate: {
        isShuttingDown: () => false,
        register: (fn: () => void) => { cancel = fn; return () => { cancel = undefined; }; },
      },
    };
    deps.frontendClient.request = vi.fn(async (method: string, params: any) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      if (method === "delegation.start") {
        // Under way now: shutdown can only wind it down.
        cancel?.();
        return { ok: true };
      }
      return {};
    });

    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);

    expect(deps.frontendClient.request).toHaveBeenCalledWith("delegation.abort", { delegationId: expect.any(String) }, 10_000);
    expect(delegateResult(res)).toMatchObject({ ok: false, status: "failed" });
  });
});

describe("handleDelegate — cross-Runtime routing", () => {
  it("routes a remote peer through ControlPlane and never creates it in the coordinator AgentBoxManager", async () => {
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

    expect(getMessages).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ limit: 200 }));
    expect(delegateResult(res)).toMatchObject({ ok: true, status: "done", finalText: "durable aries result" });
  });

  it("marks a finished remote delegation settled so a re-sent terminal is acknowledged", async () => {
    // Reliable control delivery retries until the source acknowledges. Once the
    // consumer has finished there is nobody to accept a re-sent terminal, and
    // rejecting it forever keeps the sender's relay alive — whose idle expiry
    // aborts by (agent, session) and would kill a new turn reusing this session.
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    let startedDelegationId = "";
    deps.frontendClient.request = vi.fn(async (method: string, params: any) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      if (method === "delegation.start") {
        startedDelegationId = params.delegationId;
        getMessages.mockResolvedValueOnce([
          { id: "u1", role: "user", content: "inspect", delegationId: params.delegationId, metadata: null, createdAt: new Date(1000) },
          { id: "a1", role: "assistant", content: "settled answer", delegationId: null, metadata: null, createdAt: new Date(2000) },
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

    expect(delegateResult(res)).toMatchObject({ ok: true, status: "done" });
    expect(isDelegationSettled(startedDelegationId)).toBe(true);
    expect(isDelegationSettled("never-started")).toBe(false);
  });

  it("widens the history window until a turn boundary buried under its own tool rows is inside it", async () => {
    // Tool rows are messages too, so one window is not one turn: a tool-heavy peer
    // turn can push its own opening row out of the newest N rows. Recovery must
    // keep widening rather than report a completed delegation as unrecoverable.
    // The window grows instead of walking a timestamp cursor because created_at has
    // one-second granularity — a cursor would skip same-second rows.
    const deps = makeDeps({ found: true, user_id: "u", agent_id: COORD });
    deps.frontendClient.request = vi.fn(async (method: string, params: any) => {
      if (method === "config.getDelegates") return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      if (method === "delegation.resolveRoute") return { local: false, sourceRuntimeId: "shanghai", targetRuntimeId: "aries" };
      if (method === "delegation.start") {
        const toolRows = (n: number) => Array.from({ length: n }, (_unused, i) => ({
          id: `t${i}`, role: "tool", content: "kubectl get pods", delegationId: null, metadata: null,
        }));
        // First window is saturated and holds no boundary → must widen.
        getMessages.mockResolvedValueOnce([
          ...toolRows(199),
          { id: "a1", role: "assistant", content: "durable answer", delegationId: null, metadata: null },
        ] as any);
        // Wider window finally reaches this turn's opening row, preceded by an
        // older unrelated turn that must NOT leak into the result.
        getMessages.mockResolvedValueOnce([
          { id: "old", role: "assistant", content: "previous turn answer", delegationId: null, metadata: null },
          { id: "u1", role: "user", content: "inspect", delegationId: params.delegationId, metadata: null },
          ...toolRows(199),
          { id: "a1", role: "assistant", content: "durable answer", delegationId: null, metadata: null },
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

    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(getMessages).toHaveBeenNthCalledWith(1, expect.any(String), { limit: 200 });
    expect(getMessages).toHaveBeenNthCalledWith(2, expect.any(String), { limit: 400 });
    expect(delegateResult(res)).toMatchObject({ ok: true, status: "done", finalText: "durable answer" });
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
