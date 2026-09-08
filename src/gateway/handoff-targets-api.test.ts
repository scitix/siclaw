import { describe, expect, it, vi } from "vitest";
import http from "node:http";
import { Readable } from "node:stream";
import { handleHandoffTargets, handleHandoffSearch } from "./handoff-targets-api.js";
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


function queryRequest(body: unknown) {
  return Readable.from([JSON.stringify(body)]) as unknown as http.IncomingMessage;
}
describe("POST handoff discovery", () => {
  it("uses authenticated identity, whitelists query fields, and forwards pagination", async () => {
    const request=vi.fn(async()=>({targets:[],total:0}));const {res,out}=fakeRes();
    await handleHandoffSearch(queryRequest({agentId:"foreign",kind:"host",query:"10.0.0.9",limit:2,offset:4}),res,identity,{request} as never);
    expect(request).toHaveBeenCalledWith("config.searchHandoffTargets",{agentId:"agent-facade",kind:"host",query:"10.0.0.9",limit:2,offset:4});
    expect(out).toEqual({status:200,body:{targets:[],total:0}});
  });
  it.each([{kind:"host",query:""},{kind:"all",query:"x"},{kind:"cluster",query:"x",limit:1000},{kind:"host",query:"x",offset:-1}])("rejects invalid queries before calling control plane: %j",async body=>{
    const request=vi.fn();const {res,out}=fakeRes();
    await handleHandoffSearch(queryRequest(body),res,identity,{request} as never);
    expect(out.status).toBe(400);expect(request).not.toHaveBeenCalled();
  });
  it("caps request size", async()=>{
    const request=vi.fn();const {res,out}=fakeRes();
    await handleHandoffSearch(queryRequest({kind:"host",query:"x".repeat(9000)}),res,identity,{request} as never);
    expect(out.status).toBe(413);expect(request).not.toHaveBeenCalled();
  });
  it("returns an error instead of an empty match when the control plane lacks the RPC", async()=>{
    const {res,out}=fakeRes();
    await handleHandoffSearch(queryRequest({kind:"cluster",query:"roce-test"}),res,identity,{request:async()=>{throw Error("unknown RPC")}} as never);
    expect(out.status).toBe(502);
  });
  it("requests an asset-free index at session construction", async()=>{
    const request=vi.fn(async()=>({targets:[],facadeAgentId:""}));const {res}=fakeRes();
    await handleHandoffTargets({url:"/api/internal/handoff-targets?indexOnly=true"} as http.IncomingMessage,res,identity,{request} as never);
    expect(request).toHaveBeenCalledWith("config.getHandoffTargets",{agentId:"agent-facade",indexOnly:true});
  });
});


it("preserves UTF-8 resource names across request chunks", async () => {
  const request=vi.fn(async()=>({targets:[],total:0})); const {res,out}=fakeRes();
  const body=Buffer.from(JSON.stringify({kind:"cluster",query:"上海集群"}));
  const chunks=Array.from(body, byte=>Buffer.from([byte]));
  await handleHandoffSearch(Readable.from(chunks) as unknown as http.IncomingMessage,res,identity,{request} as never);
  expect(out.status).toBe(200);
  expect(request).toHaveBeenCalledWith("config.searchHandoffTargets",expect.objectContaining({query:"上海集群"}));
});
