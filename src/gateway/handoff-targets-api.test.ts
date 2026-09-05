import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import { handleHandoffTargets } from "./handoff-targets-api.js";
import type { CertificateIdentity } from "./security/cert-manager.js";

function fakeRes() {
  const out = { status: 0, body: undefined as unknown };
  return {
    res: {
      writeHead(status: number) { out.status = status; },
      end(body: string) { out.body = JSON.parse(body); },
    } as unknown as http.ServerResponse,
    out,
  };
}

const identity = { agentId: "agent-facade" } as CertificateIdentity;

describe("GET /api/internal/handoff-targets", () => {
  // ⚠️ 名单照证书里的身份取,不接受调用方指名 —— 一个 box 只能问"我能交给谁"。
  it("按 mTLS 身份取名单,不看请求里的任何参数", async () => {
    const request = vi.fn(async () => ({ facadeAgentId: "agent-facade", targets: [] }));
    const { res, out } = fakeRes();

    await handleHandoffTargets(
      { url: "/api/internal/handoff-targets?agentId=someone-else" } as http.IncomingMessage,
      res,
      identity,
      { request } as never,
    );

    expect(request).toHaveBeenCalledWith("config.getHandoffTargets", { agentId: "agent-facade" });
    expect(out.status).toBe(200);
  });

  it("把控制面的 facadeAgentId 与 targets 原样带回", async () => {
    const targets = [{ id: "cn", name: "Siclaw (国内)", routeKey: "cn", description: "", isFacade: false, clusters: ["roce-test"], hosts: [] }];
    const { res, out } = fakeRes();

    await handleHandoffTargets(
      { url: "/api/internal/handoff-targets" } as http.IncomingMessage,
      res,
      identity,
      { request: async () => ({ facadeAgentId: "agent-facade", targets }) } as never,
    );

    expect(out.body).toEqual({ facadeAgentId: "agent-facade", targets });
  });

  // 普通 agent:控制面返回空,这里也返回空 —— box 据此不生成 transfer 工具。
  it("控制面什么都没给就返回空名单,而不是猜", async () => {
    const { res, out } = fakeRes();

    await handleHandoffTargets(
      { url: "/api/internal/handoff-targets" } as http.IncomingMessage,
      res,
      identity,
      { request: async () => ({}) } as never,
    );

    expect(out.body).toEqual({ facadeAgentId: "", targets: [] });
  });

  it("控制面出错答 502,不把错误当成空名单", async () => {
    const { res, out } = fakeRes();

    await handleHandoffTargets(
      { url: "/api/internal/handoff-targets" } as http.IncomingMessage,
      res,
      identity,
      { request: async () => { throw new Error("rpc down"); } } as never,
    );

    expect(out.status).toBe(502);
  });
});
