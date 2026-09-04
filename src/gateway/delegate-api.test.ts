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
// ⚠️ 这些用例测的是**派发之前**的行为 —— 父会话身份绑定、名册授权、准入围栏、
// 冷启动期间的取消。派发本身(现在唯一的一条路是 A2A)由它自己那套跑在真实
// HTTP server 上的测试覆盖(delegate-a2a-transport.test.ts),以及控制面一侧的
// 跨仓库契约测试。
//
// 这里 mock 掉它,是为了让这些用例继续测它们本来要测的那件事,而不是变成又一份
// 手写的传输 fixture —— 后者正是让四处形状不匹配同时漏检的东西。
vi.mock("./delegate-a2a-transport.js", () => ({
  a2aTransportConfig: () => ({ baseUrl: "http://control-plane:8081", token: "t" }),
  runA2aDelegation: (args: any) => a2aDelegation(args),
}));

const ensureChatSession = vi.fn(async () => {});
const appendMessage = vi.fn(async () => "opening-row-1");
const getMessages = vi.fn(async () => [] as any[]);
const bindMessageTraceId = vi.fn(async () => {});
const warnTraceBindFailure = vi.fn();
// 可注入的委托结果,默认一次干净的完成。
let a2aOutcome: any = { taskId: "t1" };
let a2aGate: Promise<void> | undefined;
const a2aCalls: any[] = [];
async function a2aDelegation(args: any) {
  a2aCalls.push(args);
  // 闸门:让测试把委托卡在"已派发但未返回"的状态,用来验准入围栏与停机等待。
  if (a2aGate) await a2aGate;
  if (typeof a2aOutcome === "function") return a2aOutcome(args);
  return a2aOutcome;
}

vi.mock("./chat-repo.js", async (importOriginal) => ({
  ensureChatSession: (...a: any[]) => ensureChatSession(...a),
  appendMessage: (...a: any[]) => appendMessage(...a),
  getMessages: (...a: any[]) => getMessages(...a),
  bindMessageTraceId: (...a: any[]) => bindMessageTraceId(...a),
  warnTraceBindFailure: (...a: any[]) => warnTraceBindFailure(...a),
  // The real validator, not a stub: the code under test gates ingested ids
  // through it, and the malformed-id test depends on the actual contract.
  validTraceId: (await importOriginal<typeof import("./chat-repo.js")>()).validTraceId,
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

import { getRemoteDelegationIdleTimeoutMs, handleDelegate, isDelegationSettled, salvageDelegationTraceBind } from "./delegate-api.js";
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

// ⚠️ EVERY TEST IN THIS FILE EXERCISES THE LEGACY TRANSPORT, so it now has to
// say so. A2A became the default, and these fixtures have no control plane to
// talk to — a delegation would try to reach one and fail for a reason that has
// nothing to do with what the test is about.
//
// Declaring it here rather than deleting the file: the legacy path is still
// present as the rollback (SICLAW_DELEGATION_TRANSPORT=legacy), so its
// behaviour still needs to hold. When the code goes, this file goes with it.
beforeEach(() => {
  a2aOutcome = { taskId: "t1" };
  a2aCalls.length = 0;
  a2aGate = undefined;
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  consumeReturn = { resultText: "ok", taskReportText: "", errorMessage: "", eventCount: 1, durationMs: 1 };
  consumeEvents = [];
  a2aGate = undefined;
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
    // 「派发了」= 调了 A2A 传输一次。以前是断言本地 AgentBox 的 prompt,而这一侧
    // 已经不再自己跑 peer。
    expect(a2aCalls).toHaveLength(1);
    expect(a2aCalls[0]).toMatchObject({ peerAgentId: PEER, coordinatorAgentId: COORD });
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

  // 「路由解析期间断开」那条已删:不再有路由解析这一步。控制面在名册判定里
  // 顺带推导出 peer 的 Runtime,所以这一侧没有可以在其中被取消的窗口。冷启动
  // 期间取消那条仍然有效,就在上面。
});

describe("handleDelegate — input_required propagation (P1)", () => {
  it("reports status input_required with the question when the peer calls request_input", async () => {
    // peer 通过 A2A 流报出这个问题;传输把它翻成 observe 事件。
    a2aOutcome = (args: any) => {
      args.observe({ type: "input_required", question: "which cluster do you mean?" });
      return {};
    };
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
  it("emits a failed delegate_result when the delegation reports an error (no false success)", async () => {
    a2aOutcome = { error: "provider 429 rate limited" };
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
    expect(a2aCalls).toHaveLength(0);
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
    let releaseRoster: (() => void) | undefined;
    const deps: any = {
      ...makeDeps({ found: true, user_id: "u", agent_id: COORD }),
      shutdownGate: { isShuttingDown: () => shuttingDown, register: () => () => {} },
    };
    // 闸门挂在名册查询上 —— 派发前仍然存在的一次 await。以前挂的是
    // delegation.resolveRoute,那一步已经没有了(peer 的 Runtime 由控制面在名册
    // 判定里顺带推导),但"入口采样一次证明不了什么"这个论点一字未变。
    deps.frontendClient.request = vi.fn(async (method: string) => {
      if (method === "config.getDelegates") {
        await new Promise<void>((resolve) => { releaseRoster = resolve; });
        return { members: [{ id: PEER, name: "peer", description: "", clusters: [], hosts: [] }] };
      }
      return {};
    });

    const res = makeRes();
    const handling = handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);
    await vi.waitFor(() => expect(releaseRoster).toBeDefined());
    shuttingDown = true;
    releaseRoster!();
    await handling;

    // 「派发」现在就是调用 A2A 传输。
    expect(a2aCalls).toHaveLength(0);
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
    // 委托卡在"已派发未返回",这样注册的 wind-down 有真东西可等。取消不再是一次
    // delegation.abort RPC —— 传输收到 abort signal 后自己去发任务的 :cancel。
    a2aOutcome = async (args: any) => {
      if (!abortHeld) {
        abortHeld = true;
        args.signal.addEventListener("abort", () => releaseAbort?.());
        await new Promise<void>((resolve) => { releaseAbort = resolve; });
      }
      return { taskId: "t1" };
    };

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

  // ⚠️ 「被拒的 abort 会重试」那条删了:重试的对象不存在了。
  //
  // 它测的是 peerClient.abortSession —— 本地那条路上 wind-down 唯一的取消手段,
  // 会被 box 拒绝、因此需要退避重试。现在这一侧不再自己跑 peer,取消就是 abort
  // 掉 signal,由传输去发那个任务自己的 `:cancel`,而那是控制面拥有的操作:没有
  // "被拒"这个状态可以重试。
  //
  // 它真正守住的那件事 —— wind-down 必须是可等待的、而不是发出去就算完 —— 由
  // 上面那条("hands the shutdown a wind-down it can WAIT for")覆盖,而且现在
  // 挂在 A2A 派发上。

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
    // 委托已经在派发中:此刻停机唯一能做的就是 wind it down。
    let sawAbort = false;
    a2aOutcome = async (args: any) => {
      args.signal.addEventListener("abort", () => { sawAbort = true; });
      cancel?.();
      // 让取消先落地,再返回 —— 模拟一次被中途掐掉的派发。
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return { stopped: true };
    };

    const res = makeRes();
    await handleDelegate(makeReq({ peerAgentId: PEER, text: "inspect" }), res as any, identity, deps);

    // 注册的 wind-down 确实抵达了在跑的委托 —— 取消现在是 abort 掉传输的 signal,
    // 由它去发那个任务自己的 `:cancel`,而不是一次 delegation.abort RPC。
    expect(sawAbort).toBe(true);
  });
});

// ⚠️ 删掉的三组:「delegated-leg trace id」「cross-Runtime routing」
// 「getRemoteDelegationIdleTimeoutMs」。
//
// 它们的主体不是被改了,是不存在了:委托只走 A2A,peer 由控制面派发,所以这一侧
// 既不再决定 peer 落在哪个 Runtime(那是名册判定顺带推导出来的),也不再自己中继
// 远端事件流、不再需要一个远端空闲超时、不再需要"已结算的委托"记忆去应答重投的
// terminal。留着它们只会测一段已经删掉的代码。
//
// 幸存的几组测的是**派发之前**的东西 —— 父会话身份绑定、名册授权、准入围栏、
// 冷启动期间的取消 —— 那些在 A2A 路径上一字未改。
