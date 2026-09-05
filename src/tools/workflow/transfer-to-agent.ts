/**
 * transfer_to_agent —— 把这段对话**交给**另一个 agent,不是委托给它。
 *
 * 与 delegate_to_agent 的分别是整件事的关键,不是措辞:
 *
 * - 委托是一次调用。coordinator 问 peer、拿回一份结论、这一轮还在 coordinator
 *   手上,用户看到一张"专家协作"卡片。
 * - 交接是一次移交。目标 agent 从此就是这段对话的负责人,直接回答用户,发起方
 *   退出对话 —— 直到有人再交回来。没有卡片、没有结论要复述、没有第二个身份。
 *
 * 为什么需要它:一个网络区一个 agent(某个区的集群 API、主机 SSH、内网 MCP、模型
 * 端点,只有泡在那个区里的 box 到得了),但对用户只有一个 agent。facade 接第一轮,
 * 判断目标资源归哪个区,交过去。
 *
 * **终止型工具**,形状照 request_input:发一条 `handoff_requested` control 帧、
 * 丢掉本 box 的本地会话状态、结束这一轮。三步的顺序有讲究:
 *
 * 1. 发帧。走 control 通道(控制面的 controlEventTypes),不是尽力而为的事件通道
 *    —— 掉一帧就是"这一轮结束了但没人接手",用户看到的是 agent 突然不说话了。
 * 2. **不自己翻 active_agent_id。** 翻状态的只有控制面一个写入方,而且它翻之前要
 *    拿名册校验目标。这里翻,等于让工具自己给自己授权。
 * 3. 丢弃本地缓存(不变量 4:本地历史是缓存,控制面才是权威)。这一步永远安全 ——
 *    就算控制面随后翻状态失败,下一轮也只是一次冷启动全量回灌,不会丢东西。
 *
 * 只在 web 模式出现(web / api / a2a 三种入口都跑在 web 模式下)。channel 的 turn
 * 在 runtime 本地跑、不经网关,没有人接住那条帧去做链式转发,给了就是一个静默的
 * 空操作。委托来的 turn 也不给:一个 peer 没有资格处置 coordinator 的会话。
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderTextResult } from "../infra/tool-render.js";
import type { ToolEntry, ToolRefs } from "../../core/tool-registry.js";
import type { HandoffTarget } from "../../shared/agent-handoff.js";

interface TransferParams {
  route_key?: string;
  brief?: string;
}

function result(text: string, transferred: boolean) {
  return {
    content: [{ type: "text" as const, text }],
    details: { transferred },
  };
}

/**
 * 一行目标。这里**列出覆盖的集群 / 主机名**,与 delegate_to_agent 只给计数相反 ——
 * 因为交接的判断依据就是"这台机器归哪个区",没有名字这个决定做不了,而且交接目标
 * 是个位数(每个 facade 几个区),不是几百个 peer。超出上限就截断并说明,免得把
 * 一个绑了几百台主机的 agent 的清单塞进每一轮的常驻上下文。
 */
const COVERAGE_LIMIT = 24;

function coverageOf(t: HandoffTarget): string {
  const names = [...t.clusters, ...t.hosts];
  if (names.length === 0) return "no bound resources";
  const shown = names.slice(0, COVERAGE_LIMIT).join(", ");
  return names.length > COVERAGE_LIMIT ? `${shown} … (+${names.length - COVERAGE_LIMIT} more)` : shown;
}

function targetLine(t: HandoffTarget): string {
  const desc = t.description ? ` — ${t.description}` : "";
  const back = t.isFacade ? " (hand the conversation BACK here when the work leaves your region)" : "";
  return `- ${t.routeKey}: ${t.name}${desc}${back}\n  covers: ${coverageOf(t)}`;
}

export function createTransferToAgentTool(refs: ToolRefs): ToolDefinition {
  const targets = refs.handoffTargets ?? [];
  const menu = targets.map(targetLine).join("\n");
  const keys = targets.map((t) => t.routeKey);
  return {
    name: "transfer_to_agent",
    label: "Transfer Conversation",
    renderCall: (_a, theme) => new Text(theme.fg("toolTitle", theme.bold("transfer_to_agent")), 0, 0),
    renderResult: renderTextResult,
    description:
      "Hand this conversation over to the agent that can actually reach the target resource. Use it when the " +
      "cluster, host or service the user is asking about is covered by one of the destinations below rather " +
      "than by you — you cannot reach their networks, and a tool call against them will simply fail.\n\n" +
      "This is a TRANSFER, not a delegation: after you call this, the destination owns the conversation and " +
      "answers the user directly. You will not be asked to summarise anything, and there is no result coming " +
      "back to you. So: call this INSTEAD of answering, not after answering. Do not tell the user you are " +
      "transferring them and do not say goodbye — they see one continuous conversation and a visible handover " +
      "would only confuse them. Say nothing else in this turn; end it right after the call.\n\n" +
      "`brief` is what the destination reads as its instruction. It has the full conversation history, so do " +
      "not retell it — state what needs doing and anything you already established (the exact cluster/host, " +
      "what you already ruled out).\n\n" +
      "Destinations:\n" + (menu || "(none)"),
    parameters: Type.Object({
      route_key: keys.length
        ? Type.Union(keys.map((k) => Type.Literal(k)), {
            description: "Which destination to hand the conversation to — the key from the list above.",
          })
        : Type.String({ description: "Which destination to hand the conversation to." }),
      brief: Type.String({
        minLength: 1,
        description:
          "The instruction for the destination agent: what to do, plus the specific entities and anything you " +
          "have already established. Not a recap of the conversation — it can see that.",
      }),
    }),
    async execute(_toolCallId, rawParams) {
      const params = rawParams as TransferParams;
      const routeKey = params.route_key?.trim() ?? "";
      const brief = params.brief?.trim() ?? "";
      if (!refs.sessionEventEmitter || targets.length === 0) {
        return result("transfer_to_agent is not available in this context.", false);
      }
      if (!routeKey || !brief) {
        return result("transfer_to_agent requires both `route_key` and `brief`.", false);
      }
      const target = targets.find((t) => t.routeKey.toLowerCase() === routeKey.toLowerCase());
      if (!target) {
        return result(
          `"${routeKey}" is not one of your destinations. Available: ${keys.join(", ")}.`,
          false,
        );
      }

      refs.sessionEventEmitter({ type: "handoff_requested", targetAgentId: target.id, brief });

      // 丢掉本地副本。交出去之后这个 box 对这段会话不再有发言权,留着只会在它某天
      // 又被交回来时,拿一份缺了中间几轮的陈旧上下文去接 —— 而控制面那边是全的。
      // 尽力而为:丢不掉也不影响这次交接,下一轮回灌会覆盖。
      try {
        await refs.evictSessionContext?.();
      } catch (err) {
        console.warn("[transfer_to_agent] could not evict the local session context:", err);
      }

      return result(
        `Conversation handed to ${target.name}. End your turn now — say nothing further; they answer the user from here.`,
        true,
      );
    },
  };
}

export const registration: ToolEntry = {
  category: "workflow",
  create: createTransferToAgentTool,
  // web 模式 = web / api / a2a 三种入口。channel 与 task 排除在外:它们没有网关链式
  // 转发接住那条帧(见文件头)。
  modes: ["web"],
  available: (refs) =>
    Boolean(refs.sessionEventEmitter && (refs.handoffTargets?.length ?? 0) > 0 && !refs.delegation),
  requiresUserApproval: false,
};
