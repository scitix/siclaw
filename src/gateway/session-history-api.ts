/**
 * GET /api/internal/session-history?sessionId=… — 把控制面里一段会话的**全部**记录
 * 拉回来给 agentbox,从旧到新。
 *
 * 这是 checkpointer 模式里「worker 冷启动从外置存储加载」的 gateway 侧。控制面的
 * `chat.getMessages` 是分页的(按 seq 倒序、一页 limit 条、`before` 游标),翻页的
 * 语义留在这一层,box 拿到的就是一段完整的历史。
 *
 * 授权在控制面:`chat.getMessages` 自己跑 `ensureChatSessionOnRuntime`,一个 Runtime
 * 只能读它有权触碰的会话。这里只做调用方身份存在性检查(mTLS),不重复判定。
 */
import http from "node:http";
import type { CertificateIdentity } from "./security/cert-manager.js";
import { getMessages, type StoredMessage } from "./chat-repo.js";
import type { RehydrateRow } from "../shared/session-rehydrate.js";
import type { SessionHistoryResponse } from "../shared/session-history.js";

/** 一页多少行。与 chat-repo 的默认一致;越大翻页越少,但单次 RPC 载荷越大。 */
export const HISTORY_PAGE_SIZE = 200;
/** 翻页上限。一段会话不该有几万行;到了这个数说明游标没前进,宁可截断也不无限循环。 */
export const HISTORY_MAX_PAGES = 100;

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function toRow(m: StoredMessage): RehydrateRow {
  return {
    role: m.role,
    content: m.content,
    toolName: m.toolName,
    toolInput: m.toolInput,
    outcome: m.outcome,
    createdAt: m.createdAt.toISOString(),
  };
}

/**
 * 翻页取全量,从旧到新。
 *
 * `getMessages` 每页按 seq 倒序取、页内 reverse 成从旧到新;下一页的游标是本页最旧
 * 一行的 `createdAt`。控制面按 `seq < MIN(seq WHERE created_at >= cursor)` 切,切点
 * 是 seq 不是时间戳,所以同一秒内的行既不会重复也不会漏 —— 这一点值得记,因为
 * `created_at` 在两种数据库引擎上都只有秒级精度。
 */
export async function loadFullHistory(
  sessionId: string,
  fetchPage: (sessionId: string, opts?: { before?: Date; limit?: number }) => Promise<StoredMessage[]> = getMessages,
): Promise<RehydrateRow[]> {
  const pages: StoredMessage[][] = [];
  let before: Date | undefined;
  for (let i = 0; i < HISTORY_MAX_PAGES; i += 1) {
    const page = await fetchPage(sessionId, { before, limit: HISTORY_PAGE_SIZE });
    if (page.length === 0) break;
    pages.push(page);
    if (page.length < HISTORY_PAGE_SIZE) break;
    const oldest = page[0].createdAt;
    // 游标必须前进。同一时间戳再取一页拿到的会是同一页 —— 见上面的切点说明,
    // 正常不会发生;真发生了就停,截断比死循环好。
    if (before && oldest.getTime() >= before.getTime()) break;
    before = oldest;
  }
  // 页是从新到旧取的,每页内部从旧到新;整体要从旧到新,把页序反过来再拍平。
  return pages.reverse().flat().map(toRow);
}

export async function handleSessionHistory(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  _identity: CertificateIdentity,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://internal");
  const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
  if (!sessionId) {
    sendJson(res, 400, { error: "sessionId is required" });
    return;
  }
  try {
    const messages = await loadFullHistory(sessionId);
    sendJson(res, 200, { sessionId, messages } satisfies SessionHistoryResponse);
  } catch (err) {
    console.error(`[session-history] failed to load history for ${sessionId}:`, err);
    sendJson(res, 502, { error: "could not load session history from the control plane" });
  }
}
