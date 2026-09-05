/**
 * box ↔ gateway 契约:把控制面里一段会话的全部记录拉回 agentbox。
 *
 *   box → gateway:  GET /api/internal/session-history?sessionId=…  → SessionHistoryResponse
 *
 * 这是 checkpointer 模式里「worker 冷启动从外置存储加载」那一步。agentbox 恢复历史
 * 只看本 pod 本地的 JSONL;一段对话第二轮落到另一个 pod(换 agent、换副本、pod 重启)
 * 时本地是空的,这条接口是它取回上下文的唯一通道。
 *
 * 响应是**全量、从旧到新**:gateway 负责翻页,box 不需要知道控制面的分页语义。
 */
import type { RehydrateRow } from "./session-rehydrate.js";

export const SESSION_HISTORY_PATH = "/api/internal/session-history";

export interface SessionHistoryResponse {
  sessionId: string;
  /** 从旧到新。空数组表示控制面里这段会话还没有任何记录(全新会话)。 */
  messages: RehydrateRow[];
}
