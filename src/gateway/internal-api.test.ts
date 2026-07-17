import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import http from "node:http";
import {
  handleSettings,
  handleTracingConfig,
  handleMcpServers,
  handleToolCapabilities,
  handleSkillsBundle,
  handleKnowledgeBundle,
  handleAgentTasksList,
  handleAgentTasksCreate,
  handleAgentTasksUpdate,
  handleAgentTasksDelete,
  handleDelegationEvents,
  handleMetricsFlush,
} from "./internal-api.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { CertificateIdentity } from "./security/cert-manager.js";
import { sessionRegistry } from "./session-registry.js";
import { PromFederationAggregator } from "./prom-federation-aggregator.js";
import {
  clearBackgroundChannelDelivery,
  registerBackgroundChannelDelivery,
} from "./channels/background-delivery.js";

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
  emitted: Array<{ event: string; payload: any }> = [];
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
  emitEvent(event: string, payload: any): void {
    this.emitted.push({ event, payload });
  }
}

let frontend: FakeFrontendClient;

beforeEach(() => {
  frontend = new FakeFrontendClient();
  sessionRegistry.forget("parent-1");
  sessionRegistry.forget("parent-other");
  sessionRegistry.forget("child-1");
  sessionRegistry.forget("channel-1");
  clearBackgroundChannelDelivery("channel-1");
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

// ── handleTracingConfig ───────────────────────────────────

describe("handleTracingConfig", () => {
  it("200 with proxied TracingConfig and calls config.getTracingConfig with NO agentId", async () => {
    frontend.responses.set("config.getTracingConfig", {
      enabled: true,
      serviceName: "siclaw-agentbox",
      sendContent: false,
      exporters: [{ url: "http://phoenix:6006/v1/traces", headers: {} }],
    });
    const res = new FakeRes();
    await handleTracingConfig(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).enabled).toBe(true);
    // Global config: must NOT be scoped to an agentId (would drop tracing for
    // agents without a bound provider).
    expect(frontend.calls[0].method).toBe("config.getTracingConfig");
    expect(frontend.calls[0].params).toEqual({});
  });

  it("500 when RPC fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    frontend.nextError = new Error("down");
    const res = new FakeRes();
    await handleTracingConfig(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
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

// ── handleToolCapabilities ────────────────────────────────

describe("handleToolCapabilities", () => {
  it("resolves the agent's capability groups to a concrete allowedTools list", async () => {
    frontend.responses.set("config.getAgent", { tool_capabilities: ["read_files", "search_memory"] });
    const res = new FakeRes();
    await handleToolCapabilities(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(new Set(body.allowedTools)).toEqual(
      new Set(["read", "grep", "find", "ls", "memory_search", "memory_get"]),
    );
    // agentId comes from the cert identity, never the body.
    expect(frontend.calls[0]).toEqual({ method: "config.getAgent", params: { agentId: "agent-1" } });
  });

  it("returns allowedTools:null for an agent with no capability selection (backward compat)", async () => {
    frontend.responses.set("config.getAgent", { tool_capabilities: null });
    const res = new FakeRes();
    await handleToolCapabilities(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ allowedTools: null, agentType: "custom" });
  });

  it("treats an empty selection as null (whitelist off)", async () => {
    frontend.responses.set("config.getAgent", { tool_capabilities: [] });
    const res = new FakeRes();
    await handleToolCapabilities(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(JSON.parse(res.body)).toEqual({ allowedTools: null, agentType: "custom" });
  });

  it("500 when the agent lookup fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    frontend.nextError = new Error("agent lookup down");
    const res = new FakeRes();
    await handleToolCapabilities(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
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

  it("403 when session_id resolves to a different agent — refuses to audit cross-agent attribution", async () => {
    const { sessionRegistry } = await import("./session-registry.js");
    // Register session under agent-2; the calling cert (identity) is agent-1.
    sessionRegistry.remember("sess-foreign", "u-other", "agent-2");
    frontend.responses.set("task.create", { id: "should-not-be-called" });
    const res = new FakeRes();
    await handleAgentTasksCreate(
      asReq(new FakeReq(JSON.stringify({ name: "n", schedule: "*/5 * * * *", prompt: "p", session_id: "sess-foreign" }))),
      asRes(res), identity, frontend as unknown as FrontendWsClient,
    );
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/ownership/i);
    // Critical: upstream RPC must NOT have been called with the foreign user's id.
    expect(frontend.calls.find(c => c.method === "task.create")).toBeUndefined();
    sessionRegistry.forget("sess-foreign");
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

// ── delegation persistence ───────────────────────────────

describe("handleDelegationEvents", () => {
  it("ensures a delegated session with explicit user ownership and lineage", async () => {
    sessionRegistry.remember("parent-1", "user-1", "agent-1");
    const res = new FakeRes();
    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.ensure_session",
        sessionId: "child-1",
        agentId: "agent-1",
        userId: "user-1",
        title: "Delegated investigation",
        preview: "scope",
        origin: "delegation",
        lineage: {
          parentSessionId: "parent-1",
          parentAgentId: "agent-1",
          delegationId: "delegation-1",
          targetAgentId: "agent-1",
        },
      }))),
      asRes(res),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    expect(res.statusCode).toBe(200);
    expect(frontend.calls[0]).toEqual({
      method: "chat.ensureSession",
      params: {
        session_id: "child-1",
        agent_id: "agent-1",
        user_id: "user-1",
        title: "Delegated investigation",
        preview: "scope",
        origin: "delegation",
        parent_session_id: "parent-1",
        parent_agent_id: "agent-1",
        delegation_id: "delegation-1",
        target_agent_id: "agent-1",
      },
    });
  });

  it("rejects delegated session creation without an explicit userId", async () => {
    const res = new FakeRes();
    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.ensure_session",
        sessionId: "child-1",
        agentId: "agent-1",
        userId: "",
      }))),
      asRes(res),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    expect(res.statusCode).toBe(400);
    expect(frontend.calls).toHaveLength(0);
  });

  it("rejects delegated writes for another agent identity", async () => {
    const res = new FakeRes();
    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.ensure_session",
        sessionId: "child-1",
        agentId: "agent-2",
        userId: "user-1",
      }))),
      asRes(res),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    expect(res.statusCode).toBe(403);
    expect(frontend.calls).toHaveLength(0);
  });

  it("rejects delegated writes targeting a parent session owned by another agent", async () => {
    sessionRegistry.remember("parent-other", "user-2", "agent-2");
    const res = new FakeRes();
    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.ensure_session",
        sessionId: "child-1",
        agentId: "agent-1",
        userId: "user-1",
        lineage: { parentSessionId: "parent-other", parentAgentId: "agent-1", targetAgentId: "agent-1" },
      }))),
      asRes(res),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    expect(res.statusCode).toBe(403);
    expect(frontend.calls).toHaveLength(0);
  });

  it("delivers background assistant messages to a registered channel even when Portal has no chat session", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    sessionRegistry.remember("channel-1", "lark:oc_1", "agent-1");
    const delivered: string[] = [];
    registerBackgroundChannelDelivery("channel-1", async (message) => {
      if ("content" in message) delivered.push(message.content);
      return true;
    });
    frontend.nextError = new Error("chat session not found");
    const res = new FakeRes();

    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.append_message",
        message: {
          sessionId: "channel-1",
          role: "assistant",
          content: "最终报告",
          fromAgentId: "agent-1",
          targetAgentId: "agent-1",
        },
      }))),
      asRes(res),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(delivered).toEqual(["最终报告"]);
    expect(frontend.calls[0].method).toBe("chat.appendMessage");
    warnSpy.mockRestore();
  });

  it("delivers explicit channel messages through the registered channel callback without Portal writes", async () => {
    sessionRegistry.remember("channel-1", "lark:oc_1", "agent-1");
    const delivered: Array<{ kind: string; text: string }> = [];
    registerBackgroundChannelDelivery("channel-1", async (message) => {
      if ("text" in message) delivered.push({ kind: message.kind, text: message.text });
      return true;
    });
    const res = new FakeRes();

    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "channel.deliver_message",
        message: {
          sessionId: "channel-1",
          kind: "milestone",
          text: "已完成节点列表检查。",
          fromAgentId: "agent-1",
        },
      }))),
      asRes(res),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(delivered).toEqual([{ kind: "milestone", text: "已完成节点列表检查。" }]);
    expect(frontend.calls).toHaveLength(0);
  });

  it("rejects explicit channel messages from another agent identity", async () => {
    sessionRegistry.remember("channel-1", "lark:oc_1", "agent-1");
    const delivered: string[] = [];
    registerBackgroundChannelDelivery("channel-1", async (message) => {
      if ("text" in message) delivered.push(message.text);
      return true;
    });
    const res = new FakeRes();

    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "channel.deliver_message",
        message: {
          sessionId: "channel-1",
          kind: "milestone",
          text: "should not deliver",
          fromAgentId: "agent-2",
        },
      }))),
      asRes(res),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toContain("source agent mismatch");
    expect(delivered).toHaveLength(0);
    expect(frontend.calls).toHaveLength(0);
  });
});

// ── handleMetricsFlush (module 5) ─────────────────────────

describe("handleMetricsFlush", () => {
  function counterFrame(value: number) {
    return [{ name: "siclaw_tokens_total", type: "counter" as const, values: [{ labels: { type: "input" }, value }] }];
  }
  function counterVal(fed: PromFederationAggregator) {
    const fam = fed.exportGroups().find((g) => g.name === "siclaw_tokens_total");
    return fam?.values.find((v) => String(v.labels.type) === "input")?.value;
  }

  it("ingests using boxId from the cert identity — NOT from the body", async () => {
    const fed = new PromFederationAggregator();
    const res = new FakeRes();
    // body tries to spoof a different box; handler must ignore it and use identity.boxId.
    await handleMetricsFlush(
      asReq(new FakeReq(JSON.stringify({ boxId: "spoofed-box", incarnation: "inc-1", prom: counterFrame(50) }))),
      asRes(res),
      identity, // identity.boxId === "box-1"
      fed,
    );
    expect(res.statusCode).toBe(200);
    expect(counterVal(fed)).toBe(50);

    // A subsequent pull from the REAL box-1 / inc-1 must be idempotent (delta 0),
    // proving the flush was keyed under box-1 (the cert), not "spoofed-box".
    fed.ingest("box-1", "inc-1", counterFrame(50));
    expect(counterVal(fed)).toBe(50);

    // Whereas the spoofed boxId was never used as a key:
    fed.ingest("spoofed-box", "inc-1", counterFrame(50));
    expect(counterVal(fed)).toBe(100); // counted as a fresh instance → +50
  });

  it("is idempotent: flush then pull of the same frame adds nothing", async () => {
    const fed = new PromFederationAggregator();
    const res = new FakeRes();
    await handleMetricsFlush(
      asReq(new FakeReq(JSON.stringify({ incarnation: "inc-9", prom: counterFrame(42) }))),
      asRes(res),
      identity,
      fed,
    );
    expect(counterVal(fed)).toBe(42);
    fed.ingest(identity.boxId, "inc-9", counterFrame(42)); // pull collision / retry
    expect(counterVal(fed)).toBe(42);
  });

  it("400 on malformed body (missing incarnation/prom)", async () => {
    const fed = new PromFederationAggregator();
    const res = new FakeRes();
    await handleMetricsFlush(
      asReq(new FakeReq(JSON.stringify({ prom: [] }))),
      asRes(res),
      identity,
      fed,
    );
    expect(res.statusCode).toBe(400);
  });

  it("increments flush self-monitoring counters", async () => {
    const fed = new PromFederationAggregator();
    let received = 0, errors = 0;
    const counters = {
      flushReceivedTotal: { inc: () => { received++; } },
      flushErrorsTotal: { inc: () => { errors++; } },
    };
    await handleMetricsFlush(
      asReq(new FakeReq(JSON.stringify({ incarnation: "inc-1", prom: counterFrame(5) }))),
      asRes(new FakeRes()), identity, fed, counters,
    );
    expect(received).toBe(1);
    expect(errors).toBe(0);

    await handleMetricsFlush(
      asReq(new FakeReq(JSON.stringify({ bad: true }))),
      asRes(new FakeRes()), identity, fed, counters,
    );
    expect(received).toBe(2);
    expect(errors).toBe(1);
  });
});
