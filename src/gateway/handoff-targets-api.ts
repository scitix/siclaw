/**
 * GET /api/internal/handoff-targets — 这个 agent 可以把会话交给谁。
 *
 * indexOnly=true 请求只返回内部目标索引，不附带完整资产。
 * 目标名单由控制面出(`config.getHandoffTargets`),这里只做转发。**不接受调用方
 * 指名 agentId**:名单是照 mTLS 证书里的身份取的。一个 box 只能问「我能交给谁」,
 * 不能问「别人能交给谁」。
 *
 * 拿不到就当没有:名单为空 → transfer 工具整个不出现,这一轮退化成 facade 自己
 * 答,而不是长出一个会失败的工具。
 */
import http from "node:http";
import type { CertificateIdentity } from "./security/cert-manager.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { HandoffTarget, HandoffTargetsResponse } from "../shared/agent-handoff.js";

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function handleHandoffTargets(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const data = await frontendClient.request("config.getHandoffTargets", {
      agentId: identity.agentId,
      ...(new URL(req.url ?? "/", "http://localhost").searchParams.get("indexOnly") === "true" ? { indexOnly: true } : {}),
    }) as { facadeAgentId?: string; targets?: HandoffTarget[] };
    sendJson(res, 200, {
      facadeAgentId: data.facadeAgentId ?? "",
      targets: data.targets ?? [],
    } satisfies HandoffTargetsResponse);
  } catch (err) {
    console.error("[handoff-targets] error:", err);
    sendJson(res, 502, { error: "could not load handoff targets from the control plane" });
  }
}

/** POST discovery, bound to the authenticated caller rather than any body agentId. */
export async function handleHandoffSearch(
  req: http.IncomingMessage, res: http.ServerResponse,
  identity: CertificateIdentity, frontendClient: FrontendWsClient,
): Promise<void> {
  let query: import("../shared/agent-handoff.js").HandoffSearchQuery;
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 8192) { sendJson(res, 413, { error: "query too large" }); return; }
      chunks.push(buffer);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || !["cluster", "host", "capability", "agent"].includes(input.kind)
      || typeof input.query !== "string" || !input.query.trim() || [...input.query].length > 256
      || (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0))
      || (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 5))) {
      sendJson(res, 400, { error: "invalid handoff query" }); return;
    }
    query = { kind: input.kind, query: input.query.trim(), offset: input.offset ?? 0, limit: input.limit ?? 5 };
  } catch { sendJson(res, 400, { error: "invalid handoff query" }); return; }
  try {
    const result = await frontendClient.request("config.searchHandoffTargets", { ...query, agentId: identity.agentId });
    sendJson(res, 200, result);
  } catch {
    sendJson(res, 502, { error: "could not verify handoff coverage from the control plane" });
  }
}
