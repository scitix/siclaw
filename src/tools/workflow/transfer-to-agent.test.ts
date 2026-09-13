import { describe, expect, it, vi } from "vitest";
import { createTransferToAgentTool, registration } from "./transfer-to-agent.js";
import { createSearchHandoffTargetsTool, registration as searchRegistration } from "./search-handoff-targets.js";
import { resolveAgentHarness } from "../../core/agent-context.js";
import { ToolRegistry } from "../../core/tool-registry.js";
import type { ToolRefs } from "../../core/tool-registry.js";
import type { HandoffTarget } from "../../shared/agent-handoff.js";

function target(over: Partial<HandoffTarget> = {}): HandoffTarget {
  return {
    id: "agent-cn",
    name: "Siclaw (国内)",
    routeKey: "cn",
    description: "上海 / 北京两地的集群与主机",
    isFacade: false,
    clusters: ["roce-test", "sh-prod"],
    hosts: ["10.0.0.1"],
    ...over,
  };
}

function refs(over: Partial<ToolRefs> = {}): ToolRefs {
  return {
    handoffSupported: true,
    sessionEventEmitter: vi.fn(),
    handoffTargets: [target()],
    searchHandoffTargets: vi.fn(),
    handoffSearchMatches: new Map([["cn", { id: "agent-cn", routeKey: "cn", name: "Siclaw (国内)", agentType: "sre", description: "", matches: [], matchCount: 1 }]]),
    ...over,
  } as unknown as ToolRefs;
}

describe("transfer_to_agent 的可用性", () => {
  it("没有目标就整个不出现 —— 普通 agent 一个 transfer 工具都不该长出来", () => {
    expect(registration.available?.(refs({ handoffTargets: undefined }))).toBe(false);
    expect(registration.available?.(refs({ handoffTargets: [] }))).toBe(false);
  });

  it("有目标且不是委托来的 turn 才出现", () => {
    expect(registration.available?.(refs())).toBe(true);
  });

  // channel 的 turn 在 runtime 本地跑、不经网关,没有人接住那条帧做链式转发。
  it("supports every control-plane conversation mode", () => {
    expect(registration.modes).toEqual(["web", "channel", "task"]);
  });
});

describe("constant-sized handoff tool definitions", () => {
  it("does not serialize assets, target descriptions or a destination enum", () => {
    const small = createTransferToAgentTool(refs());
    const huge = createTransferToAgentTool(refs({ handoffTargets: Array.from({length: 100}, (_,i) => target({
      id: `agent-${i}`, routeKey: `route-${i}`, description: "PRIVATE-LONG-DESCRIPTION".repeat(1000),
      hosts: Array.from({length: 1000}, (_,j) => `host-${j}`), clusters: Array.from({length: 60}, (_,j) => `cluster-${j}`),
    })) }));
    expect(huge.description).toEqual(small.description);
    expect(huge.parameters).toEqual(small.parameters);
    expect(small.description).toContain("search_handoff_targets");
    expect(small.description).not.toContain("roce-test");
    expect(small.description).not.toContain("10.0.0.1");
    expect(JSON.stringify(huge.parameters)).not.toContain("route-99");
  });
});

describe("transfer_to_agent 的执行", () => {
  it("发一条 handoff_requested control 帧,带目标 id 与 brief", async () => {
    const emit = vi.fn();
    const tool = createTransferToAgentTool(refs({ sessionEventEmitter: emit }));
    const out = await tool.execute!("call-1", { route_key: "cn", brief: "查 roce-test 的节点数" }, undefined as never);
    expect(emit).toHaveBeenCalledWith({
      type: "handoff_requested",
      targetAgentId: "agent-cn",
      brief: "查 roce-test 的节点数",
    });
    expect((out as { details: { transferred: boolean } }).details.transferred).toBe(true);
  });

  // 本地历史是缓存,控制面才是权威:交出去之后这份副本只会越来越旧。
  it("交接之后丢掉本 box 的本地会话副本", async () => {
    const evict = vi.fn(async () => {});
    const tool = createTransferToAgentTool(refs({ evictSessionContext: evict }));
    await tool.execute!("call-1", { route_key: "cn", brief: "b" }, undefined as never);
    expect(evict).toHaveBeenCalledTimes(1);
  });

  // 失效标记持久化失败时不能承诺交接成功。
  it("缓存失效失败时不交接", async () => {
    const emit = vi.fn();
    const tool = createTransferToAgentTool(refs({
      sessionEventEmitter: emit,
      evictSessionContext: async () => { throw new Error("disk gone"); },
    }));
    const out = await tool.execute!("call-1", { route_key: "cn", brief: "b" }, undefined as never);
    expect(emit).not.toHaveBeenCalled();
    expect((out as { details: { transferred: boolean } }).details.transferred).toBe(false);
  });

  // ⚠️ 名单外的 key 一帧都不能发:控制面随后照样会拒,但那时这一轮已经结束了,
  // 用户看到的是 agent 说完就没了下文。
  it("名单外的 route_key 不发帧", async () => {
    const emit = vi.fn();
    const tool = createTransferToAgentTool(refs({ sessionEventEmitter: emit }));
    const out = await tool.execute!("call-1", { route_key: "moon", brief: "b" }, undefined as never);
    expect(emit).not.toHaveBeenCalled();
    expect((out as { details: { transferred: boolean } }).details.transferred).toBe(false);
    expect((out as { content: { text: string }[] }).content[0].text).toContain("search_handoff_targets");
  });

  it("brief 为空不发帧", async () => {
    const emit = vi.fn();
    const tool = createTransferToAgentTool(refs({ sessionEventEmitter: emit }));
    const out = await tool.execute!("call-1", { route_key: "cn", brief: "   " }, undefined as never);
    expect(emit).not.toHaveBeenCalled();
    expect((out as { details: { transferred: boolean } }).details.transferred).toBe(false);
  });
});


// ⚠️ 这条锁的是一次线上级故障,不是措辞偏好。
//
// 工具结果原来写着 "End your turn now — say nothing further"。模型照办了 —— 它发一条
// **空的** assistant 消息,而 pi-agent-brain 把"零个 content 块"当成 provider 返回空、
// 重试两次、然后整轮判失败(`Empty response persisted after 2 retries`)。用户那边看到
// 的就是"没响应"。
//
// 交接之后这一轮的内容全都被网关静音,用户和 transcript 都看不到,所以这句话说什么
// 不重要 —— 重要的是**必须让它有话可说**,这一轮才不会是空的。
describe("terminal handoff", () => {
  it("returns the engine termination flag instead of requiring a closing response", async () => {
    const tool = createTransferToAgentTool(refs());
    const out = await tool.execute!("call", { route_key: "cn", brief: "Count nodes" }, undefined, undefined, {} as never);
    expect(out).toMatchObject({ terminate: true, details: { transferred: true } });
    expect(tool.executionMode).toBe("sequential");
    expect(tool.description).toContain("ALONE");
  });
  it("validation errors do not terminate execution", async () => {
    const tool = createTransferToAgentTool(refs());
    const out = await tool.execute!("call", { route_key: "unknown", brief: "Count nodes" }, undefined, undefined, {} as never);
    expect(out).toMatchObject({ terminate: false, details: { transferred: false } });
  });
});

it("the installed agent loop stops after the handoff result without another model call", async () => {
  const { runAgentLoop } = await import("@earendil-works/pi-agent-core");
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const tool = createTransferToAgentTool(refs());
  const model = { id: "test", name: "test", api: "openai-completions", provider: "test", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
  const events: any[] = [];
  const streamFn = vi.fn(() => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "toolUse", message: {
        role: "assistant", content: [{ type: "toolCall", id: "transfer-1", name: "transfer_to_agent", arguments: { route_key: "cn", brief: "count nodes" } }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse", timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } });
      stream.end();
    });
    return stream;
  });
  await runAgentLoop([{ role: "user", content: "count nodes", timestamp: Date.now() }],
    { systemPrompt: "test", messages: [], tools: [tool as never] },
    { model: model as never, convertToLlm: (messages) => messages as never },
    (event) => { events.push(event); }, undefined, streamFn);
  expect(streamFn).toHaveBeenCalledTimes(1);
  expect(events.filter(e => e.type === "tool_execution_end")).toHaveLength(1);
  expect(events.at(-1).type).toBe("agent_end");
  expect(events.some(e => e.type === "message_end" && e.message.role === "toolResult")).toBe(true);
});

// Exercise the real compiler + registry together, not just a capability array.
describe("conversation handoff across Agent types", () => {
  const registry = new ToolRegistry();
  registry.register(registration, searchRegistration);
  function toolsFor(agentType: string, overrides: Parameters<typeof resolveAgentHarness>[0] = { allowedTools: null, memoryConfigured: false }, toolRefs = refs()) {
    const harness = resolveAgentHarness({
      agentType, mode: "web", handoffAvailable: true, ...overrides,
    });
    return registry.resolve({ mode: "web", refs: toolRefs, allowedTools: harness.allowedTools });
  }
  it.each(["sre", "knowledge_qa", "product_support", "custom"])("offers transfer to a resolved %s conversation owner", (type) => {
    expect(toolsFor(type).map(t => t.name)).toEqual(["transfer_to_agent", "search_handoff_targets"]);
  });
  it("adds only ownership transfer to a restricted Custom allowance", () => {
    const allowedTools = ["read"];
    const harness = resolveAgentHarness({ agentType: "custom", allowedTools, mode: "web", memoryConfigured: false, handoffAvailable: true });
    expect(harness.allowedTools).toEqual(["read", "transfer_to_agent", "search_handoff_targets"]);
    expect(allowedTools).toEqual(["read"]);
    expect(harness.includeOperationalSafety).toBe(false);
    expect(toolsFor("custom", { allowedTools, memoryConfigured: false })).toHaveLength(2);
  });
  it("does not grant operations to a read-only knowledge agent", () => {
    const harness = resolveAgentHarness({ agentType: "knowledge_qa", allowedTools: null, mode: "web", memoryConfigured: false, handoffAvailable: true });
    expect(harness.allowedTools).toEqual(["read", "grep", "find", "ls", "knowledge_search", "knowledge_cite", "transfer_to_agent", "search_handoff_targets"]);
    expect(harness.includeSubagentGuidance).toBe(false);
  });
  it("keeps an unresolved harness closed even with a roster", () => {
    expect(toolsFor("custom", { allowedTools: null, memoryConfigured: false, harnessResolved: false })).toEqual([]);
  });
  it.each([
    { handoffTargets: [] }, { sessionEventEmitter: undefined }, { searchHandoffTargets: undefined },
    { isSubagent: true },
  ])("does not expose a transfer without ownership and transport: %j", (overrides) => {
    expect(toolsFor("custom", undefined, refs(overrides))).toEqual([]);
  });
  it.each(["web", "channel", "task", "cli"] as const)("does not expose handoff without a capable transport in %s mode", (mode) => {
    expect(registry.resolve({ mode, refs: refs({ handoffSupported: false }), allowedTools: null })).toEqual([]);
  });
});

it("carries trace context on the control event, captured before eviction and absent from model parameters", async () => {
  const context = { traceId: "0123456789abcdef0123456789abcdef", parentSpanId: "1234567890abcdef", traceFlags: 1 };
  const order: string[] = [];
  const emit = vi.fn();
  const tool = createTransferToAgentTool(refs({
    sessionEventEmitter: emit,
    getHandoffTraceContext: callId => { expect(callId).toBe("handoff-call"); order.push("capture"); return context; },
    evictSessionContext: async () => { order.push("evict"); },
  }));
  await tool.execute!("handoff-call", { route_key: "cn", brief: "continue" }, undefined as never);
  expect(order).toEqual(["capture", "evict"]);
  expect(emit).toHaveBeenCalledWith({ type: "handoff_requested", targetAgentId: "agent-cn", brief: "continue", traceContext: context });
  expect(JSON.stringify(tool.parameters)).not.toContain("traceId");
});

describe("per-request loop prevention", () => {
  const policy = { remaining: 1, visitedAgentIds: ["agent-cn", "agent-intl"], history: [{ from: "agent-cn", to: "agent-intl", brief: "Inspect overseas", newEvidence: "Location confirmed" }] };
  it.each([undefined, " ", "LOCATION  confirmed", "inspect overseas"])("rejects a return without new evidence before eviction: %s", async (new_evidence) => {
    const emit = vi.fn(); const evict = vi.fn();
    const tool = createTransferToAgentTool(refs({ handoffPolicy: policy, sessionEventEmitter: emit, evictSessionContext: evict }));
    const out = await tool.execute!("return", { route_key: "cn", brief: "Please try again", new_evidence }, undefined as never);
    expect(out).toMatchObject({ terminate: false, details: { transferred: false } });
    expect(emit).not.toHaveBeenCalled(); expect(evict).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).toContain("specific information or access needed");
  });
  it("allows an evidenced return and carries it to the control plane", async () => {
    const emit = vi.fn();
    const tool = createTransferToAgentTool(refs({ handoffPolicy: policy, sessionEventEmitter: emit }));
    expect(tool.description).toContain("already participated in this request; returning requires new_evidence");
    const new_evidence = "Overseas inventory resolves this host to the domestic cluster; domestic access can check it.";
    const out = await tool.execute!("return", { route_key: "cn", brief: "Check the domestic cluster", new_evidence }, undefined as never);
    expect(out).toMatchObject({ terminate: true });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ targetAgentId: "agent-cn", newEvidence: new_evidence }));
  });
  it("hides the tool at zero budget and rejects stale invocations without ending the response", async () => {
    const r = refs({ handoffPolicy: { ...policy, remaining: 0 } });
    expect(registration.available?.(r)).toBe(false);
    const out = await createTransferToAgentTool(r).execute!("stale", { route_key: "cn", brief: "again", new_evidence: "new" }, undefined as never);
    expect(out).toMatchObject({ terminate: false, details: { transferred: false } });
    expect(r.sessionEventEmitter).not.toHaveBeenCalled();
  });
  it("keeps another session's fresh policy independent", async () => {
    const blocked = refs({ handoffPolicy: { ...policy, remaining: 0 } });
    const fresh = refs({ handoffPolicy: { remaining: 2, visitedAgentIds: ["other"], history: [] } });
    expect(registration.available?.(blocked)).toBe(false);
    const out = await createTransferToAgentTool(fresh).execute!("new", { route_key: "cn", brief: "Inspect" }, undefined as never);
    expect(out).toMatchObject({ terminate: true });
    expect(blocked.sessionEventEmitter).not.toHaveBeenCalled();
  });
});


describe("on-demand destination lookup", () => {
  const candidate = { id: "agent-cn", routeKey: "cn", name: "SRE", agentType: "sre", description: "Domestic diagnostics", matches: [{kind: "host", name: "host-999", ip: "10.1.2.3"}], matchCount: 1 };
  it("requires discovery before transfer, and isolates another session's discovered targets", async () => {
    const r = refs({ handoffSearchMatches: new Map(), searchHandoffTargets: vi.fn(async () => ({targets: [candidate], total: 1})) });
    const transfer = createTransferToAgentTool(r);
    expect(await transfer.execute!("before", {route_key:"cn", brief:"check"}, undefined as never)).toMatchObject({terminate:false});
    const query = {kind:"host", query:"10.1.2.3"};
    const found = await createSearchHandoffTargetsTool(r).execute!("query", query, undefined as never);
    expect(r.searchHandoffTargets).toHaveBeenCalledWith(query);
    expect(found.details).toMatchObject({targets:[{matches:candidate.matches}], total:1});
    expect(await transfer.execute!("after", {route_key:"cn", brief:"check"}, undefined as never)).toMatchObject({terminate:true});
    const other = refs({handoffSearchMatches:new Map()});
    expect(await createTransferToAgentTool(other).execute!("other", {route_key:"cn",brief:"check"}, undefined as never)).toMatchObject({terminate:false});
    expect(other.sessionEventEmitter).not.toHaveBeenCalled();
  });
  it("preserves pagination and ambiguity rather than selecting the first match", async () => {
    const r = refs({handoffSearchMatches:new Map(), searchHandoffTargets:vi.fn(async()=>({targets:[candidate], total:9,nextOffset:1}))});
    const out = await createSearchHandoffTargetsTool(r).execute!("query", {kind:"capability",query:"diagnostics",limit:1}, undefined as never);
    expect(out.details).toMatchObject({total:9,nextOffset:1});
    expect(r.sessionEventEmitter).not.toHaveBeenCalled();
  });
  it("does not treat lookup failure as no coverage, and rejects targets outside its index", async () => {
    for (const search of [async()=>{throw Error("unavailable")}, async()=>({targets:[{...candidate,id:"foreign"}],total:1})]) {
      const r=refs({handoffSearchMatches:new Map(),searchHandoffTargets:search});
      const out=await createSearchHandoffTargetsTool(r).execute!("query",{kind:"host",query:"host-999"},undefined as never);
      expect(out).toMatchObject({isError:true});
      expect(r.handoffSearchMatches?.size).toBe(0);
      expect(r.sessionEventEmitter).not.toHaveBeenCalled();
    }
  });
});
