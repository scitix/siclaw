/**
 * 把控制面持久化的会话记录还原成 pi-agent 的消息序列。
 *
 * ⚠️ **这是「一个 agent 每轮可能换一个 agentbox 执行」的前提。**
 * agentbox 恢复历史只看**本 pod 本地**的 JSONL(`hasRestorableSessionContext`),
 * 并且 fail closed。所以一段对话第二轮落到另一个 pod 上时,那里没有这个目录 ——
 * 它会开一个全新会话,前面说过的话一个字都看不到,而且不报错。回灌就是补这一段。
 *
 * ## 两侧的形状不是一一对应的
 *
 * 控制面按**行**存,一次工具调用是**一行** `role='tool'`(带 tool_name /
 * tool_input / content / outcome);而 pi 侧一次工具调用是**两条**消息:一条带
 * `ToolCall` 的 assistant,加一条 `toolResult`。所以转换不是逐行映射:
 *
 * ```
 *   role=user      →  UserMessage
 *   role=assistant →  AssistantMessage{ content:[TextContent] }
 *   role=tool      →  AssistantMessage{ content:[ToolCall] } + ToolResultMessage
 * ```
 *
 * ## ⚠️ 两样东西控制面没存,只能合成
 *
 * 1. **toolCallId**。工具行的 metadata 里没有它(实测:只有 exitCode / status /
 *    duration 之类)。而 pi 侧 `ToolResultMessage.toolCallId` 必须与前面那条
 *    assistant 的 `ToolCall.id` 对上,否则这一对在上下文里接不起来。这里按**行的
 *    顺序**当场生成一个 id 并同时用在两条消息上 —— 配对关系来自"它们本来就是同
 *    一行",不依赖任何存下来的值。
 * 2. **assistant 的 api / provider / model / usage / stopReason**。这几个在 pi 的
 *    类型里是必填,而控制面的 assistant 行 metadata 常常是 NULL。这里填占位值。
 *    ⚠️ 占位值**只**用于把历史喂回模型上下文,**绝不能**被当成计费或可观测的数据源
 *    —— 真实的用量在控制面自己的记录里。`REHYDRATED_MODEL` 就是给这件事留的记号。
 *
 * 纯函数、无 IO,所以每条规则都能单测。放在 `shared/` 是因为 agentbox 镜像只
 * COPY 了 `src/{agentbox,core,cron,knowledge,memory,shared,tools}` —— 从
 * `src/gateway/` import 会让镜像构建失败(见 agentbox-image-boundary.test.ts)。
 */

/** 控制面一行会话记录里,回灌用得上的字段。 */
export interface RehydrateRow {
  role: string;
  content: string;
  toolName?: string | null;
  toolInput?: string | null;
  outcome?: string | null;
  createdAt?: Date | string | null;
}

/** 占位 model 标记:凡是带着它的 assistant 消息都是回灌出来的,不是真实调用。 */
export const REHYDRATED_MODEL = "rehydrated-from-control-plane";

type TextContent = { type: "text"; text: string };
type ToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

/**
 * pi 的 `Message` 联合。这里**刻意重新声明而不是 import**:
 * `@earendil-works/pi-ai` 的类型只在 agentbox 侧装得到,而这个模块要能被两侧
 * 以及测试直接用。字段是子集,但每个都逐字对齐上游 —— 改名即断,且不会报错。
 */
export type RehydratedMessage =
  | { role: "user"; content: string; timestamp: number }
  | {
      role: "assistant";
      content: (TextContent | ToolCall)[];
      api: string;
      provider: string;
      model: string;
      usage: {
        input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
        cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
      };
      stopReason: "stop" | "toolUse";
      timestamp: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: TextContent[];
      isError: boolean;
      timestamp: number;
    };

const ZERO_USAGE = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function tsOf(row: RehydrateRow): number {
  const raw = row.createdAt;
  if (!raw) return 0;
  const d = raw instanceof Date ? raw : new Date(raw);
  const ms = d.getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** 工具行的 outcome → 是否失败。未知值按**成功**处理:把一次成功的调用标成失败,
 *  会让模型以为那条路走不通而改道,比丢掉 outcome 更糟。 */
function isErrorOutcome(outcome?: string | null): boolean {
  const o = (outcome ?? "").trim().toLowerCase();
  return o === "error" || o === "failed" || o === "failure";
}

/** tool_input 是存下来的 JSON 字符串;坏值不能让整段历史回灌失败。 */
function parseArgs(raw?: string | null): Record<string, unknown> {
  const s = (raw ?? "").trim();
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : { input: s };
  } catch {
    // 不是 JSON 就原样带过去 —— 参数的**内容**对模型仍有意义,丢掉才是损失。
    return { input: s };
  }
}

/**
 * 转换一段会话记录。入参必须是**从旧到新**排好序的(控制面的
 * `chat.getMessages` 每页内部已经 reverse 过)。
 *
 * `idFor` 只为可测性存在:默认按序号生成稳定 id,测试可以注入。
 */
export function toRehydratedMessages(
  rows: RehydrateRow[],
  idFor: (index: number) => string = (i) => `rehydrated-${i}`,
): RehydratedMessage[] {
  const out: RehydratedMessage[] = [];
  rows.forEach((row, i) => {
    const timestamp = tsOf(row);
    const role = (row.role ?? "").trim().toLowerCase();

    if (role === "user") {
      // 空的 user 行不产出消息:pi 侧一条空 user 消息会占一个真实的对话轮次。
      if (!row.content?.trim()) return;
      out.push({ role: "user", content: row.content, timestamp });
      return;
    }

    if (role === "tool") {
      const name = (row.toolName ?? "").trim();
      // 没有工具名的 tool 行无法配对,跳过而不是造一个匿名调用。
      if (!name) return;
      const callId = idFor(i);
      out.push({
        role: "assistant",
        content: [{ type: "toolCall", id: callId, name, arguments: parseArgs(row.toolInput) }],
        api: "rehydrated", provider: "rehydrated", model: REHYDRATED_MODEL,
        usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
        stopReason: "toolUse",
        timestamp,
      });
      out.push({
        role: "toolResult",
        toolCallId: callId,
        toolName: name,
        content: [{ type: "text", text: row.content ?? "" }],
        isError: isErrorOutcome(row.outcome),
        timestamp,
      });
      return;
    }

    // assistant,以及任何其它角色(error 等)都按 assistant 文本还原 —— 它们在
    // 对话里就是"模型说过的话",丢掉会让后面的追问失去指代。
    if (!row.content?.trim()) return;
    out.push({
      role: "assistant",
      content: [{ type: "text", text: row.content }],
      api: "rehydrated", provider: "rehydrated", model: REHYDRATED_MODEL,
      usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
      stopReason: "stop",
      timestamp,
    });
  });
  return out;
}
