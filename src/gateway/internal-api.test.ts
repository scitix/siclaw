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
  resolveFlushBoxId,
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
  it("resolves product_support as a locked read-only built-in harness", async () => {
    frontend.responses.set("config.getAgent", { agent_type: "product_support", tool_capabilities: ["run_commands"] });
    const res = new FakeRes();
    await handleToolCapabilities(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.agentType).toBe("product_support");
    expect(new Set(body.allowedTools)).toEqual(
      new Set(["read", "grep", "find", "ls", "knowledge_search", "knowledge_cite"]),
    );
  });

  it("resolves the agent's capability groups to a concrete allowedTools list", async () => {
    frontend.responses.set("config.getAgent", { agent_type: "custom", tool_capabilities: ["read_files", "search_memory"] });
    const res = new FakeRes();
    await handleToolCapabilities(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(new Set(body.allowedTools)).toEqual(
      new Set(["read", "grep", "find", "ls", "knowledge_search", "knowledge_cite", "memory_search", "memory_get"]),
    );
    // agentId comes from the cert identity, never the body.
    expect(frontend.calls[0]).toEqual({ method: "config.getAgent", params: { agentId: "agent-1" } });
  });

  it("returns allowedTools:null for an agent with no capability selection (backward compat)", async () => {
    frontend.responses.set("config.getAgent", { agent_type: "custom", tool_capabilities: null });
    const res = new FakeRes();
    await handleToolCapabilities(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(200);
    // subagentTierMenu is null when the agent configures no tiers — the payload
    // always carries the field so an empty one CLEARS whatever the box held.
    expect(JSON.parse(res.body)).toEqual({
      allowedTools: null,
      agentType: "custom",
      subagentTierMenu: null,
    });
  });

  it("treats an empty selection as null (whitelist off)", async () => {
    frontend.responses.set("config.getAgent", { agent_type: "custom", tool_capabilities: [] });
    const res = new FakeRes();
    await handleToolCapabilities(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    // subagentTierMenu is null when the agent configures no tiers — the payload
    // always carries the field so an empty one CLEARS whatever the box held.
    expect(JSON.parse(res.body)).toEqual({
      allowedTools: null,
      agentType: "custom",
      subagentTierMenu: null,
    });
  });

  it("500 when the agent lookup fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    frontend.nextError = new Error("agent lookup down");
    const res = new FakeRes();
    await handleToolCapabilities(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
    expect(res.statusCode).toBe(500);
    errSpy.mockRestore();
  });

  it.each([undefined, "", "future_type"])(
    "500 when agent_type is not an explicit supported type (%s)",
    async (agentType) => {
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      frontend.responses.set("config.getAgent", { agent_type: agentType, tool_capabilities: null });
      const res = new FakeRes();
      await handleToolCapabilities(asReq(new FakeReq("")), asRes(res), identity, frontend as unknown as FrontendWsClient);
      expect(res.statusCode).toBe(500);
      errSpy.mockRestore();
    },
  );
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

  it("accepts a delegated leg's own box, whose cert names the target rather than the owner", async () => {
    // A delegated leg stays owned by the coordinator that created it (agent-2) while
    // the turn runs in the delegated peer's box (agent-1 == the calling cert). Its
    // sub-agent transcript and task-ledger rows used to be refused outright here,
    // which is what left the leg pointing at sub-agent sessions that never existed.
    sessionRegistry.remember("parent-1", "user-1", "agent-2", "agent-1");
    const res = new FakeRes();
    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.ensure_session",
        sessionId: "child-1",
        agentId: "agent-1",
        userId: "user-1",
        origin: "subagent",
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
    expect(frontend.calls[0].method).toBe("chat.ensureSession");
  });

  it("refuses ensure_session ON a leg row it only executes, not owns", async () => {
    // parent-1 is the leg: owned by agent-2, delegated to agent-1 (the caller).
    // Writing BENEATH that leg is allowed; upserting the leg row ITSELF is not,
    // or a Portal whose upsert touches more than last_active_at would let the
    // peer re-point the leg's agent/parent/origin at itself.
    sessionRegistry.remember("parent-1", "user-1", "agent-2", "agent-1");
    const res = new FakeRes();
    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.ensure_session",
        sessionId: "parent-1",
        agentId: "agent-1",
        userId: "user-1",
        origin: "subagent",
        lineage: {
          parentSessionId: "root-unknown",
          parentAgentId: "agent-1",
          delegationId: "delegation-1",
          targetAgentId: "agent-1",
        },
      }))),
      asRes(res),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error).toBe("delegation session mismatch");
    expect(frontend.calls.find((c) => c.method === "chat.ensureSession")).toBeUndefined();
  });

  it("still refuses a session delegated to some other agent", async () => {
    // Neither the owner (agent-2) nor the target (agent-3) is the caller (agent-1):
    // accepting the target must not become a way to claim anyone else's session.
    sessionRegistry.remember("parent-1", "user-1", "agent-2", "agent-3");
    const res = new FakeRes();
    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.ensure_session",
        sessionId: "child-1",
        agentId: "agent-1",
        userId: "user-1",
        origin: "subagent",
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

    expect(res.statusCode).toBe(403);
    expect(frontend.calls.find((c) => c.method === "chat.ensureSession")).toBeUndefined();
  });

  it("re-reads a leg cached before its target was known, instead of refusing for the entry's lifetime", async () => {
    // The state a Runtime restart or eviction can pin: whichever 3-arg caller runs
    // first (chat.send, a channel, a scheduled task) caches the leg owner-only.
    // A cache hit never consults the row again, so refusing on the strength of
    // that entry silently reinstates the data loss this arm exists to fix — and
    // production runs two Runtimes, so the first caller is not always the one
    // that knows the delegation fields.
    sessionRegistry.remember("parent-1", "user-1", "agent-2");
    const resolver = vi.fn(async () => ({ userId: "user-1", agentId: "agent-2", targetAgentId: "agent-1" }));
    sessionRegistry.setResolver(resolver);
    try {
      for (const attempt of [1, 2]) {
        const res = new FakeRes();
        await handleDelegationEvents(
          asReq(new FakeReq(JSON.stringify({
            type: "delegation.append_message",
            message: {
              sessionId: "parent-1",
              role: "assistant",
              content: "written by the delegated peer's box",
              fromAgentId: "agent-1",
            },
          }))),
          asRes(res),
          identity,
          frontend as unknown as FrontendWsClient,
        );
        expect(res.statusCode, `attempt ${attempt}`).toBe(200);
      }
      // Bounded to one extra read: the refreshed record records that the row has
      // been consulted, so the second attempt is answered from cache.
      expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
      sessionRegistry.setResolver(undefined);
      sessionRegistry.forget("parent-1");
    }
  });

  it("still refuses cleanly when the re-read itself fails", async () => {
    // The re-read is on the about-to-refuse path, so a transient upstream failure
    // there must not turn a 403 into a 500: the handler's outer catch would report
    // one, and a box reading its own logs could not tell "not your session" from
    // "the platform is broken". Nothing is written either way.
    sessionRegistry.remember("parent-1", "user-1", "agent-2");
    const resolver = vi.fn(async () => { throw new Error("upstream unavailable") });
    sessionRegistry.setResolver(resolver);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = new FakeRes();
      await handleDelegationEvents(
        asReq(new FakeReq(JSON.stringify({
          type: "delegation.append_message",
          message: { sessionId: "parent-1", role: "assistant", content: "x", fromAgentId: "agent-1" },
        }))),
        asRes(res),
        identity,
        frontend as unknown as FrontendWsClient,
      );
      expect(res.statusCode).toBe(403);
      expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      sessionRegistry.setResolver(undefined);
      sessionRegistry.forget("parent-1");
    }
  });

  it("does not re-read the row when a resolver-sourced record already says there is no target", async () => {
    // A top-level session genuinely has no delegation target. Refusing must not
    // cost an RPC every time some other agent's box writes to it.
    const resolver = vi.fn(async () => ({ userId: "user-1", agentId: "agent-2" }));
    sessionRegistry.setResolver(resolver);
    try {
      const res = new FakeRes();
      await handleDelegationEvents(
        asReq(new FakeReq(JSON.stringify({
          type: "delegation.append_message",
          message: { sessionId: "parent-1", role: "assistant", content: "x", fromAgentId: "agent-1" },
        }))),
        asRes(res),
        identity,
        frontend as unknown as FrontendWsClient,
      );
      expect(res.statusCode).toBe(403);
      // One read to populate the cache miss; the refusal itself adds none.
      expect(resolver).toHaveBeenCalledTimes(1);
    } finally {
      sessionRegistry.setResolver(undefined);
      sessionRegistry.forget("parent-1");
    }
  });

  it("lets a delegated leg's box append to the leg but not rewrite its history", async () => {
    // The asymmetry the append arm must not smuggle in: append_message adds a row
    // attributed to the peer, while update_message takes a message id and rewrites
    // THAT row — including rows the coordinator wrote — and nothing in the payload
    // scopes the rewrite to the caller's own. So the arm that exists to persist a
    // sub-agent transcript stops short of the conversation's history.
    sessionRegistry.remember("parent-1", "user-1", "agent-2", "agent-1");
    const resolver = vi.fn(async () => ({ userId: "user-1", agentId: "agent-2", targetAgentId: "agent-1" }));
    sessionRegistry.setResolver(resolver);
    try {
      const appended = new FakeRes();
      await handleDelegationEvents(
        asReq(new FakeReq(JSON.stringify({
          type: "delegation.append_message",
          message: { sessionId: "parent-1", role: "assistant", content: "peer's own row", fromAgentId: "agent-1" },
        }))),
        asRes(appended),
        identity,
        frontend as unknown as FrontendWsClient,
      );
      expect(appended.statusCode).toBe(200);

      for (const type of ["delegation.update_message", "delegation.update_tool_message"]) {
        const res = new FakeRes();
        await handleDelegationEvents(
          asReq(new FakeReq(JSON.stringify({
            type,
            message: { sessionId: "parent-1", messageId: "msg-1", content: "rewritten by the peer" },
          }))),
          asRes(res),
          identity,
          frontend as unknown as FrontendWsClient,
        );
        expect(res.statusCode, type).toBe(403);
      }
    } finally {
      sessionRegistry.setResolver(undefined);
      sessionRegistry.forget("parent-1");
    }
  });

  it("does not trust a relayed leg cached under the peer when checking ownership", async () => {
    // On a Runtime the leg was RELAYED to, `chat.send` caches it under the peer's
    // own agent — so a cache-only owner check would read back "the peer owns it"
    // and hand the peer the rewrite access the check exists to withhold, in
    // exactly the multi-Runtime deployment where nobody is watching one box's
    // swallowed persistence errors. Ownership therefore comes from the row.
    sessionRegistry.remember("parent-1", "user-1", "agent-1");
    const resolver = vi.fn(async () => ({ userId: "user-1", agentId: "agent-2", targetAgentId: "agent-1" }));
    sessionRegistry.setResolver(resolver);
    try {
      const rewrite = new FakeRes();
      await handleDelegationEvents(
        asReq(new FakeReq(JSON.stringify({
          type: "delegation.update_message",
          message: { sessionId: "parent-1", messageId: "msg-1", content: "rewritten by the peer" },
        }))),
        asRes(rewrite),
        identity,
        frontend as unknown as FrontendWsClient,
      );
      expect(rewrite.statusCode).toBe(403);
      expect(resolver, "the cached record must not answer an ownership question").toHaveBeenCalledTimes(1);

      // The append arm is unaffected: that is the write this whole change exists
      // to let through, and the refreshed record now names the target.
      const appended = new FakeRes();
      await handleDelegationEvents(
        asReq(new FakeReq(JSON.stringify({
          type: "delegation.append_message",
          message: { sessionId: "parent-1", role: "assistant", content: "peer's own row", fromAgentId: "agent-1" },
        }))),
        asRes(appended),
        identity,
        frontend as unknown as FrontendWsClient,
      );
      expect(appended.statusCode).toBe(200);
    } finally {
      sessionRegistry.setResolver(undefined);
      sessionRegistry.forget("parent-1");
    }
  });

  it("still refuses a rewrite after a relay re-cached the leg under the peer", async () => {
    // The sequence that reopened this gate once already: the row is read and cached
    // authoritatively as the coordinator's, then the Runtime the leg was relayed to
    // handles `chat.send` and re-remembers it under the PEER. If provenance rode
    // along with that rewrite, the entry would assert the peer as an authoritative
    // owner and this gate would skip the re-read that catches it.
    const resolver = vi.fn(async () => ({ userId: "user-1", agentId: "agent-2", targetAgentId: "agent-1" }));
    sessionRegistry.setResolver(resolver);
    try {
      // 1. Row-sourced: the coordinator owns it.
      expect(await sessionRegistry.get("parent-1")).toMatchObject({ agentId: "agent-2", authoritative: true });
      // 2. The relay's own view of the same session.
      sessionRegistry.remember("parent-1", "user-1", "agent-1");
      expect(sessionRegistry.peek("parent-1")).toMatchObject({ agentId: "agent-1" });

      const res = new FakeRes();
      await handleDelegationEvents(
        asReq(new FakeReq(JSON.stringify({
          type: "delegation.update_message",
          message: { sessionId: "parent-1", messageId: "msg-1", content: "rewritten by the peer" },
        }))),
        asRes(res),
        identity,
        frontend as unknown as FrontendWsClient,
      );
      expect(res.statusCode).toBe(403);
      // The re-read is what caught it: once for the initial get, once because the
      // rewritten entry no longer carries provenance.
      expect(resolver).toHaveBeenCalledTimes(2);
    } finally {
      sessionRegistry.setResolver(undefined);
      sessionRegistry.forget("parent-1");
    }
  });

  it("refuses an owner-only write when the row cannot be re-read", async () => {
    // The cached owner does not stand in for the row, not even when it names the
    // caller. A cache entry says "this Runtime is running the session for agent X",
    // which on a relayed leg is the PEER — so an entry that happens to agree with
    // the caller is not evidence, it is the same unverified claim. And the moment
    // this matters is exactly the moment the row cannot contradict it.
    sessionRegistry.remember("parent-1", "user-1", "agent-1");
    const resolver = vi.fn(async () => { throw new Error("portal unavailable") });
    sessionRegistry.setResolver(resolver);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = new FakeRes();
      await handleDelegationEvents(
        asReq(new FakeReq(JSON.stringify({
          type: "delegation.update_message",
          message: { sessionId: "parent-1", messageId: "msg-1", content: "unprovable" },
        }))),
        asRes(res),
        identity,
        frontend as unknown as FrontendWsClient,
      );
      expect(res.statusCode).toBe(403);
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      sessionRegistry.setResolver(undefined);
      sessionRegistry.forget("parent-1");
    }
  });

  it("refuses a relayed leg's rewrite while the row is unreachable", async () => {
    // The whole sequence, in order, because each step is individually correct and
    // the exposure only appears once they are composed:
    //   1. the row is read — the coordinator owns the leg, the peer executes it;
    //   2. this Runtime handles chat.send for the relayed leg and re-remembers it
    //      under the PEER, correctly dropping provenance but keeping the target;
    //   3. Portal goes away, so the gate cannot ask the row;
    //   4. the peer asks to rewrite a row in the coordinator's conversation.
    // Trusting the cache at step 4 hands over the permission, and hands it over
    // specifically while the source of truth is unavailable to object.
    const rowResolver = vi.fn(async () => ({ userId: "user-1", agentId: "agent-2", targetAgentId: "agent-1" }));
    sessionRegistry.setResolver(rowResolver);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await sessionRegistry.get("parent-1")).toMatchObject({ agentId: "agent-2", authoritative: true });
      sessionRegistry.remember("parent-1", "user-1", "agent-1");
      expect(sessionRegistry.peek("parent-1")).toMatchObject({ agentId: "agent-1", targetAgentId: "agent-1" });
      expect(sessionRegistry.peek("parent-1")?.authoritative).toBeUndefined();

      sessionRegistry.setResolver(async () => { throw new Error("portal unavailable") });
      const res = new FakeRes();
      await handleDelegationEvents(
        asReq(new FakeReq(JSON.stringify({
          type: "delegation.update_message",
          message: { sessionId: "parent-1", messageId: "msg-1", content: "rewritten by the peer" },
        }))),
        asRes(res),
        identity,
        frontend as unknown as FrontendWsClient,
      );
      expect(res.statusCode).toBe(403);
      expect(frontend.calls).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      sessionRegistry.setResolver(undefined);
      sessionRegistry.forget("parent-1");
    }
  });

  it("names the session in an ownership refusal, and keeps payload errors off that signal", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A box treats persistence as best-effort and swallows the failure, so this
      // line is the only trace a dropped write leaves. Without the session id it
      // cannot be tied to the conversation whose history went missing.
      sessionRegistry.remember("parent-other", "user-1", "agent-2", "agent-3");
      const refused = new FakeRes();
      await handleDelegationEvents(
        asReq(new FakeReq(JSON.stringify({
          type: "delegation.append_message",
          message: { sessionId: "parent-other", role: "assistant", content: "x", fromAgentId: "agent-1" },
        }))),
        asRes(refused),
        identity,
        frontend as unknown as FrontendWsClient,
      );
      expect(refused.statusCode).toBe(403);
      const refusal = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes("refused"));
      expect(refusal).toContain("parent-other");

      warnSpy.mockClear();
      // A malformed payload is the caller's own bug, not a Portal that stopped
      // reporting delegation targets. Mixing the two makes a steady stream of
      // real refusals unreadable.
      const malformed = new FakeRes();
      await handleDelegationEvents(
        asReq(new FakeReq(JSON.stringify({
          type: "delegation.ensure_session", sessionId: "child-1", agentId: "agent-1", userId: "",
        }))),
        asRes(malformed),
        identity,
        frontend as unknown as FrontendWsClient,
      );
      expect(malformed.statusCode).toBe(400);
      expect(warnSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes("refused"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
      sessionRegistry.forget("parent-other");
    }
  });

  it("forwards toolset through the AgentBox persistence append/update bridge", async () => {
    sessionRegistry.remember("child-1", "user-1", "agent-1");
    sessionRegistry.remember("parent-1", "user-1", "agent-1");
    // A resolver is always installed in production (startRuntime wires one), and
    // `update_message` is owner-only against the ROW — so a test that cached the
    // session by hand has to be able to confirm it, or it is asserting the
    // behaviour of a Runtime that cannot exist.
    sessionRegistry.setResolver(async () => ({ userId: "user-1", agentId: "agent-1" }));

    const appendRes = new FakeRes();
    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.append_message",
        message: {
          sessionId: "child-1",
          parentSessionId: "parent-1",
          role: "tool",
          content: "",
          toolName: "read",
          toolset: "filesystem",
          fromAgentId: "agent-1",
          targetAgentId: "agent-1",
        },
      }))),
      asRes(appendRes),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    const updateRes = new FakeRes();
    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.update_message",
        message: {
          messageId: "msg-1",
          sessionId: "child-1",
          content: "done",
          toolName: "read",
          toolset: "filesystem",
        },
      }))),
      asRes(updateRes),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    expect(appendRes.statusCode).toBe(200);
    expect(updateRes.statusCode).toBe(200);
    expect(frontend.calls[0]).toMatchObject({
      method: "chat.appendMessage",
      params: { tool_name: "read", toolset: "filesystem" },
    });
    expect(frontend.calls[1]).toMatchObject({
      method: "chat.updateMessage",
      params: { tool_name: "read", toolset: "filesystem" },
    });
    sessionRegistry.setResolver(undefined);
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

  it("persists a single child's tier outcome all the way into chat.appendMessage metadata", async () => {
    // The gap this covers: the AgentBox emitted `tier` on the terminal event and
    // this projection did not copy it, so the field died at the Gateway. A group's
    // outcome travels inside `item_statuses` and WAS copied, which made the
    // single-child loss invisible — and asserting only that the AgentBox sent the
    // field would not have caught it either. For a DETACHED single spawn this
    // event is the only surviving record.
    const res = new FakeRes();

    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.append_event",
        event: {
          parentSessionId: "sess-1",
          parentAgentId: "agent-1",
          userId: "u1",
          delegationId: "spawn-1",
          childSessionId: "child-1",
          targetAgentId: "agent-1",
          status: "done",
          capsule: "found it",
          tier: {
            requestedTier: "fast",
            resolvedTier: "fast",
            source: "request",
            provider: "p",
            modelId: "m",
            // Fields the producer would never send, present HERE precisely so the
            // assertion below tests the FILTER rather than the input. An earlier
            // version of this test passed a clean object and asserted "no apiKey",
            // which proved nothing.
            modelConfig: { apiKey: "sk-must-not-persist", baseUrl: "https://leak.invalid" },
            detail: "internal diagnostic text",
            apiKey: "sk-also-must-not-persist",
          },
        },
      }))),
      asRes(res),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    expect(res.statusCode).toBe(200);
    const append = frontend.calls.find((c) => c.method === "chat.appendMessage");
    expect(append).toBeDefined();
    const raw = (append!.params as { metadata: string }).metadata;
    const metadata = JSON.parse(raw);

    // Exactly the allow-listed keys — nothing more, so a new field upstream is
    // dropped by default rather than persisted until someone excludes it.
    expect(metadata.tier).toEqual({
      requestedTier: "fast",
      resolvedTier: "fast",
      source: "request",
      provider: "p",
      modelId: "m",
    });
    // The HTTP boundary types its body by assertion, which strips nothing — so
    // this is what stops a caller writing credentials into a durable record.
    expect(raw).not.toContain("apiKey");
    expect(raw).not.toContain("sk-must-not-persist");
    expect(raw).not.toContain("leak.invalid");
    expect(raw).not.toContain("internal diagnostic text");
  });

  it("sanitizes a group's per-item tier outcomes too", async () => {
    // Same allow-list, applied inside item_statuses — the group path was already
    // persisting this field before the single-child one existed, so it needs the
    // same guard rather than inheriting trust from being older.
    const res = new FakeRes();

    await handleDelegationEvents(
      asReq(new FakeReq(JSON.stringify({
        type: "delegation.append_event",
        event: {
          parentSessionId: "sess-1",
          parentAgentId: "agent-1",
          userId: "u1",
          delegationId: "group-1",
          childSessionId: "",
          targetAgentId: "agent-1",
          status: "done",
          capsule: "batch done",
          itemStatuses: [
            {
              index: 0,
              status: "done",
              tier: {
                source: "request",
                resolvedTier: "fast",
                modelConfig: { apiKey: "sk-group-leak" },
              },
            },
            { index: 1, status: "skipped" },
          ],
        },
      }))),
      asRes(res),
      identity,
      frontend as unknown as FrontendWsClient,
    );

    expect(res.statusCode).toBe(200);
    const append = frontend.calls.find((c) => c.method === "chat.appendMessage");
    const raw = (append!.params as { metadata: string }).metadata;
    const metadata = JSON.parse(raw);

    expect(metadata.item_statuses[0].tier).toEqual({ source: "request", resolvedTier: "fast" });
    expect(metadata.item_statuses[1]).toEqual({ index: 1, status: "skipped" });
    expect(raw).not.toContain("sk-group-leak");
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
    // Same reason as the append/update bridge above: channel delivery is owner-only
    // against the row, and production always has a resolver to ask.
    sessionRegistry.setResolver(async () => ({ userId: "lark:oc_1", agentId: "agent-1" }));
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
    sessionRegistry.setResolver(undefined);
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

  it("does not let a delegated leg deliver to the conversation's channel", async () => {
    // Channel delivery is owner-only, unlike the delegation persistence events.
    // The `channel_update` tool that produces these is suppressed on a delegated
    // turn by design — a delegated worker's output flows back through the
    // coordinator, which owns the single visible identity — so a leg has no
    // legitimate way to reach here, and the ownership arm that lets a peer's box
    // persist a sub-agent's transcript should not double as a channel key.
    // Two cache states, one verdict. The second is the one a cache-only owner
    // check would get wrong: on the Runtime a leg was relayed to, `chat.send`
    // caches it under the PEER, so "who owns this" has to come from the row.
    for (const [label, cachedOwner] of [["cached under the coordinator", "agent-2"], ["cached under the peer by a relay", "agent-1"]] as const) {
      sessionRegistry.remember("channel-1", "lark:oc_1", cachedOwner, "agent-1");
      const resolver = vi.fn(async () => ({ userId: "lark:oc_1", agentId: "agent-2", targetAgentId: "agent-1" }));
      sessionRegistry.setResolver(resolver);
      const delivered: string[] = [];
      registerBackgroundChannelDelivery("channel-1", async (message) => {
        if ("text" in message) delivered.push(message.text);
        return true;
      });
      const res = new FakeRes();

      try {
        await handleDelegationEvents(
          asReq(new FakeReq(JSON.stringify({
            type: "channel.deliver_message",
            message: {
              sessionId: "channel-1",
              kind: "milestone",
              text: "should not reach the channel",
              fromAgentId: "agent-1",
            },
          }))),
          asRes(res),
          identity,
          frontend as unknown as FrontendWsClient,
        );

        expect(res.statusCode, label).toBe(403);
        expect(delivered, label).toHaveLength(0);
        expect(frontend.calls, label).toHaveLength(0);
      } finally {
        sessionRegistry.setResolver(undefined);
        sessionRegistry.forget("channel-1");
      }
    }
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

  it("rejects a body boxId outside the cert identity and attributes to the cert", async () => {
    const fed = new PromFederationAggregator();
    const res = new FakeRes();
    // "spoofed-box" is neither the cert's boxId nor one of its instance suffixes.
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

  it("accepts an instance suffix of the cert's own boxId, so replicas stay distinct", async () => {
    // Sibling replicas share one certificate, so without an accepted claim their per-box
    // series would all land on the agent's base id and overwrite each other.
    const fed = new PromFederationAggregator();
    await handleMetricsFlush(
      asReq(new FakeReq(JSON.stringify({ boxId: "box-1-2", incarnation: "inc-1", prom: counterFrame(30) }))),
      asRes(new FakeRes()),
      identity, // identity.boxId === "box-1"
      fed,
    );
    expect(counterVal(fed)).toBe(30);
    // Attributed to box-1-2, so a re-ingest under that key is idempotent...
    fed.ingest("box-1-2", "inc-1", counterFrame(30));
    expect(counterVal(fed)).toBe(30);
    // ...and the base id is still a separate instance.
    fed.ingest("box-1", "inc-1", counterFrame(30));
    expect(counterVal(fed)).toBe(60);
  });

  it("rejects a claim that merely starts with the cert boxId but is not an instance", async () => {
    // "box-10" and "box-1-evil" both share the "box-1" prefix; neither is a replica of it.
    // "box-1-01" is not one either — an index is written one way, so a padded variant is
    // a second name for the same box and a way to split its metrics in two.
    for (const claimed of ["box-10", "box-1-evil", "box-1-", "box-1-01"]) {
      expect(resolveFlushBoxId("box-1", claimed)).toBe("box-1");
    }
    expect(resolveFlushBoxId("box-1", "box-1-7")).toBe("box-1-7");
    // Instance 0 carries its index now, so its own claim is the ordinary case.
    expect(resolveFlushBoxId("box-1", "box-1-0")).toBe("box-1-0");
    expect(resolveFlushBoxId("box-1", undefined)).toBe("box-1");
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
