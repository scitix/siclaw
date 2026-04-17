import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  createGuardRegistry,
  installGuardPipeline,
  type GuardRegistry,
  type InputGuard,
  type OutputGuard,
  type PersistGuard,
  type ContextGuard,
} from "./guard-pipeline.js";

// ── Helpers ────────────────────────────────────────────────────────────

function makeStream(events: unknown[], finalMessage: unknown): any {
  let i = 0;
  return {
    result: vi.fn(async () => finalMessage),
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (i < events.length) return { done: false, value: events[i++] };
          return { done: true, value: undefined };
        },
        async return() { return { done: true as const, value: undefined }; },
        async throw() { return { done: true as const, value: undefined }; },
      };
    },
  };
}

function makeAgent(streamFn?: any, transformContext?: any) {
  return {
    streamFn: streamFn ?? ((_m: any, _c: any, _o: any) => makeStream([], {})),
    transformContext,
  };
}

function makeSessionManager() {
  const appended: AgentMessage[] = [];
  return {
    appended,
    appendMessage: vi.fn((m: AgentMessage) => { appended.push(m); }),
  } as any;
}

// ── createGuardRegistry ────────────────────────────────────────────────

describe("createGuardRegistry", () => {
  it("registers expected named guards in each stage", () => {
    const reg = createGuardRegistry(128_000);
    expect(reg.input.map((g) => g.name)).toEqual([
      "sanitize-tool-calls",
      "repair-tool-use-pairing",
    ]);
    expect(reg.output.map((g) => g.name)).toEqual([
      "trim-tool-call-names",
      "repair-malformed-args",
    ]);
    expect(reg.persist.map((g) => g.name)).toEqual(["session-tool-result-guard"]);
    expect(reg.context.map((g) => g.name)).toEqual(["context-budget-guard"]);
  });

  it("output guards expose processEvent / processResult / reset", () => {
    const reg = createGuardRegistry(1000);
    for (const g of reg.output) {
      expect(typeof g.handler.processEvent).toBe("function");
      expect(typeof g.handler.processResult).toBe("function");
      expect(typeof g.handler.reset).toBe("function");
    }
  });
});

// ── installGuardPipeline: input + output ────────────────────────────────

describe("installGuardPipeline — input/output wrap", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs input guards on context.messages before calling baseFn", async () => {
    const calls: AgentMessage[][] = [];
    const baseFn = vi.fn((_m: any, ctx: any, _o: any) => {
      calls.push(ctx.messages);
      return makeStream([], {});
    });
    const agent = makeAgent(baseFn);

    const originalMsgs: AgentMessage[] = [{ role: "user", content: "x", timestamp: 0 } as AgentMessage];
    const replaced: AgentMessage[] = [{ role: "user", content: "y", timestamp: 0 } as AgentMessage];

    // Input guard: replace when input is originalMsgs
    const guardA: InputGuard = (m) => (m === originalMsgs ? replaced : m);

    const registry: GuardRegistry = {
      input: [{ name: "a", handler: guardA }],
      output: [],
      persist: [],
      context: [],
    };
    installGuardPipeline(registry, { agent, sessionManager: makeSessionManager() });

    agent.streamFn("model", { messages: originalMsgs, extra: 1 }, {});
    expect(calls[0]).toBe(replaced);
  });

  it("does not clone context when no input guard changes messages", () => {
    const baseFn = vi.fn((_m: any, ctx: any, _o: any) => {
      expect(ctx).toBeDefined();
      return makeStream([], {});
    });
    const agent = makeAgent(baseFn);
    const msgs: AgentMessage[] = [];
    const ctxObj = { messages: msgs };
    const noopGuard: InputGuard = (m) => m;

    const registry: GuardRegistry = {
      input: [{ name: "noop", handler: noopGuard }],
      output: [],
      persist: [],
      context: [],
    };
    installGuardPipeline(registry, { agent, sessionManager: makeSessionManager() });
    agent.streamFn("m", ctxObj, {});
    expect(baseFn).toHaveBeenCalled();
    expect(baseFn.mock.calls[0][1]).toBe(ctxObj);
  });

  it("calls baseFn directly when context.messages is not an array", () => {
    const baseFn = vi.fn(() => makeStream([], {}));
    const agent = makeAgent(baseFn);
    const registry: GuardRegistry = {
      input: [{ name: "a", handler: (m) => m }],
      output: [],
      persist: [],
      context: [],
    };
    installGuardPipeline(registry, { agent, sessionManager: makeSessionManager() });
    agent.streamFn("model", { messages: "not-array" }, {});
    expect(baseFn).toHaveBeenCalled();
  });

  it("wraps stream: calls processEvent for each event and processResult on result()", async () => {
    const events = [{ kind: "e1" }, { kind: "e2" }];
    const finalMsg = { role: "assistant", content: [] };
    const baseFn = () => makeStream(events, finalMsg);
    const agent = makeAgent(baseFn);

    const processEvent = vi.fn();
    const processResult = vi.fn();
    const reset = vi.fn();
    const output: OutputGuard = { processEvent, processResult, reset };

    const registry: GuardRegistry = {
      input: [],
      output: [{ name: "out", handler: output }],
      persist: [],
      context: [],
    };
    installGuardPipeline(registry, { agent, sessionManager: makeSessionManager() });

    const stream = agent.streamFn("m", { messages: [] }, {});
    const iterated: unknown[] = [];
    for await (const evt of stream) iterated.push(evt);
    const result = await stream.result();

    expect(reset).toHaveBeenCalledTimes(1);
    expect(processEvent).toHaveBeenCalledTimes(2);
    expect(processResult).toHaveBeenCalledTimes(1);
    expect(processResult).toHaveBeenCalledWith(finalMsg);
    expect(iterated).toHaveLength(2);
    expect(result).toBe(finalMsg);
  });

  it("awaits promise-based baseFn return", async () => {
    const events = [{ a: 1 }];
    const baseFn = () => Promise.resolve(makeStream(events, { done: true }));
    const agent = makeAgent(baseFn);
    const processEvent = vi.fn();
    const output: OutputGuard = { processEvent, processResult: vi.fn(), reset: vi.fn() };
    const registry: GuardRegistry = {
      input: [],
      output: [{ name: "out", handler: output }],
      persist: [],
      context: [],
    };
    installGuardPipeline(registry, { agent, sessionManager: makeSessionManager() });
    const p = agent.streamFn("m", { messages: [] }, {});
    expect(typeof (p as Promise<any>).then).toBe("function");
    const stream = await p;
    for await (const _e of stream) {}
    expect(processEvent).toHaveBeenCalledTimes(1);
  });

  it("skips stream wrapping when outputGuards is empty", () => {
    const events = [{ z: 1 }];
    const finalMsg = { fine: true };
    const rawStream = makeStream(events, finalMsg);
    const baseFn = () => rawStream;
    const agent = makeAgent(baseFn);
    const registry: GuardRegistry = { input: [], output: [], persist: [], context: [] };
    installGuardPipeline(registry, { agent, sessionManager: makeSessionManager() });

    const s = agent.streamFn("m", { messages: [] }, {});
    expect(s).toBe(rawStream);
  });
});

// ── installGuardPipeline: persist ───────────────────────────────────────

describe("installGuardPipeline — persist wrap", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes message through a single guard", () => {
    const sm = makeSessionManager();
    const guard: PersistGuard = (m) => [m];
    const registry: GuardRegistry = { input: [], output: [], persist: [{ name: "p", handler: guard }], context: [] };
    installGuardPipeline(registry, { agent: makeAgent(), sessionManager: sm });
    const msg = { role: "user", content: "hi", timestamp: 0 } as AgentMessage;
    sm.appendMessage(msg);
    expect(sm.appended).toEqual([msg]);
  });

  it("drops a message when a guard returns empty array", () => {
    const sm = makeSessionManager();
    const drop: PersistGuard = () => [];
    const registry: GuardRegistry = { input: [], output: [], persist: [{ name: "drop", handler: drop }], context: [] };
    installGuardPipeline(registry, { agent: makeAgent(), sessionManager: sm });
    sm.appendMessage({ role: "user", content: "bye", timestamp: 0 } as AgentMessage);
    expect(sm.appended).toHaveLength(0);
  });

  it("fan-outs: guard returning two messages appends both", () => {
    const sm = makeSessionManager();
    const synth = { role: "toolResult", toolCallId: "a", content: "synth", toolName: "x", timestamp: 0 } as unknown as AgentMessage;
    const guard: PersistGuard = (m) => [synth, m];
    const registry: GuardRegistry = { input: [], output: [], persist: [{ name: "fan", handler: guard }], context: [] };
    installGuardPipeline(registry, { agent: makeAgent(), sessionManager: sm });
    const original = { role: "user", content: "q", timestamp: 0 } as AgentMessage;
    sm.appendMessage(original);
    expect(sm.appended).toEqual([synth, original]);
  });

  it("chains multiple guards via flatMap", () => {
    const sm = makeSessionManager();
    const addMarker: PersistGuard = (m) => [{ ...(m as any), marker1: true } as AgentMessage];
    const double: PersistGuard = (m) => [m, m];
    const registry: GuardRegistry = {
      input: [], output: [], context: [],
      persist: [{ name: "a", handler: addMarker }, { name: "b", handler: double }],
    };
    installGuardPipeline(registry, { agent: makeAgent(), sessionManager: sm });
    sm.appendMessage({ role: "user", content: "x", timestamp: 0 } as AgentMessage);
    expect(sm.appended).toHaveLength(2);
    expect((sm.appended[0] as any).marker1).toBe(true);
  });
});

// ── installGuardPipeline: context ───────────────────────────────────────

describe("installGuardPipeline — context wrap", () => {
  it("runs context guards after original transformContext", async () => {
    const calls: string[] = [];
    const originalTransform = vi.fn(async (m: AgentMessage[]) => {
      calls.push("orig");
      return m;
    });
    const agent = makeAgent(undefined, originalTransform);
    const ctxGuard: ContextGuard = (_m) => { calls.push("guard"); };
    const registry: GuardRegistry = {
      input: [], output: [], persist: [], context: [{ name: "c", handler: ctxGuard }],
    };
    installGuardPipeline(registry, { agent, sessionManager: makeSessionManager() });

    const msgs: AgentMessage[] = [{ role: "user", content: "hi", timestamp: 0 } as AgentMessage];
    const ac = new AbortController();
    const result = await agent.transformContext(msgs, ac.signal);
    expect(result).toBe(msgs);
    expect(originalTransform).toHaveBeenCalled();
    // Guard runs AFTER original
    expect(calls).toEqual(["orig", "guard"]);
  });

  it("still runs context guards when no original transformContext exists", async () => {
    const agent = makeAgent(undefined, undefined);
    const ctxGuard = vi.fn();
    const registry: GuardRegistry = {
      input: [], output: [], persist: [], context: [{ name: "c", handler: ctxGuard }],
    };
    installGuardPipeline(registry, { agent, sessionManager: makeSessionManager() });
    const msgs: AgentMessage[] = [];
    await agent.transformContext(msgs, new AbortController().signal);
    expect(ctxGuard).toHaveBeenCalledWith(msgs);
  });

  it("falls back to original messages when transformContext returns non-array", async () => {
    const orig = vi.fn(async () => "not-array" as any);
    const agent = makeAgent(undefined, orig);
    const ctxGuard = vi.fn();
    const registry: GuardRegistry = {
      input: [], output: [], persist: [], context: [{ name: "c", handler: ctxGuard }],
    };
    installGuardPipeline(registry, { agent, sessionManager: makeSessionManager() });
    const msgs: AgentMessage[] = [];
    const out = await agent.transformContext(msgs, new AbortController().signal);
    expect(out).toBe(msgs);
    expect(ctxGuard).toHaveBeenCalledWith(msgs);
  });
});

// ── Log on change (input guard) ────────────────────────────────────────

describe("guardLog triggers on input guard change", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("logs 'transformed' with guard name when input array reference changes", () => {
    const warn = vi.spyOn(console, "warn");
    const baseFn = () => makeStream([], {});
    const agent = makeAgent(baseFn);
    const msgs: AgentMessage[] = [];
    const replaced: AgentMessage[] = [];
    const guard: InputGuard = (m) => (m === msgs ? replaced : m);
    const registry: GuardRegistry = {
      input: [{ name: "changer", handler: guard }],
      output: [], persist: [], context: [],
    };
    installGuardPipeline(registry, { agent, sessionManager: makeSessionManager() });
    agent.streamFn("m", { messages: msgs }, {});
    const any = warn.mock.calls.map((c) => String(c[0])).join("|");
    expect(any).toMatch(/changer/);
    expect(any).toMatch(/transformed/);
  });
});
