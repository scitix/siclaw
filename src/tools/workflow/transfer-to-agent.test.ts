import { describe, expect, it, vi } from "vitest";
import { createTransferToAgentTool, registration } from "./transfer-to-agent.js";
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
    sessionEventEmitter: vi.fn(),
    handoffTargets: [target()],
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

  // 一个 peer 没有资格处置 coordinator 的会话:委托来的 turn 不给这个工具。
  it("委托来的 turn 不给", () => {
    expect(registration.available?.(refs({ delegation: { delegationId: "d1" } as never }))).toBe(false);
  });

  // channel 的 turn 在 runtime 本地跑、不经网关,没有人接住那条帧做链式转发。
  it("只在 web 模式出现,channel 与 task 排除在外", () => {
    expect(registration.modes).toEqual(["web"]);
  });
});

describe("transfer_to_agent 的描述", () => {
  it("列出每个目标覆盖的集群与主机 —— 交接的判断依据就是这个", () => {
    const tool = createTransferToAgentTool(refs());
    expect(tool.description).toContain("cn: Siclaw (国内)");
    expect(tool.description).toContain("roce-test");
    expect(tool.description).toContain("10.0.0.1");
  });

  it("交回 facade 的那一项标出来", () => {
    const tool = createTransferToAgentTool(refs({
      handoffTargets: [target({ id: "f", name: "Siclaw", routeKey: "facade", isFacade: true })],
    }));
    expect(tool.description).toContain("BACK");
  });

  // 覆盖面可能是几百台主机,而这段文字是每一轮的常驻上下文。
  it("覆盖列表超过上限就截断并说明还有多少", () => {
    const hosts = Array.from({ length: 60 }, (_, i) => `host-${i}`);
    const tool = createTransferToAgentTool(refs({ handoffTargets: [target({ clusters: [], hosts })] }));
    expect(tool.description).toContain("(+36 more)");
    expect(tool.description).not.toContain("host-59");
  });

  // 参数是字面量联合,不是自由字符串:模型只能挑名单里的那几个。
  it("route_key 是目标 key 的枚举", () => {
    const tool = createTransferToAgentTool(refs({
      handoffTargets: [target(), target({ id: "agent-intl", routeKey: "intl" })],
    }));
    const schema = tool.parameters as unknown as { properties: { route_key: { anyOf?: { const: string }[] } } };
    expect(schema.properties.route_key.anyOf?.map((v) => v.const)).toEqual(["cn", "intl"]);
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
    expect((out as { content: { text: string }[] }).content[0].text).toContain("cn");
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
  registry.register(registration);
  function toolsFor(agentType: string, overrides: Parameters<typeof resolveAgentHarness>[0] = { allowedTools: null, memoryConfigured: false }, toolRefs = refs()) {
    const harness = resolveAgentHarness({
      agentType, mode: "web", handoffAvailable: true, ...overrides,
    });
    return registry.resolve({ mode: "web", refs: toolRefs, allowedTools: harness.allowedTools });
  }
  it.each(["sre", "coordinator", "knowledge_qa", "product_support", "custom"])("offers transfer to a resolved %s conversation owner", (type) => {
    expect(toolsFor(type).map(t => t.name)).toEqual(["transfer_to_agent"]);
  });
  it("adds only ownership transfer to a restricted Custom allowance", () => {
    const allowedTools = ["read"];
    const harness = resolveAgentHarness({ agentType: "custom", allowedTools, mode: "web", memoryConfigured: false, handoffAvailable: true });
    expect(harness.allowedTools).toEqual(["read", "transfer_to_agent"]);
    expect(allowedTools).toEqual(["read"]);
    expect(harness.includeOperationalSafety).toBe(false);
    expect(toolsFor("custom", { allowedTools, memoryConfigured: false })).toHaveLength(1);
  });
  it("does not grant operations to a read-only knowledge agent", () => {
    const harness = resolveAgentHarness({ agentType: "knowledge_qa", allowedTools: null, mode: "web", memoryConfigured: false, handoffAvailable: true });
    expect(harness.allowedTools).toEqual(["read", "grep", "find", "ls", "knowledge_search", "knowledge_cite", "transfer_to_agent"]);
    expect(harness.includeSubagentGuidance).toBe(false);
  });
  it("keeps an unresolved harness closed even with a roster", () => {
    expect(toolsFor("custom", { allowedTools: null, memoryConfigured: false, harnessResolved: false })).toEqual([]);
  });
  it.each([
    { handoffTargets: [] }, { sessionEventEmitter: undefined },
    { isSubagent: true }, { delegation: { delegationId: "d1" } },
  ])("does not expose a transfer without ownership and transport: %j", (overrides) => {
    expect(toolsFor("custom", undefined, refs(overrides))).toEqual([]);
  });
  it.each(["channel", "task", "cli"] as const)("does not expose handoff in %s mode", (mode) => {
    expect(registry.resolve({ mode, refs: refs(), allowedTools: null })).toEqual([]);
  });
});

describe("target capability summaries", () => {
  it("describes type allowances and configured skills, knowledge and MCP names", () => {
    const tool = createTransferToAgentTool(refs({ handoffTargets: [target({
      agentType: "knowledge_qa", toolCapabilities: null,
      skills: ["GPU FAQ guide"], knowledgeBases: ["Product FAQ"], mcpServers: ["Ticket service"], resourcesResolved: true,
    })] }));
    expect(tool.description).toContain("Knowledge Q&A Agent");
    expect(tool.description).toContain("knowledge_search");
    expect(tool.description).not.toContain("node_exec");
    expect(tool.description).toContain("bound skills: GPU FAQ guide");
    expect(tool.description).toContain("bound knowledge bases: Product FAQ");
    expect(tool.description).toContain("bound MCP servers: Ticket service");
    expect(tool.description).toContain("not proof of live tool health");
  });
  it("uses restricted Custom capabilities instead of guessing from its name", () => {
    const tool = createTransferToAgentTool(refs({ handoffTargets: [target({ agentType: "custom", toolCapabilities: ["read_files"] })] }));
    expect(tool.description).toContain("knowledge_search");
    expect(tool.description).not.toContain("node_exec");
  });
  it.each([undefined, "future_type", "custom"])("does not infer unrestricted capabilities from missing metadata: %s", (agentType) => {
    const tool = createTransferToAgentTool(refs({ handoffTargets: [target({ agentType })] }));
    expect(tool.description).toContain("built-in capabilities: unknown");
    expect(tool.description).not.toContain("legacy Custom defaults");
  });
  it("marks failed resource lookup as unknown instead of no bound resources", () => {
    const tool = createTransferToAgentTool(refs({ handoffTargets: [target({ resourcesResolved: false, clusters: [], hosts: [] })] }));
    expect(tool.description).toContain("configured resources: unknown");
    expect(tool.description).not.toContain("bound clusters/hosts: none");
  });
  it("bounds capability binding lists and reports omitted entries", () => {
    const tool = createTransferToAgentTool(refs({ handoffTargets: [target({ skills: Array.from({ length: 60 }, (_, i) => `skill-${i}`) })] }));
    expect(tool.description).toContain("(+36 more)");
    expect(tool.description).not.toContain("skill-59");
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
