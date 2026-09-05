/**
 * GET /api/internal/handoff-targets — 这个 agent 可以把会话交给谁。
 *
 * 目标名单由控制面出(`config.getHandoffTargets`),这里只做转发。**不接受调用方
 * 指名 agentId**:名单是照 mTLS 证书里的身份取的,和 `/api/internal/delegates`
 * 一样 —— 一个 box 只能问「我能交给谁」,不能问「别人能交给谁」。
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
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const data = await frontendClient.request("config.getHandoffTargets", {
      agentId: identity.agentId,
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
