/**
 * 把一段回灌历史写成 pi-agent 能原生恢复的会话目录。
 *
 * 只走 `SessionManager` 的**公开 API**(`create` + `appendMessage`),不自己拼 JSONL:
 * 格式是那个包的内部实现,版本一升级就碎;而 append-only 树的公开面已经保证了
 * "顺序追加即线性历史"。写完之后 `SessionManager.continueRecent(cwd, sessionDir)`
 * 读回来的就是这段对话 —— 也就是 session.ts 里既有的恢复路径,一行不用改。
 *
 * ⚠️ `RehydratedMessage` 是 pi-ai `Message` 的结构子集,`api` / `provider` 填的是
 * 占位字符串而不是那两个字面量联合的成员。运行时不会校验它们:历史消息的这两个
 * 字段只随 JSONL 走一圈,后续模型调用用的是**当前**的模型配置。所以这里的类型断言
 * 是有意的;`session-rehydrate-store.test.ts` 用真实的 SessionManager 证明它能
 * 完整读回来。
 */
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { toRehydratedMessages, type RehydrateRow } from "../shared/session-rehydrate.js";

export interface RehydrateResult {
  /** 写入了多少条 pi 消息(tool 行会变成两条)。0 表示历史为空,没有创建任何文件。 */
  written: number;
}

/**
 * 把控制面的行写进 `sessionDir`。历史为空时**不创建**会话文件 —— 一个只有头的
 * JSONL 在 `hasRestorableSessionContext` 眼里仍然是"不可恢复",写了也白写,
 * 反而会让 `isNewSession` 的判断多一个歧义分支。
 */
export function writeRehydratedSession(cwd: string, sessionDir: string, rows: RehydrateRow[]): RehydrateResult {
  const messages = toRehydratedMessages(rows);
  if (messages.length === 0) return { written: 0 };
  const sm = SessionManager.create(cwd, sessionDir);
  for (const m of messages) {
    sm.appendMessage(m as unknown as Message);
  }
  return { written: messages.length };
}
