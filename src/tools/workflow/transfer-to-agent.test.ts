import { describe, expect, it, vi } from "vitest";
import { createTransferToAgentTool, registration } from "./transfer-to-agent.js";
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

  // 丢缓存失败不影响这次交接:下一轮回灌会覆盖。
  it("丢缓存失败不让交接失败", async () => {
    const emit = vi.fn();
    const tool = createTransferToAgentTool(refs({
      sessionEventEmitter: emit,
      evictSessionContext: async () => { throw new Error("disk gone"); },
    }));
    const out = await tool.execute!("call-1", { route_key: "cn", brief: "b" }, undefined as never);
    expect(emit).toHaveBeenCalledTimes(1);
    expect((out as { details: { transferred: boolean } }).details.transferred).toBe(true);
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
