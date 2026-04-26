import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import {
  handleSettings,
  handleMcpServers,
  handleSkillsBundle,
  handleKnowledgeBundle,
  handleAgentTasksList,
  handleAgentTasksCreate,
  handleAgentTasksUpdate,
  handleAgentTasksDelete,
} from "./internal-api.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { CertificateIdentity } from "./security/cert-manager.js";

// ── fakes ─────────────────────────────────────────────────

class FakeReq extends EventEmitter {
  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    const self = this;
    return (async function* (): AsyncGenerator<Buffer> {
      for (const chunk of self._chunks) yield chunk;
    })();
  }
  _chunks: Buffer[] = [];
  constructor(body: string) {
    super();
    if (body) this._chunks.push(Buffer.from(body));
  }
}

class FakeRes {
  statusCode = 0;
  headers: Record<string, string | number> = {};
  body = "";
  writeHead(status: number, headers: Record<string, string | number>): this {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }
  end(data?: string): void { if (data) this.body = data; }
}

function asReq(r: FakeReq): http.IncomingMessage {
  return r as unknown as http.IncomingMessage;
}
function asRes(r: FakeRes): http.ServerResponse {
  return r as unknown as http.ServerResponse;
}

const identity: CertificateIdentity = {
  agentId: "agent-1",
  orgId: "org-1",
  boxId: "box-1",
  env: "dev",
  issuedAt: new Date(),
  expiresAt: new Date(),
};

class FakeFrontendClient {
  calls: Array<{ method: string; params: any }> = [];
  responses = new Map<string, unknown>();
  nextError: Error | null = null;
  request(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params });
    if (this.nextError) {
      const err = this.nextError; this.nextError = null;
      return Promise.reject(err);
    }
    return Promise.resolve(this.responses.get(method) ?? {});
  }
}

let frontend: FakeFrontendClient;

beforeEach(() => {
  frontend = new FakeFrontendClient();
});

// ── handleSettings ────────────────────────────────────────

describe("handleSettings", () => {
  it("200 with proxied payload and correct RPC params", async () => {
    frontend.responses.set("config.getSettings", { models: [{ id: "m" }] });
    const res = new FakeRes();
    await handleSettings(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ models: [{ id: "m" }] });
    expect(frontend.calls[0].params).toEqual({ agentId: "agent-1", orgId: "org-1" });
  });

  it("500 when RPC fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    frontend.nextError = new Error("down");
    const res = new FakeRes();
    await handleSettings(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(500);
    errSpy.mockRestore();
  });
});

// ── handleMcpServers ──────────────────────────────────────

describe("handleMcpServers", () => {
  it("short-circuits with empty mcpServers when agent has no mcp ids", async () => {
    frontend.responses.set("config.getResources", { mcp_server_ids: [] });
    const res = new FakeRes();
    await handleMcpServers(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ mcpServers: {} });
  });

  it("queries config.getMcpServers with the bound ids", async () => {
    frontend.responses.set("config.getResources", { mcp_server_ids: ["m1", "m2"] });
    frontend.responses.set("config.getMcpServers", { mcpServers: { m1: { url: "x" } } });
    const res = new FakeRes();
    await handleMcpServers(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(200);
    expect(frontend.calls[1].params).toEqual({ agentId: "agent-1", ids: ["m1", "m2"] });
    expect(JSON.parse(res.body).mcpServers.m1).toEqual({ url: "x" });
  });

  it("500 on upstream failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    frontend.responses.set("config.getResources", { mcp_server_ids: ["x"] });
    frontend.nextError = null;
    // First call succeeds, second must fail. Override by mocking method dispatch:
    const origRequest = frontend.request.bind(frontend);
    frontend.request = vi.fn(async (m: string, p: any) => {
      if (m === "config.getMcpServers") throw new Error("upstream dead");
      return origRequest(m, p);
    }) as any;
    const res = new FakeRes();
    await handleMcpServers(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(500);
    errSpy.mockRestore();
  });

  it("returns 500 when config.getResources itself fails (regression guard: no silent empty)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    frontend.request = vi.fn(async (m: string) => {
      if (m === "config.getResources") throw new Error("FrontendWsClient disconnected");
      return {};
    }) as typeof frontend.request;
    const res = new FakeRes();
    await handleMcpServers(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(500);
    errSpy.mockRestore();
  });
});

// ── handleSkillsBundle ────────────────────────────────────

describe("handleSkillsBundle", () => {
  it("forwards skill_ids + is_production to config.getSkillBundle", async () => {
    frontend.responses.set("config.getResources", { skill_ids: ["s1", "s2"], is_production: false });
    frontend.responses.set("config.getSkillBundle", { skills: [{ id: "s1" }] });
    const res = new FakeRes();
    await handleSkillsBundle(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(200);
    const call = frontend.calls.find((c) => c.method === "config.getSkillBundle");
    expect(call!.params).toEqual({ agentId: "agent-1", skill_ids: ["s1", "s2"], is_production: false });
  });

  it("returns 500 — NOT an empty bundle — when config.getResources fails (regression guard)", async () => {
    // Historic silent-failure: a catch returned { skillIds: [] } on any RPC
    // error, so a momentary WS blip wiped the agentbox's resolved/ skills dir
    // via an empty config.getSkillBundle response. Handler must propagate the
    // error so agentbox's reload handler leaves resolved/ untouched.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    frontend.request = vi.fn(async (m: string) => {
      if (m === "config.getResources") throw new Error("FrontendWsClient disconnected");
      return {};
    }) as typeof frontend.request;
    const res = new FakeRes();
    await handleSkillsBundle(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(500);
    // Must NOT have called config.getSkillBundle with empty ids after failure.
    expect((frontend.request as any).mock.calls.find((c: any[]) => c[0] === "config.getSkillBundle")).toBeUndefined();
    errSpy.mockRestore();
  });
});

// ── handleKnowledgeBundle ────────────────────────────────

describe("handleKnowledgeBundle", () => {
  it("proxies to config.getKnowledgeBundle with agentId", async () => {
    frontend.responses.set("config.getKnowledgeBundle", { packages: [] });
    const res = new FakeRes();
    await handleKnowledgeBundle(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(frontend.calls[0].params).toEqual({ agentId: "agent-1" });
    expect(res.statusCode).toBe(200);
  });
});

// ── agent tasks: list ────────────────────────────────────

describe("handleAgentTasksList", () => {
  it("200 with tasks mapped to camelCase fields + agentId from identity", async () => {
    frontend.responses.set("task.list", {
      tasks: [
        { id: "t1", name: "n", schedule: "* * * * *", status: "active",
          description: null, prompt: "p", last_run_at: null, last_result: null },
      ],
    });
    const res = new FakeRes();
    await handleAgentTasksList(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    const out = JSON.parse(res.body);
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0].agentId).toBe("agent-1");
    expect(out.tasks[0].lastRunAt).toBeNull();
  });
});

// ── agent tasks: create ──────────────────────────────────

describe("handleAgentTasksCreate", () => {
  it("400 when required fields missing", async () => {
    const res = new FakeRes();
    await handleAgentTasksCreate(
      asReq(new FakeReq(JSON.stringify({ name: "only name" }))),
      asRes(res), identity, frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(400);
  });

  it("400 when schedule is invalid", async () => {
    const res = new FakeRes();
    await handleAgentTasksCreate(
      asReq(new FakeReq(JSON.stringify({ name: "n", schedule: "not-cron", prompt: "p" }))),
      asRes(res), identity, frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/schedule|Invalid/i);
  });

  it("201 on success, sends task.create with agent_id + user_id resolved from session registry", async () => {
    const { sessionRegistry } = await import("./session-registry.js");
    sessionRegistry.remember("sess-task", "u1", "agent-1");
    frontend.responses.set("task.create", { id: "t-created" });
    const res = new FakeRes();
    await handleAgentTasksCreate(
      asReq(new FakeReq(JSON.stringify({ name: "n", schedule: "*/5 * * * *", prompt: "p", session_id: "sess-task" }))),
      asRes(res), identity, frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(201);
    expect(frontend.calls[0].method).toBe("task.create");
    expect(frontend.calls[0].params.agent_id).toBe("agent-1");
    expect(frontend.calls[0].params.user_id).toBe("u1");    // resolved from registry
    expect(frontend.calls[0].params.status).toBe("active"); // default
    sessionRegistry.forget("sess-task");
  });

  it("task.create falls back to empty user_id when session_id is missing", async () => {
    frontend.responses.set("task.create", { id: "t-created" });
    const res = new FakeRes();
    await handleAgentTasksCreate(
      asReq(new FakeReq(JSON.stringify({ name: "n", schedule: "*/5 * * * *", prompt: "p" }))),
      asRes(res), identity, frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(201);
    expect(frontend.calls[0].params.user_id).toBe("");
  });
});

// ── agent tasks: update ──────────────────────────────────

describe("handleAgentTasksUpdate", () => {
  it("400 on invalid schedule", async () => {
    const res = new FakeRes();
    await handleAgentTasksUpdate(
      asReq(new FakeReq(JSON.stringify({ schedule: "not-a-cron" }))),
      asRes(res), identity, "task-1", frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when rpc payload has an error property", async () => {
    frontend.responses.set("task.update", { error: "Task not found" });
    const res = new FakeRes();
    await handleAgentTasksUpdate(
      asReq(new FakeReq(JSON.stringify({ name: "x" }))),
      asRes(res), identity, "missing", frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(404);
  });

  it("returns 200 with payload on success", async () => {
    frontend.responses.set("task.update", { ok: true });
    const res = new FakeRes();
    await handleAgentTasksUpdate(
      asReq(new FakeReq(JSON.stringify({ name: "new", status: "paused" }))),
      asRes(res), identity, "t1", frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(200);
    expect(frontend.calls[0].params.status).toBe("paused");
    expect(frontend.calls[0].params.task_id).toBe("t1");
  });

  it("ignores non-string body fields (defensive)", async () => {
    frontend.responses.set("task.update", { ok: true });
    const res = new FakeRes();
    await handleAgentTasksUpdate(
      asReq(new FakeReq(JSON.stringify({ name: 123, prompt: null }))),
      asRes(res), identity, "t1", frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(200);
    expect(frontend.calls[0].params.name).toBeUndefined();
    expect(frontend.calls[0].params.prompt).toBeUndefined();
  });
});

// ── agent tasks: delete ──────────────────────────────────

describe("handleAgentTasksDelete", () => {
  it("200 on success, user_id falls back to empty when no session_id query param", async () => {
    frontend.responses.set("task.delete", { ok: true });
    const res = new FakeRes();
    await handleAgentTasksDelete(
      asReq(new FakeReq("")), asRes(res), identity, "t1", frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(200);
    expect(frontend.calls[0].params).toEqual({ task_id: "t1", agent_id: "agent-1", user_id: "" });
  });

  it("resolves user_id from session_id query param when present", async () => {
    const { sessionRegistry } = await import("./session-registry.js");
    sessionRegistry.remember("sess-del", "u-owner", "agent-1");
    frontend.responses.set("task.delete", { ok: true });
    const res = new FakeRes();
    const req = new FakeReq("") as FakeReq & { url?: string };
    req.url = "/api/internal/agent-tasks/t1?session_id=sess-del";
    await handleAgentTasksDelete(
      asReq(req), asRes(res), identity, "t1", frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(200);
    expect(frontend.calls[0].params.user_id).toBe("u-owner");
    sessionRegistry.forget("sess-del");
  });

  it("404 when RPC returns error field", async () => {
    frontend.responses.set("task.delete", { error: "not found" });
    const res = new FakeRes();
    await handleAgentTasksDelete(
      asReq(new FakeReq("")), asRes(res), identity, "t1", frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(404);
  });

  it("500 on RPC throw", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    frontend.nextError = new Error("rpc dead");
    const res = new FakeRes();
    await handleAgentTasksDelete(
      asReq(new FakeReq("")), asRes(res), identity, "t1", frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(500);
    errSpy.mockRestore();
  });
});
