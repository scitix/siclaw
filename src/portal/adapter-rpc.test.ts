import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

// Must be after vi.mock
import { getDb } from "../gateway/db.js";
import { buildAdapterRpcHandlers } from "./adapter.js";

// ── Helpers ─────────────────────────────────────────────────────

function mockQuery(...results: any[][]) {
  const query = vi.fn();
  for (const rows of results) {
    query.mockResolvedValueOnce([rows, []]);
  }
  (getDb as any).mockReturnValue({ query, getConnection: vi.fn() });
  return query;
}

function getHandler(name: string) {
  const handlers = buildAdapterRpcHandlers();
  const h = handlers.get(name);
  if (!h) throw new Error(`Handler "${name}" not found`);
  return h;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ================================================================
// config.*
// ================================================================

describe("config.getAgent", () => {
  it("returns agent info for existing agent", async () => {
    mockQuery([{
      id: "a1", name: "Agent 1", description: "desc", status: "active",
      model_provider: "openai", model_id: "gpt-4", system_prompt: "You are helpful",
      icon: "bot", color: "#fff",
    }]);

    const result = await getHandler("config.getAgent")({ agentId: "a1" }, "a1");
    expect(result).toEqual({
      id: "a1", name: "Agent 1", description: "desc", status: "active",
      model_provider: "openai", model_id: "gpt-4", system_prompt: "You are helpful",
      icon: "bot", color: "#fff",
    });
  });

  it("throws when agent not found", async () => {
    mockQuery([]);
    await expect(getHandler("config.getAgent")({ agentId: "missing" }, "missing"))
      .rejects.toThrow("Agent not found");
  });
});

describe("config.getResources", () => {
  it("returns all bindings", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ id: "c1", name: "cluster-1", api_server: "https://k8s" }], []])
      .mockResolvedValueOnce([[{ id: "h1", name: "host-1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key" }], []])
      .mockResolvedValueOnce([[{ skill_id: "s1" }, { skill_id: "s2" }], []])
      .mockResolvedValueOnce([[{ mcp_server_id: "m1" }], []])
      .mockResolvedValueOnce([[{ repo_id: "kr1" }], []])
      .mockResolvedValueOnce([[{ is_production: 1 }], []]);
    (getDb as any).mockReturnValue({ query });

    const result = await getHandler("config.getResources")({ agentId: "a1" }, "a1");
    expect(result.clusters).toHaveLength(1);
    expect(result.hosts).toHaveLength(1);
    expect(result.skill_ids).toEqual(["s1", "s2"]);
    expect(result.mcp_server_ids).toEqual(["m1"]);
    expect(result.knowledge_repo_ids).toEqual(["kr1"]);
    expect(result.is_production).toBe(true);
  });

  it("defaults is_production to true when agent row missing", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]);
    (getDb as any).mockReturnValue({ query });

    const result = await getHandler("config.getResources")({ agentId: "a1" }, "a1");
    expect(result.is_production).toBe(true);
    expect(result.skill_ids).toEqual([]);
    expect(result.knowledge_repo_ids).toEqual([]);
  });
});

describe("config.getSettings", () => {
  it("returns full settings when agent has provider and models", async () => {
    mockQuery(
      [{ model_provider: "openai", model_id: "gpt-4" }],
      [{ id: "p1", name: "openai", base_url: "https://api.openai.com", api_key: "sk-key", api_type: "openai" }],
      [{ model_id: "gpt-4", name: "GPT-4", reasoning: 0, context_window: 128000, max_tokens: 4096 }],
    );

    const result = await getHandler("config.getSettings")({ agentId: "a1" }, "a1");
    expect(result.providers.openai).toBeDefined();
    expect(result.providers.openai.baseUrl).toBe("https://api.openai.com");
    expect(result.providers.openai.apiKey).toBe("sk-key");
    expect(result.providers.openai.models).toEqual([
      {
        id: "gpt-4",
        name: "GPT-4",
        reasoning: false,
        contextWindow: 128000,
        maxTokens: 4096,
        compat: { supportsDeveloperRole: true, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      },
    ]);
    expect(result.default).toEqual({ provider: "openai", modelId: "gpt-4" });
  });

  it("marks OpenAI-compatible gateway settings as not supporting developer-role messages", async () => {
    mockQuery(
      [{ model_provider: "compatible", model_id: "compatible-chat" }],
      [{
        id: "p-compatible",
        name: "compatible",
        base_url: "https://api.example.com/model-api",
        api_key: "sk-key",
        api_type: "openai-completions",
      }],
      [{ model_id: "compatible-chat", name: "Compatible Chat", reasoning: 0, context_window: 128000, max_tokens: 8192 }],
    );

    const result = await getHandler("config.getSettings")({ agentId: "a1" }, "a1");
    expect(result.providers.compatible.models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    });
  });

  it("returns agent modelRouting in settings with hydrated provider configs", async () => {
    mockQuery(
      [{
        model_provider: "openai",
        model_id: "gpt-4",
        model_routing: JSON.stringify({
          enabled: true,
          candidates: [{ provider: "anthropic", modelId: "claude" }],
          cooldownMsByKind: { rate_limit: 1234, quota: 60000 },
        }),
      }],
      [{ id: "p-openai", name: "openai", base_url: "https://api.openai.com", api_key: "sk-openai", api_type: "openai" }],
      [{ model_id: "gpt-4", name: "GPT-4", reasoning: 0, context_window: 128000, max_tokens: 4096 }],
      [{ id: "p-openai", name: "openai", base_url: "https://api.openai.com", api_key: "sk-openai", api_type: "openai" }],
      [{ model_id: "gpt-4", name: "GPT-4", reasoning: 0, context_window: 128000, max_tokens: 4096 }],
      [{ id: "p-anthropic", name: "anthropic", base_url: "https://api.anthropic.com", api_key: "sk-anthropic", api_type: "anthropic" }],
      [{ model_id: "claude", name: "Claude", reasoning: 1, context_window: 200000, max_tokens: 8192 }],
    );

    const result = await getHandler("config.getSettings")({ agentId: "a1" }, "a1");
    expect(result.modelRouting).toMatchObject({
      enabled: true,
      strategy: "ordered_fallback",
      cooldownMsByKind: { rate_limit: 1234, billing: 60000 },
      candidates: [
        { provider: "openai", modelId: "gpt-4" },
        { provider: "anthropic", modelId: "claude" },
      ],
    });
    expect(result.modelRouting.candidates[1].modelConfig.apiKey).toBe("sk-anthropic");
  });

  it("returns empty providers when agent has no model_provider", async () => {
    mockQuery([{ model_provider: null, model_id: null }]);
    const result = await getHandler("config.getSettings")({ agentId: "a1" }, "a1");
    expect(result).toEqual({ providers: {} });
  });

  it("returns empty providers when agent not found", async () => {
    mockQuery([]);
    const result = await getHandler("config.getSettings")({ agentId: "a1" }, "a1");
    expect(result).toEqual({ providers: {} });
  });

  it("returns empty providers when provider not found", async () => {
    mockQuery(
      [{ model_provider: "openai", model_id: "gpt-4" }],
      [],
    );
    const result = await getHandler("config.getSettings")({ agentId: "a1" }, "a1");
    expect(result).toEqual({ providers: {} });
  });
});

describe("config.getModelBinding", () => {
  it("returns binding when agent has valid provider", async () => {
    mockQuery(
      [{ model_provider: "openai", model_id: "gpt-4", system_prompt: "You are an ops bot." }],
      [{ id: "p1", name: "openai", base_url: "https://api.openai.com", api_key: "sk-key", api_type: "openai" }],
      [{ model_id: "gpt-4", name: "GPT-4", reasoning: 1, context_window: 128000, max_tokens: 4096 }],
    );

    const result = await getHandler("config.getModelBinding")({ agentId: "a1" }, "a1");
    expect(result.binding).toBeDefined();
    expect(result.binding.modelProvider).toBe("openai");
    expect(result.binding.modelId).toBe("gpt-4");
    expect(result.binding.systemPrompt).toBe("You are an ops bot.");
    expect(result.binding.modelConfig.name).toBe("openai");
    expect(result.binding.modelConfig.authHeader).toBe(true);
    expect(result.binding.modelConfig.models[0].reasoning).toBe(true);
    expect(result.binding.modelConfig.models[0].input).toEqual(["text"]);
    expect(result.binding.modelConfig.models[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(result.binding.modelConfig.models[0].compat).toMatchObject({
      supportsDeveloperRole: true,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    });
  });

  it("marks OpenAI-compatible gateway bindings as not supporting developer-role messages", async () => {
    mockQuery(
      [{ model_provider: "compatible", model_id: "compatible-chat" }],
      [{
        id: "p-compatible",
        name: "compatible",
        base_url: "https://api.example.com/model-api",
        api_key: "sk-key",
        api_type: "openai-completions",
      }],
      [{ model_id: "compatible-chat", name: "Compatible Chat", reasoning: 1, context_window: 128000, max_tokens: 8192 }],
    );

    const result = await getHandler("config.getModelBinding")({ agentId: "a1" }, "a1");
    expect(result.binding.modelConfig.models[0].compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    });
  });

  it("returns hydrated modelRouting in model binding", async () => {
    mockQuery(
      [{
        model_provider: "openai",
        model_id: "gpt-4",
        model_routing: JSON.stringify({
          enabled: true,
          candidates: [
            { provider: "openai", modelId: "gpt-4" },
            { provider: "anthropic", modelId: "claude" },
          ],
        }),
      }],
      [{ id: "p-openai", name: "openai", base_url: "https://api.openai.com", api_key: "sk-openai", api_type: "openai" }],
      [{ model_id: "gpt-4", name: "GPT-4", reasoning: 1, context_window: 128000, max_tokens: 4096 }],
      [{ id: "p-openai", name: "openai", base_url: "https://api.openai.com", api_key: "sk-openai", api_type: "openai" }],
      [{ model_id: "gpt-4", name: "GPT-4", reasoning: 1, context_window: 128000, max_tokens: 4096 }],
      [{ id: "p-anthropic", name: "anthropic", base_url: "https://api.anthropic.com", api_key: "sk-anthropic", api_type: "anthropic" }],
      [{ model_id: "claude", name: "Claude", reasoning: 0, context_window: 200000, max_tokens: 8192 }],
    );

    const result = await getHandler("config.getModelBinding")({ agentId: "a1" }, "a1");
    expect(result.binding.modelRouting.candidates).toHaveLength(2);
    expect(result.binding.modelRouting.candidates[0]).toMatchObject({ provider: "openai", modelId: "gpt-4" });
    expect(result.binding.modelRouting.candidates[1].modelConfig.name).toBe("anthropic");
  });

  it("returns null binding when agent has no model_provider", async () => {
    mockQuery([{ model_provider: null, model_id: null }]);
    const result = await getHandler("config.getModelBinding")({ agentId: "a1" }, "a1");
    expect(result).toEqual({ binding: null });
  });

  it("returns null binding when provider not found", async () => {
    mockQuery(
      [{ model_provider: "openai", model_id: "gpt-4" }],
      [],
    );
    const result = await getHandler("config.getModelBinding")({ agentId: "a1" }, "a1");
    expect(result).toEqual({ binding: null });
  });
});

describe("config.getMcpServers", () => {
  it("returns mcp servers by IDs", async () => {
    mockQuery([
      { name: "server1", transport: "sse", url: "https://mcp.example.com", command: null, args: null, env: null, headers: '{"Authorization":"Bearer tok"}' },
    ]);

    const result = await getHandler("config.getMcpServers")({ ids: ["id1"] }, "a1");
    expect(result.mcpServers.server1).toBeDefined();
    expect(result.mcpServers.server1.transport).toBe("sse");
    expect(result.mcpServers.server1.url).toBe("https://mcp.example.com");
    expect(result.mcpServers.server1.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("returns empty map when no IDs provided", async () => {
    const result = await getHandler("config.getMcpServers")({ ids: [] }, "a1");
    expect(result).toEqual({ mcpServers: {} });
  });

  it("returns empty map when ids is undefined", async () => {
    const result = await getHandler("config.getMcpServers")({}, "a1");
    expect(result).toEqual({ mcpServers: {} });
  });

  it("parses JSON string fields for args and env", async () => {
    mockQuery([
      { name: "stdio-server", transport: "stdio", url: null, command: "npx", args: '["arg1","arg2"]', env: '{"KEY":"val"}', headers: null },
    ]);

    const result = await getHandler("config.getMcpServers")({ ids: ["id1"] }, "a1");
    expect(result.mcpServers["stdio-server"].command).toBe("npx");
    expect(result.mcpServers["stdio-server"].args).toEqual(["arg1", "arg2"]);
    expect(result.mcpServers["stdio-server"].env).toEqual({ KEY: "val" });
  });

  it("includes the admin-provided description when present", async () => {
    mockQuery([
      { name: "grafana", transport: "sse", url: "https://mcp.example.com", command: null, args: null, env: null, headers: null, description: "Monitoring tenant ID: t-123" },
    ]);

    const result = await getHandler("config.getMcpServers")({ ids: ["id1"] }, "a1");
    expect(result.mcpServers.grafana.description).toBe("Monitoring tenant ID: t-123");
  });

  it("omits description when null", async () => {
    mockQuery([
      { name: "plain", transport: "sse", url: "https://mcp.example.com", command: null, args: null, env: null, headers: null, description: null },
    ]);

    const result = await getHandler("config.getMcpServers")({ ids: ["id1"] }, "a1");
    expect("description" in result.mcpServers.plain).toBe(false);
  });
});

describe("config.getSkillBundle", () => {
  it("returns empty skills when no skill_ids provided", async () => {
    const result = await getHandler("config.getSkillBundle")({ skill_ids: [] }, "a1");
    expect(result.skills).toEqual([]);
    expect(result.version).toBeDefined();
  });

  it("uses approved version query in production mode", async () => {
    const query = mockQuery([
      { id: "s1", name: "My Skill", labels: null, specs: "spec content", scripts: '[{"name":"run.sh","content":"echo hi"}]' },
    ]);

    const result = await getHandler("config.getSkillBundle")(
      { skill_ids: ["s1"], is_production: true }, "a1",
    );
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].dirName).toBe("My_Skill");
    expect(result.skills[0].scope).toBe("global");
    expect(result.skills[0].specs).toBe("spec content");
    expect(result.skills[0].scripts).toEqual([{ name: "run.sh", content: "echo hi" }]);
    // Verify the SQL uses skill_versions join
    expect(query.mock.calls[0][0]).toContain("skill_versions");
  });

  it("uses simple query in dev mode", async () => {
    const query = mockQuery([
      { id: "s1", name: "Dev Skill", labels: null, specs: "dev spec", scripts: null },
    ]);

    const result = await getHandler("config.getSkillBundle")(
      { skill_ids: ["s1"], is_production: false }, "a1",
    );
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].scripts).toEqual([]);
    // Verify the SQL does NOT use skill_versions
    expect(query.mock.calls[0][0]).not.toContain("skill_versions");
  });

  it("sanitizes skill name for dirName", async () => {
    mockQuery([
      { id: "s1", name: "My Skill @2.0!", labels: null, specs: "", scripts: null },
    ]);

    const result = await getHandler("config.getSkillBundle")(
      { skill_ids: ["s1"], is_production: false }, "a1",
    );
    expect(result.skills[0].dirName).toBe("My_Skill__2_0_");
  });
});

describe("config.getSystemConfig", () => {
  it("returns config key-value pairs", async () => {
    mockQuery([
      { config_key: "feature.enabled", config_value: "true" },
      { config_key: "version", config_value: "1.0" },
      { config_key: "empty", config_value: null },
    ]);

    const result = await getHandler("config.getSystemConfig")({}, "a1");
    expect(result.config).toEqual({ "feature.enabled": "true", version: "1.0" });
    // null values are excluded
    expect(result.config).not.toHaveProperty("empty");
  });
});

describe("config.setSystemConfig", () => {
  it("inserts or updates config value", async () => {
    const query = mockQuery([]);

    const result = await getHandler("config.setSystemConfig")(
      { key: "feature.enabled", value: "true", updated_by: "admin" }, "a1",
    );
    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(["feature.enabled", "true", "admin"]);
  });
});

describe("config.getDefaultModel", () => {
  it("returns default provider and model", async () => {
    mockQuery(
      [{ id: "p1", base_url: "https://api.openai.com", api_key: "sk-key", api_type: "openai" }],
      [{ model_id: "gpt-4" }],
    );

    const result = await getHandler("config.getDefaultModel")({}, "a1");
    expect(result.provider.id).toBe("p1");
    expect(result.model.model_id).toBe("gpt-4");
  });

  it("returns null provider when no providers exist", async () => {
    mockQuery([]);
    const result = await getHandler("config.getDefaultModel")({}, "a1");
    expect(result).toEqual({ provider: null });
  });

  it("returns null provider when no models exist for provider", async () => {
    mockQuery(
      [{ id: "p1", base_url: "https://api.openai.com", api_key: "sk-key", api_type: "openai" }],
      [],
    );
    const result = await getHandler("config.getDefaultModel")({}, "a1");
    expect(result).toEqual({ provider: null });
  });
});

// ================================================================
// credential.*
// ================================================================

describe("credential.list", () => {
  it("returns hosts when kind is 'host'", async () => {
    mockQuery([
      { name: "web-1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: 1, description: "Web server" },
    ]);

    const result = await getHandler("credential.list")({ kind: "host" }, "agent-1");
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toEqual({
      name: "web-1", ip: "10.0.0.1", port: 22, username: "root",
      auth_type: "key", is_production: true, description: "Web server",
    });
  });

  it("returns hosts when kind is 'hosts'", async () => {
    mockQuery([
      { name: "web-1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: 0, description: null },
    ]);

    const result = await getHandler("credential.list")({ kind: "hosts" }, "agent-1");
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0].is_production).toBe(false);
    expect(result.hosts[0]).not.toHaveProperty("description");
  });

  it("returns clusters by default", async () => {
    mockQuery([
      { name: "prod-cluster", api_server: "https://k8s", is_production: 1, kubeconfig: "yaml", description: "Prod", debug_image: "debug:latest" },
    ]);

    const result = await getHandler("credential.list")({}, "agent-1");
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0]).toEqual({
      name: "prod-cluster", is_production: true,
      api_server: "https://k8s", description: "Prod", debug_image: "debug:latest",
    });
  });

  it("omits optional cluster fields when null", async () => {
    mockQuery([
      { name: "basic-cluster", api_server: null, is_production: 0, kubeconfig: "yaml", description: null, debug_image: null },
    ]);

    const result = await getHandler("credential.list")({}, "agent-1");
    expect(result.clusters[0]).toEqual({ name: "basic-cluster", is_production: false });
  });

  it("prefers params.agentId over the connection agentId (phone-home fix)", async () => {
    const query = mockQuery([]);
    await getHandler("credential.list")({ agentId: "real-agent" }, "runtime");
    // The SQL bound parameter must be the real-agent UUID from params,
    // not the connection's placeholder "runtime" id.
    expect(query.mock.calls[0][1]).toEqual(["real-agent"]);
  });

  it("throws when no agentId is available", async () => {
    await expect(
      getHandler("credential.list")({}, ""),
    ).rejects.toThrow("agentId required");
  });

  // ── host query path (host_list with a query) ──
  it("host query: filters, paginates, returns id + total + next_cursor", async () => {
    const q = mockQuery(
      [{ n: 137 }], // COUNT(*)
      [{ id: "h1", name: "gpu-1", ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", is_production: 1, description: "x", jump_host_name: "bastion" }],
    );
    const result = await getHandler("credential.list")({ kind: "host", query: "gpu", limit: 1 }, "agent-1");
    expect(result.hosts).toEqual([
      { id: "h1", name: "gpu-1", ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", is_production: true, description: "x", jump_host: "bastion" },
    ]);
    expect(result.total).toBe(137);
    expect(result.next_cursor).toBe("1"); // offset 0 + limit 1 < 137
    const selectSql = q.mock.calls[1][0];
    expect(selectSql).toContain("LIMIT 1 OFFSET 0");
    expect(selectSql).toContain("LIKE");
  });

  it("host query: limit defaults to 20 and caps at 100", async () => {
    const q1 = mockQuery([{ n: 0 }], []);
    await getHandler("credential.list")({ kind: "host", query: "x" }, "a1");
    expect(q1.mock.calls[1][0]).toContain("LIMIT 20 OFFSET 0");
    const q2 = mockQuery([{ n: 0 }], []);
    await getHandler("credential.list")({ kind: "host", query: "x", limit: 9999 }, "a1");
    expect(q2.mock.calls[1][0]).toContain("LIMIT 100");
  });

  it("host query: an IPv4 query matches ip exactly (no LIKE)", async () => {
    const q = mockQuery([{ n: 1 }], [{ id: "h1", name: "n", ip: "10.0.0.5", port: 22, username: "root", auth_type: "key", is_production: 1, description: null, jump_host_name: null }]);
    await getHandler("credential.list")({ kind: "host", query: "10.0.0.5" }, "a1");
    const selectSql = q.mock.calls[1][0];
    expect(selectSql).toContain("h.ip = ?");
    expect(selectSql).not.toContain("LIKE");
    expect(q.mock.calls[1][1]).toEqual(["a1", "10.0.0.5"]); // agentId + exact ip
  });

  it("host query: an empty query browses (paginated, no filter)", async () => {
    const q = mockQuery([{ n: 2 }], [
      { id: "h1", name: "a", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: 1, description: null, jump_host_name: null },
      { id: "h2", name: "b", ip: "10.0.0.2", port: 22, username: "root", auth_type: "key", is_production: 0, description: null, jump_host_name: null },
    ]);
    const result = await getHandler("credential.list")({ kind: "host", query: "" }, "a1");
    expect(result.hosts).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.next_cursor).toBeNull(); // 0 + 2 == total
    const selectSql = q.mock.calls[1][0];
    expect(selectSql).not.toContain("LIKE");
    expect(selectSql).toContain("WHERE ah.agent_id = ?");
  });
});

describe("credential.get", () => {
  // Query order for cluster: (1) cluster lookup by name, (2) agent_clusters binding check
  // Query order for host:    (1) host lookup by name,    (2) agent_hosts binding check

  it("returns kubeconfig for cluster credential", async () => {
    mockQuery(
      [{ id: "cluster-uuid-1", name: "prod-cluster", kubeconfig: "apiVersion: v1\nkind: Config" }],
      [{ "1": 1 }],  // binding check
    );

    const result = await getHandler("credential.get")(
      { source: "cluster", source_id: "prod-cluster" }, "agent-1",
    );
    expect(result.credential.type).toBe("kubeconfig");
    expect(result.credential.name).toBe("prod-cluster");
  });

  it("prefers params.agentId over the connection agentId (phone-home fix)", async () => {
    const query = mockQuery(
      [{ id: "cluster-uuid-1", name: "prod-cluster", kubeconfig: "apiVersion: v1" }],
      [{ "1": 1 }],
    );

    await getHandler("credential.get")(
      { source: "cluster", source_id: "prod-cluster", agentId: "real-agent" },
      "runtime",
    );
    // Second query is the agent-binding check — its first bound param must
    // be the real agent UUID from params, and its second must be the
    // resolved cluster UUID (not the name passed in source_id).
    expect(query.mock.calls[1][1]).toEqual(["real-agent", "cluster-uuid-1"]);
  });

  it("looks up cluster by name and uses resolved UUID for binding check", async () => {
    const query = mockQuery(
      [{ id: "cluster-uuid-1", name: "prod-cluster", kubeconfig: "yaml" }],
      [{ "1": 1 }],
    );

    await getHandler("credential.get")(
      { source: "cluster", source_id: "prod-cluster" }, "agent-1",
    );
    // First query looks up by NAME, not id.
    expect(query.mock.calls[0][0]).toMatch(/WHERE name = \?/);
    expect(query.mock.calls[0][1]).toEqual(["prod-cluster"]);
    // Binding check uses the UUID resolved from the name lookup.
    expect(query.mock.calls[1][1]).toEqual(["agent-1", "cluster-uuid-1"]);
  });

  it("returns SSH key file for host credential with key auth", async () => {
    mockQuery(
      [{ id: "host-uuid-1", name: "web-1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", password: null, private_key: "-----BEGIN RSA-----", is_production: 1, description: "db node" }],
      [{ "1": 1 }],  // binding check
    );

    const result = await getHandler("credential.get")(
      { source: "host", source_id: "web-1" }, "agent-1",
    );
    expect(result.credential.type).toBe("ssh");
    expect(result.credential.metadata).toEqual({
      ip: "10.0.0.1",
      port: 22,
      username: "root",
      auth_type: "key",
      is_production: true,
      description: "db node",
    });
    expect(result.credential.files).toEqual([
      { name: "host.key", content: "-----BEGIN RSA-----", mode: 0o600 },
    ]);
  });

  it("resolves a host by id (the handle host_list returns), not just by name", async () => {
    // host_list exposes HostMeta.id as a selection handle; a model may pass that
    // id to host_exec → credential.get(source_id=<id>). The lookup must accept it.
    const query = mockQuery(
      [{ id: "host-uuid-1", name: "web-1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", password: null, private_key: "-----BEGIN RSA-----", is_production: 1, description: "db node" }],
      [{ "1": 1 }],  // binding check
    );

    const result = await getHandler("credential.get")(
      { source: "host", source_id: "host-uuid-1" }, "agent-1",
    );
    expect(result.credential.type).toBe("ssh");
    // Lookup accepts name OR id, and passes both bind params as source_id.
    expect(query.mock.calls[0][0]).toMatch(/WHERE name = \? OR id = \?/);
    expect(query.mock.calls[0][1]).toEqual(["host-uuid-1", "host-uuid-1"]);
    // Binding check uses the RESOLVED host.id regardless of the handle passed in.
    expect(query.mock.calls[1][1]).toEqual(["agent-1", "host-uuid-1"]);
  });

  it("returns password file for host credential with password auth", async () => {
    mockQuery(
      [{ id: "host-uuid-2", name: "web-2", ip: "10.0.0.2", port: 22, username: "admin", auth_type: "password", password: "secret123", private_key: null }],
      [{ "1": 1 }],  // binding check
    );

    const result = await getHandler("credential.get")(
      { source: "host", source_id: "web-2" }, "agent-1",
    );
    expect(result.credential.files).toEqual([
      { name: "host.password", content: "secret123" },
    ]);
  });

  it("returns a managed credential: auth_type=managed + jump_host + jump_chain, no key/password file", async () => {
    mockQuery(
      [{ id: "t1", name: "target", ip: "10.0.0.9", port: 22, username: "ops", auth_type: "managed", password: null, private_key: null, passphrase: null, is_production: 1, description: null, jump_host_id: "b1" }],
      [{ "1": 1 }],         // binding ok
      // walkJumpChainRows(b1): the sole bastion, chain ends (jump_host_id null)
      [{ id: "b1", name: "bastion", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", password: null, private_key: "BKEY", passphrase: null, jump_host_id: null }],
    );
    const result = await getHandler("credential.get")({ source: "host", source_id: "target" }, "agent-1");
    expect(result.credential.type).toBe("ssh");
    expect(result.credential.metadata.auth_type).toBe("managed");
    expect(result.credential.metadata.jump_host).toBe("bastion");
    expect(result.credential.files).toEqual([]);
    // Server-pre-resolved chain [outermost … nearest], target excluded, files materializable.
    expect(result.credential.jump_chain).toEqual([
      { name: "bastion", metadata: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key" }, files: [{ name: "host.key", content: "BKEY", mode: 0o600 }] },
    ]);
  });

  it("emits a 2-hop jump_chain ordered [outermost … nearest] + dual-emits metadata.jump_host", async () => {
    mockQuery(
      [{ id: "t1", name: "target", ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", password: null, private_key: "TK", passphrase: null, is_production: 1, description: null, jump_host_id: "b1" }],
      [{ "1": 1 }], // binding ok
      // walkJumpChainRows(b1): nearest bastion b1 → its jump b2
      [{ id: "b1", name: "near", ip: "10.0.0.2", port: 22, username: "root", auth_type: "key", password: null, private_key: "B1K", passphrase: null, jump_host_id: "b2" }],
      [{ id: "b2", name: "outer", ip: "10.0.0.1", port: 22, username: "root", auth_type: "password", password: "B2PW", private_key: null, passphrase: null, jump_host_id: null }],
    );
    const result = await getHandler("credential.get")({ source: "host", source_id: "target" }, "agent-1");
    expect(result.credential.files).toEqual([{ name: "host.key", content: "TK", mode: 0o600 }]);
    expect(result.credential.metadata.jump_host).toBe("near"); // nearest bastion name, for legacy fallback
    expect(result.credential.jump_chain).toEqual([
      { name: "outer", metadata: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "password" }, files: [{ name: "host.password", content: "B2PW" }] },
      { name: "near", metadata: { ip: "10.0.0.2", port: 22, username: "root", auth_type: "key" }, files: [{ name: "host.key", content: "B1K", mode: 0o600 }] },
    ]);
  });

  it("fails closed when an explicit host's jump_host_id is dangling (no silent direct-connect)", async () => {
    mockQuery(
      [{ id: "t1", name: "target", ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", password: null, private_key: "TK", passphrase: null, is_production: 1, description: null, jump_host_id: "missing" }],
      [{ "1": 1 }], // binding ok
      [],           // walkJumpChainRows("missing") → row not found
    );
    await expect(
      getHandler("credential.get")({ source: "host", source_id: "target" }, "agent-1"),
    ).rejects.toThrow(/not found in jump chain/);
  });

  it("authorizes a jump host transitively when the agent is bound to a host that uses it", async () => {
    mockQuery(
      // 1) resolve the requested bastion host
      [{ id: "bastion-uuid", name: "bastion", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", password: null, private_key: "K", passphrase: null, is_production: 1, description: null, jump_host_id: null }],
      // 2) direct binding: agent is NOT bound to the bastion
      [],
      // 3) isJumpOfBoundHost: the agent's bound host points its jump_host_id at the bastion
      [{ jump_host_id: "bastion-uuid" }],
    );
    const result = await getHandler("credential.get")(
      { source: "host", source_id: "bastion" }, "agent-1",
    );
    expect(result.credential.type).toBe("ssh");
    expect(result.credential.files[0].name).toBe("host.key");
  });

  it("throws when agent not bound to cluster", async () => {
    mockQuery(
      [{ id: "cluster-uuid-1", name: "prod-cluster", kubeconfig: "yaml" }],
      [],  // binding check returns empty
    );
    await expect(
      getHandler("credential.get")({ source: "cluster", source_id: "prod-cluster" }, "agent-1"),
    ).rejects.toThrow("Agent not bound to this cluster");
  });

  it("throws when agent not bound to host", async () => {
    mockQuery(
      [{ id: "host-uuid-1", name: "web-1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", password: null, private_key: "pk" }],
      [],  // direct binding check returns empty
      [],  // transitive jump check: agent has no bound hosts → not a jump of any
    );
    await expect(
      getHandler("credential.get")({ source: "host", source_id: "web-1" }, "agent-1"),
    ).rejects.toThrow("Agent not bound to this host");
  });

  it("throws when cluster not found", async () => {
    mockQuery([]);  // cluster lookup returns empty — short-circuits before binding check
    await expect(
      getHandler("credential.get")({ source: "cluster", source_id: "unknown-cluster" }, "agent-1"),
    ).rejects.toThrow("Cluster not found");
  });

  it("throws when host not found", async () => {
    mockQuery([]);  // host lookup returns empty
    await expect(
      getHandler("credential.get")({ source: "host", source_id: "unknown-host" }, "agent-1"),
    ).rejects.toThrow("Host not found");
  });

  it("throws when source and source_id are missing", async () => {
    await expect(
      getHandler("credential.get")({}, "agent-1"),
    ).rejects.toThrow("source and source_id are required");
  });

  it("throws for unknown source type", async () => {
    await expect(
      getHandler("credential.get")({ source: "unknown", source_id: "x1" }, "agent-1"),
    ).rejects.toThrow("Unknown source type: unknown");
  });
});

describe("credential.checkAccess", () => {
  it("returns allowed for admin user on review action", async () => {
    mockQuery([{ role: "admin", can_review_skills: 0 }]);

    const result = await getHandler("credential.checkAccess")(
      { action: "review", user_id: "u1" }, "a1",
    );
    expect(result).toEqual({ allowed: true, grant_all: true, agent_group_ids: [] });
  });

  it("returns allowed for user with can_review_skills flag", async () => {
    mockQuery([{ role: "user", can_review_skills: 1 }]);

    const result = await getHandler("credential.checkAccess")(
      { action: "review", user_id: "u1" }, "a1",
    );
    expect(result).toEqual({ allowed: true, grant_all: true, agent_group_ids: [] });
  });

  it("returns not allowed for regular user without review permission", async () => {
    mockQuery([{ role: "user", can_review_skills: 0 }]);

    const result = await getHandler("credential.checkAccess")(
      { action: "review", user_id: "u1" }, "a1",
    );
    expect(result).toEqual({ allowed: false, grant_all: false, agent_group_ids: [] });
  });

  it("returns not allowed when user not found", async () => {
    mockQuery([]);
    const result = await getHandler("credential.checkAccess")(
      { action: "review", user_id: "u1" }, "a1",
    );
    expect(result).toEqual({ allowed: false, grant_all: false, agent_group_ids: [] });
  });

  it("returns allowed for non-review actions", async () => {
    const result = await getHandler("credential.checkAccess")(
      { action: "execute" }, "a1",
    );
    expect(result).toEqual({ allowed: true, grant_all: true, agent_group_ids: [] });
  });
});

describe("credential.resourceManifest", () => {
  it("returns combined cluster and host resources", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ id: "c1", name: "cluster-1", api_server: "https://k8s", type: "cluster" }], []])
      .mockResolvedValueOnce([[{ id: "h1", name: "host-1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", type: "host" }], []]);
    (getDb as any).mockReturnValue({ query });

    const result = await getHandler("credential.resourceManifest")({}, "agent-1");
    expect(result.resources).toHaveLength(2);
    expect(result.resources[0].type).toBe("cluster");
    expect(result.resources[1].type).toBe("host");
  });

  it("uses params.agent_id over agentId argument", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[], []]);
    (getDb as any).mockReturnValue({ query });

    await getHandler("credential.resourceManifest")({ agent_id: "custom-agent" }, "agent-1");
    expect(query.mock.calls[0][1]).toEqual(["custom-agent"]);
  });

  it("throws when no agent_id available", async () => {
    await expect(
      getHandler("credential.resourceManifest")({}, ""),
    ).rejects.toThrow("agent_id required");
  });
});

describe("credential.hostSearch", () => {
  it("returns hosts filtered by agent_id", async () => {
    mockQuery([
      { id: "h1", name: "web-1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", description: "Web" },
    ]);

    const result = await getHandler("credential.hostSearch")({}, "agent-1");
    expect(result.hosts).toHaveLength(1);
  });

  it("adds search filter when query is provided", async () => {
    const query = mockQuery([]);
    await getHandler("credential.hostSearch")({ query: "web" }, "agent-1");
    expect(query.mock.calls[0][1]).toContain("%web%");
  });

  it("searches all hosts when no agent_id", async () => {
    const query = mockQuery([]);
    await getHandler("credential.hostSearch")({ agent_id: "" }, "");
    // When effectiveAgentId is falsy, it should query without agent filter
    expect(query.mock.calls[0][0]).toContain("FROM hosts");
    expect(query.mock.calls[0][0]).not.toContain("agent_hosts");
  });

});

// ================================================================
// chat.*
// ================================================================

describe("chat.ensureSession", () => {
  it("upserts a session", async () => {
    const query = mockQuery([]);

    const result = await getHandler("chat.ensureSession")(
      { session_id: "sess1", agent_id: "a1", user_id: "u1", title: "Test", preview: "preview", origin: "web" }, "a1",
    );
    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toContain("sess1");
  });

  it("uses default title when not provided", async () => {
    const query = mockQuery([]);

    await getHandler("chat.ensureSession")(
      { session_id: "sess1", agent_id: "a1", user_id: "u1" }, "a1",
    );
    expect(query.mock.calls[0][1]).toContain("New Session");
  });

  it("truncates long title and preview fields before upsert", async () => {
    const query = mockQuery([]);

    await getHandler("chat.ensureSession")(
      {
        session_id: "sess1",
        agent_id: "a1",
        user_id: "u1",
        title: "t".repeat(300),
        preview: "p".repeat(600),
      },
      "a1",
    );

    const params = query.mock.calls[0][1];
    expect(params[3]).toHaveLength(255);
    expect(params[4]).toHaveLength(500);
  });

  it("persists delegation lineage fields", async () => {
    const query = mockQuery([]);

    await getHandler("chat.ensureSession")(
      {
        session_id: "child",
        agent_id: "target-agent",
        user_id: "u1",
        parent_session_id: "parent",
        parent_agent_id: "parent-agent",
        delegation_id: "delegation-1",
        target_agent_id: "target-agent",
      },
      "target-agent",
    );
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining([
      "parent",
      "parent-agent",
      "delegation-1",
      "target-agent",
    ]));
  });
});

describe("chat.resolveSession", () => {
  it("returns found with user_id and agent_id when row exists", async () => {
    mockQuery([{ user_id: "u1", agent_id: "a1" }]);
    const result = await getHandler("chat.resolveSession")(
      { session_id: "sess1" }, "a1",
    );
    expect(result).toEqual({ found: true, user_id: "u1", agent_id: "a1" });
  });

  it("returns found:false when sessionId is unknown", async () => {
    mockQuery([]);
    const result = await getHandler("chat.resolveSession")(
      { session_id: "nope" }, "a1",
    );
    expect(result).toEqual({ found: false });
  });

  it("still resolves attribution for a soft-deleted session — late callbacks must find userId", async () => {
    // The SQL deliberately omits `AND deleted_at IS NULL` so that audit
    // attribution does not vanish when a user soft-deletes their chat.
    // This test pins the invariant: a row whose deleted_at is non-null
    // still surfaces through chat.resolveSession.
    const query = mockQuery([{ user_id: "u-deleted", agent_id: "a-deleted" }]);
    const result = await getHandler("chat.resolveSession")(
      { session_id: "sess-soft-deleted" }, "a1",
    );
    expect(result).toEqual({ found: true, user_id: "u-deleted", agent_id: "a-deleted" });
    // Defense in depth: the SQL must not mention deleted_at. If anyone
    // re-adds that predicate in a future "cleanup" PR this regresses.
    const sql = (query.mock.calls[0][0] as string).toLowerCase();
    expect(sql).not.toContain("deleted_at");
  });
});

describe("chat.appendMessage", () => {
  it("inserts message and bumps session count", async () => {
    const query = mockQuery([], []);

    const result = await getHandler("chat.appendMessage")(
      { session_id: "sess1", role: "user", content: "Hello", metadata: { key: "val" } }, "a1",
    );
    expect(result.id).toBeDefined();
    expect(typeof result.id).toBe("string");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("inserts delegated message lineage", async () => {
    const query = mockQuery([], []);

    await getHandler("chat.appendMessage")(
      {
        session_id: "child",
        role: "assistant",
        content: "Child result",
        from_agent_id: "target-agent",
        parent_session_id: "parent",
        delegation_id: "delegation-1",
        target_agent_id: "target-agent",
      },
      "target-agent",
    );
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining([
      "target-agent",
      "parent",
      "delegation-1",
    ]));
  });
});

describe("chat.updateMessage", () => {
  it("updates message fields without bumping session count", async () => {
    const query = mockQuery([], []);

    const result = await getHandler("chat.updateMessage")(
      {
        id: "msg-1",
        session_id: "sess1",
        content: "Done",
        tool_name: "delegate_to_agent",
        tool_input: "{\"scope\":\"check\"}",
        metadata: "{\"summary\":\"ok\"}",
        outcome: "success",
        duration_ms: 123,
      },
      "a1",
    );

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("UPDATE chat_messages");
    expect(query.mock.calls[0][1]).toEqual([
      "Done",
      "delegate_to_agent",
      "{\"scope\":\"check\"}",
      "{\"summary\":\"ok\"}",
      "success",
      123,
      null,
      "msg-1",
      "sess1",
    ]);
    expect(query.mock.calls[1][0]).toContain("UPDATE chat_sessions SET last_active_at");
  });
});

describe("chat.updateDelegationToolMessage", () => {
  it("updates async delegation tool rows by delegation id", async () => {
    const query = mockQuery([], []);

    const result = await getHandler("chat.updateDelegationToolMessage")(
      {
        session_id: "sess1",
        tool_name: "delegate_to_agents",
        delegation_id: "call-1",
        content: "{\"status\":\"done\"}",
        metadata: "{\"status\":\"done\"}",
        outcome: "success",
        duration_ms: 456,
      },
      "a1",
    );

    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0]).toContain("WHERE session_id = ? AND role = 'tool' AND tool_name = ? AND delegation_id = ?");
    expect(query.mock.calls[0][1]).toEqual([
      "{\"status\":\"done\"}",
      "{\"status\":\"done\"}",
      "success",
      456,
      "sess1",
      "delegate_to_agents",
      "call-1",
    ]);
    expect(query.mock.calls[1][0]).toContain("UPDATE chat_sessions SET last_active_at");
  });
});

describe("chat.getMessages", () => {
  it("returns messages for session", async () => {
    mockQuery([
      { id: "m1", session_id: "sess1", role: "user", content: "Hello", tool_name: null, tool_input: null, metadata: null, outcome: null, duration_ms: null, created_at: "2024-01-01" },
    ]);

    const result = await getHandler("chat.getMessages")(
      { session_id: "sess1" }, "a1",
    );
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe("m1");
  });

  it("applies before filter and custom limit", async () => {
    const query = mockQuery([]);

    await getHandler("chat.getMessages")(
      { session_id: "sess1", before: "2024-06-01T00:00:00Z", limit: 10 }, "a1",
    );
    expect(query.mock.calls[0][1]).toHaveLength(3); // session_id, before date, limit
    expect(query.mock.calls[0][1][2]).toBe(10);
  });
});

// ================================================================
// task.*
// ================================================================

describe("task.listActive", () => {
  it("returns active tasks", async () => {
    mockQuery([
      { id: "t1", agent_id: "a1", name: "Cleanup", description: "Clean old pods", schedule: "0 * * * *", prompt: "Clean pods", status: "active", created_by: "u1", last_run_at: null, last_result: null },
    ]);

    const result = await getHandler("task.listActive")({}, "a1");
    expect(result.data).toHaveLength(1);
    expect(result.data[0].name).toBe("Cleanup");
  });
});

describe("task.getStatus", () => {
  it("returns task status", async () => {
    mockQuery([{ status: "active" }]);
    const result = await getHandler("task.getStatus")({ taskId: "t1" }, "a1");
    expect(result).toEqual({ status: "active" });
  });

  it("returns null status when task not found", async () => {
    mockQuery([]);
    const result = await getHandler("task.getStatus")({ taskId: "t1" }, "a1");
    expect(result).toEqual({ status: null });
  });
});

describe("task.list", () => {
  it("returns tasks for agent and user", async () => {
    mockQuery([
      { id: "t1", name: "Task 1", schedule: "0 * * * *", status: "active", description: null, prompt: "do thing", last_run_at: null, last_result: null },
    ]);

    const result = await getHandler("task.list")(
      { agent_id: "a1", user_id: "u1" }, "a1",
    );
    expect(result.tasks).toHaveLength(1);
  });
});

describe("task.create", () => {
  it("inserts task and returns the created row", async () => {
    mockQuery(
      [],
      [{ id: "t1", agent_id: "a1", name: "New Task", description: null, schedule: "0 * * * *", prompt: "do thing", status: "active", created_by: "u1" }],
    );

    const result = await getHandler("task.create")(
      { id: "t1", agent_id: "a1", user_id: "u1", name: "New Task", schedule: "0 * * * *", prompt: "do thing" }, "a1",
    );
    expect(result.id).toBe("t1");
    expect(result.name).toBe("New Task");
  });
});

describe("task.update", () => {
  it("updates task and returns updated row", async () => {
    mockQuery(
      [{ id: "t1" }],  // existing check
      [],               // update
      [{ id: "t1", name: "Updated", schedule: "0 */2 * * *", status: "active" }],  // select
    );

    const result = await getHandler("task.update")(
      { task_id: "t1", agent_id: "a1", user_id: "u1", name: "Updated" }, "a1",
    );
    expect(result.name).toBe("Updated");
  });

  it("throws when task not found", async () => {
    mockQuery([]);
    await expect(
      getHandler("task.update")({ task_id: "t1", agent_id: "a1", user_id: "u1" }, "a1"),
    ).rejects.toThrow("Task not found");
  });
});

describe("task.delete", () => {
  it("deletes task", async () => {
    mockQuery(
      [{ id: "t1" }],  // existing check
      [],               // delete
    );

    const result = await getHandler("task.delete")(
      { task_id: "t1", agent_id: "a1", user_id: "u1" }, "a1",
    );
    expect(result).toEqual({ ok: true });
  });

  it("throws when task not found", async () => {
    mockQuery([]);
    await expect(
      getHandler("task.delete")({ task_id: "t1", agent_id: "a1", user_id: "u1" }, "a1"),
    ).rejects.toThrow("Task not found");
  });
});

describe("task.runRecord", () => {
  it("inserts run record and updates task metadata", async () => {
    const query = mockQuery([], []);

    const result = await getHandler("task.runRecord")(
      { id: "r1", task_id: "t1", status: "success", result_text: "OK", error: null, duration_ms: 5000, session_id: "sess1" }, "a1",
    );
    expect(result).toEqual({ ok: true });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("task.runStart", () => {
  it("inserts a running task run row", async () => {
    const query = mockQuery([]);

    const result = await getHandler("task.runStart")(
      { id: "r1", task_id: "t1", session_id: "sess1" }, "a1",
    );
    expect(result).toEqual({ id: "r1" });
    expect(query.mock.calls[0][1]).toEqual(["r1", "t1", "sess1"]);
  });
});

describe("task.runFinalize", () => {
  it("updates run with result", async () => {
    const query = mockQuery([]);

    const result = await getHandler("task.runFinalize")(
      { run_id: "r1", status: "success", result_text: "All good", error: null, duration_ms: 3000 }, "a1",
    );
    expect(result).toEqual({ ok: true });
    expect(query.mock.calls[0][1]).toEqual(["success", "All good", null, 3000, "r1"]);
  });
});

describe("task.updateMeta", () => {
  it("updates task last_result", async () => {
    const query = mockQuery([]);

    const result = await getHandler("task.updateMeta")(
      { task_id: "t1", last_result: "success" }, "a1",
    );
    expect(result).toEqual({ ok: true });
    expect(query.mock.calls[0][1]).toEqual(["success", "t1"]);
  });
});

describe("task.fireNow", () => {
  it("returns ok when task can fire", async () => {
    const taskRow = {
      id: "t1", agent_id: "a1", name: "Task", description: null,
      schedule: "0 * * * *", prompt: "go", status: "active", created_by: "u1",
      last_run_at: null, last_result: null, last_manual_run_at: null,
    };
    mockQuery(
      [taskRow],   // task lookup
      [],          // no in-flight runs
      [],          // stamp update
    );

    const result = await getHandler("task.fireNow")(
      { task_id: "t1", cooldown_sec: 60 }, "a1",
    );
    expect(result.outcome).toBe("ok");
    expect(result.task).toBeDefined();
  });

  it("returns not_found when task does not exist", async () => {
    mockQuery([]);
    const result = await getHandler("task.fireNow")(
      { task_id: "t1", cooldown_sec: 60 }, "a1",
    );
    expect(result).toEqual({ outcome: "not_found" });
  });

  it("returns in_flight when run is already running", async () => {
    mockQuery(
      [{ id: "t1", last_manual_run_at: null }],
      [{ id: "r1" }],  // in-flight run
    );

    const result = await getHandler("task.fireNow")(
      { task_id: "t1", cooldown_sec: 60 }, "a1",
    );
    expect(result).toEqual({ outcome: "in_flight" });
  });

  it("returns cooldown when fired too recently", async () => {
    const recentTime = new Date(Date.now() - 10_000).toISOString(); // 10 seconds ago
    mockQuery(
      [{ id: "t1", last_manual_run_at: recentTime }],
      [],  // no in-flight runs
    );

    const result = await getHandler("task.fireNow")(
      { task_id: "t1", cooldown_sec: 60 }, "a1",
    );
    expect(result.outcome).toBe("cooldown");
    expect(result.retry_after_sec).toBeGreaterThan(0);
  });
});

describe("task.prune", () => {
  it("prunes old sessions and runs", async () => {
    mockQuery(
      { affectedRows: 3 } as any,  // sessions deleted
      { affectedRows: 5 } as any,  // runs deleted
    );

    const result = await getHandler("task.prune")(
      { retention_days: 30 }, "a1",
    );
    expect(result.sessions_deleted).toBe(3);
    expect(result.runs_deleted).toBe(5);
  });

  it("defaults to 0 when affectedRows is undefined", async () => {
    mockQuery(
      {} as any,
      {} as any,
    );

    const result = await getHandler("task.prune")(
      { retention_days: 30 }, "a1",
    );
    expect(result.sessions_deleted).toBe(0);
    expect(result.runs_deleted).toBe(0);
  });
});

// ================================================================
// channel.*
// ================================================================

describe("channel.list", () => {
  it("returns active channels", async () => {
    mockQuery([
      { id: "ch1", name: "slack", status: "active", created_at: "2024-01-01" },
    ]);

    const result = await getHandler("channel.list")({}, "a1");
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe("ch1");
  });

  it("injects group_channel_id for an open personal-bot channel", async () => {
    mockQuery([{
      id: "ch-personal", name: "bot", status: "active", created_at: "2024-01-01",
      config: JSON.stringify({ app_id: "x", personal_bot: { agent_id: "a1", access_mode: "open" } }),
    }]);
    const result = await getHandler("channel.list")({}, "a1");
    expect(result.data[0].config.group_channel_id).toBe("ch-personal");
  });

  it("does not inject group_channel_id when group_auto_bind is false", async () => {
    mockQuery([{
      id: "ch-personal", name: "bot", status: "active", created_at: "2024-01-01",
      config: JSON.stringify({ app_id: "x", personal_bot: { agent_id: "a1", access_mode: "open", group_auto_bind: false } }),
    }]);
    const result = await getHandler("channel.list")({}, "a1");
    expect(result.data[0].config.group_channel_id).toBeUndefined();
  });
});

describe("channel.resolveBinding", () => {
  it("returns binding when found", async () => {
    mockQuery([{ id: "b1", agent_id: "a1", session_id: "s1", route_type: "group", created_by: "u1" }]);

    const result = await getHandler("channel.resolveBinding")(
      { channel_id: "ch1", route_key: "group-123" }, "a1",
    );
    expect(result.binding).toEqual({ agentId: "a1", bindingId: "b1", sessionId: "s1", createdBy: "u1", routeType: "group" });
  });

  it("lazily creates a session for legacy bindings", async () => {
    const query = mockQuery(
      [{ id: "b1", agent_id: "a1", session_id: null, route_type: "group", created_by: "u1" }],
      [],
      [{ id: "b1", agent_id: "a1", session_id: "s-new", route_type: "group", created_by: "u1" }],
    );

    const result = await getHandler("channel.resolveBinding")(
      { channel_id: "ch1", route_key: "group-123" }, "a1",
    );

    expect(query.mock.calls[1][0]).toContain("UPDATE channel_bindings SET session_id");
    expect(result.binding).toEqual({ agentId: "a1", bindingId: "b1", sessionId: "s-new", createdBy: "u1", routeType: "group" });
  });

  it("lazily creates a participant session when session_key is provided", async () => {
    const query = mockQuery(
      [{ id: "b1", agent_id: "a1", session_id: "shared-session", route_type: "group", created_by: "u1" }],
      [],
      [],
      [{ session_id: "sender-session" }],
    );

    const result = await getHandler("channel.resolveBinding")(
      { channel_id: "ch1", route_key: "group-123", session_key: "open_id:ou_1" }, "a1",
    );

    expect(query.mock.calls[1][0]).toContain("FROM channel_binding_sessions");
    expect(query.mock.calls[2][0]).toContain("INTO channel_binding_sessions");
    expect(query.mock.calls[2][1]).toEqual([
      expect.any(String),
      "b1",
      "open_id:ou_1",
      expect.any(String),
    ]);
    expect(result.binding).toEqual({
      agentId: "a1",
      bindingId: "b1",
      sessionId: "sender-session",
      sessionKey: "open_id:ou_1",
      createdBy: "u1",
      routeType: "group",
    });
  });

  it("returns null binding when not found", async () => {
    // No explicit binding, and the channel is not a personal-bot channel
    // (selectPersonalChannel → none), so the open-group fallback also yields null.
    mockQuery([], []);

    const result = await getHandler("channel.resolveBinding")(
      { channel_id: "ch1", route_key: "group-999" }, "a1",
    );
    expect(result).toEqual({ binding: null });
  });

  it("open personal-bot auto-binds a group with a shared per-chat session", async () => {
    mockQuery(
      [],                                                                  // selectChannelBinding → none
      [{ id: "ch1", created_by: "owner-1", config: JSON.stringify({ personal_bot: { agent_id: "a1", access_mode: "open" } }) }], // selectPersonalChannel
      [],                                                                  // participant session lookup → none
      [],                                                                  // insert participant session
      [{ session_id: "chat-session" }],                                    // participant session reload
    );

    const result = await getHandler("channel.resolveBinding")(
      { channel_id: "ch1", route_key: "group-123", session_key: "open_id:ou_1", sender_open_id: "ou_1" }, "a1",
    );
    expect(result.binding).toEqual({
      agentId: "a1",
      bindingId: "ch1",
      sessionId: "chat-session",
      sessionKey: "chat:group-123",
      createdBy: "owner-1",
      routeType: "group",
    });
  });

  it("punts (null) on a sicore_authorized personal bot in standalone", async () => {
    mockQuery(
      [],                                                                  // selectChannelBinding → none
      [{ id: "ch1", created_by: "owner-1", config: JSON.stringify({ personal_bot: { agent_id: "a1", access_mode: "sicore_authorized" } }) }],
    );

    const result = await getHandler("channel.resolveBinding")(
      { channel_id: "ch1", route_key: "group-123", sender_open_id: "ou_1" }, "a1",
    );
    expect(result).toEqual({ binding: null });
  });
});

describe("channel.pair", () => {
  it("creates binding from valid pairing code", async () => {
    const query = mockQuery(
      [{ agent_id: "a1", created_by: "u1" }],  // pairing code lookup
      [],                                         // existing binding lookup
      [],                                         // insert binding
      [{ id: "b-new", agent_id: "a1", session_id: "binding-session", route_type: "group", created_by: "u1" }],
      [],                                         // clear participant sessions
      [],                                         // delete code
      [{ name: "My Agent" }],                     // agent name lookup
    );

    const result = await getHandler("channel.pair")(
      { code: "ABC123", channel_id: "ch1", route_key: "group-1", route_type: "group" }, "a1",
    );
    expect(result.success).toBe(true);
    expect(result.agentName).toBe("My Agent");
    expect(query.mock.calls[2][0]).toContain("session_id");
    expect(query.mock.calls[2][1]).toEqual([
      expect.any(String),
      "ch1",
      "a1",
      expect.any(String),
      "group-1",
      "group",
      "u1",
    ]);
    expect(query.mock.calls[4][0]).toContain("DELETE FROM channel_binding_sessions");
  });

  it("returns error for invalid pairing code", async () => {
    mockQuery([]);

    const result = await getHandler("channel.pair")(
      { code: "INVALID", channel_id: "ch1", route_key: "group-1", route_type: "group" }, "a1",
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid or expired");
  });

  it("returns error when binding insert fails", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ agent_id: "a1", created_by: "u1" }], []])
      .mockResolvedValueOnce([[], []])
      .mockRejectedValueOnce(new Error("Duplicate entry"));
    (getDb as any).mockReturnValue({ query });

    const result = await getHandler("channel.pair")(
      { code: "ABC123", channel_id: "ch1", route_key: "group-1", route_type: "group" }, "a1",
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to create binding");
  });
});

describe("channel.resetSession", () => {
  it("replaces the binding session id", async () => {
    const query = mockQuery(
      [{ id: "b1", agent_id: "a1", session_id: "old-session", route_type: "group", created_by: "u1" }],
      [],
    );

    const result = await getHandler("channel.resetSession")(
      { channel_id: "ch1", route_key: "group-1" }, "a1",
    );

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("a1");
    expect(result.oldSessionId).toBe("old-session");
    expect(result.sessionId).toEqual(expect.any(String));
    expect(query.mock.calls[1][0]).toContain("UPDATE channel_bindings SET session_id");
  });

  it("replaces only the participant session when session_key is provided", async () => {
    const query = mockQuery(
      [{ id: "b1", agent_id: "a1", session_id: "shared-session", route_type: "group", created_by: "u1" }],
      [{ session_id: "old-sender-session" }],
      [],
    );

    const result = await getHandler("channel.resetSession")(
      { channel_id: "ch1", route_key: "group-1", session_key: "open_id:ou_1" }, "a1",
    );

    expect(result.success).toBe(true);
    expect(result.agentId).toBe("a1");
    expect(result.oldSessionId).toBe("old-sender-session");
    expect(result.sessionId).toEqual(expect.any(String));
    expect(query.mock.calls[2][0]).toContain("channel_binding_sessions");
    expect(query.mock.calls[2][1]).toEqual([
      expect.any(String),
      "b1",
      "open_id:ou_1",
      expect.any(String),
    ]);
  });

  it("returns an error when the binding is missing", async () => {
    mockQuery([]);

    const result = await getHandler("channel.resetSession")(
      { channel_id: "ch1", route_key: "group-missing" }, "a1",
    );

    expect(result).toEqual({ success: false, error: "Binding not found" });
  });
});

// ================================================================
// agent.*
// ================================================================

describe("agent.listForSkill", () => {
  it("returns agent IDs for skill without dev_only", async () => {
    mockQuery([{ agent_id: "a1" }, { agent_id: "a2" }]);

    const result = await getHandler("agent.listForSkill")(
      { skillId: "s1" }, "a1",
    );
    expect(result.agent_ids).toEqual(["a1", "a2"]);
  });

  it("uses filtered query with dev_only", async () => {
    const query = mockQuery([{ agent_id: "a2" }]);

    const result = await getHandler("agent.listForSkill")(
      { skillId: "s1", dev_only: true }, "a1",
    );
    expect(result.agent_ids).toEqual(["a2"]);
    expect(query.mock.calls[0][0]).toContain("is_production = 0");
  });
});

describe("agent.listForMcp", () => {
  it("returns agent IDs for MCP server", async () => {
    mockQuery([{ agent_id: "a1" }]);
    const result = await getHandler("agent.listForMcp")({ mcpId: "m1" }, "a1");
    expect(result.agent_ids).toEqual(["a1"]);
  });
});

describe("agent.listForCluster", () => {
  it("returns agent IDs for cluster", async () => {
    mockQuery([{ agent_id: "a1" }, { agent_id: "a3" }]);
    const result = await getHandler("agent.listForCluster")({ clusterId: "c1" }, "a1");
    expect(result.agent_ids).toEqual(["a1", "a3"]);
  });
});

describe("agent.listForHost", () => {
  it("returns agent IDs for host", async () => {
    mockQuery([{ agent_id: "a2" }]);
    const result = await getHandler("agent.listForHost")({ hostId: "h1" }, "a1");
    expect(result.agent_ids).toEqual(["a2"]);
  });
});

// ================================================================
// metrics.*
// ================================================================

describe("metrics.summary", () => {
  it("returns summary with default 7d period (no per-user breakdown)", async () => {
    const query = mockQuery(
      [{ c: 10 }],   // total sessions
      [{ c: 50 }],   // total prompts
    );

    const result = await getHandler("metrics.summary")({}, "a1");
    expect(result.totalSessions).toBe(10);
    expect(result.totalPrompts).toBe(50);
    // byUser was dropped — this mirror must not ship raw per-user data.
    expect(result).not.toHaveProperty("byUser");
    expect(query.mock.calls[1][0]).toContain('metadata NOT LIKE \'%"kind":"delegation_event"%\'');
  });

  it("runs only the two scalar queries (no byUser) with a userId filter", async () => {
    const query = mockQuery(
      [{ c: 3 }],
      [{ c: 15 }],
    );

    const result = await getHandler("metrics.summary")({ period: "today", userId: "u1" }, "a1");
    expect(result.totalSessions).toBe(3);
    expect(result.totalPrompts).toBe(15);
    expect(result).not.toHaveProperty("byUser");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("throws for invalid period", async () => {
    await expect(
      getHandler("metrics.summary")({ period: "invalid" }, "a1"),
    ).rejects.toThrow("Invalid period");
  });
});

describe("metrics.audit", () => {
  it("returns audit logs", async () => {
    mockQuery([
      { id: "m1", sessionId: "sess1", toolName: "bash", toolInput: "ls", outcome: "success", durationMs: 100, timestamp: "2024-01-01T00:00:00Z", userId: "u1", agentId: "a1" },
    ]);

    const result = await getHandler("metrics.audit")({}, "a1");
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0].toolName).toBe("bash");
    expect(result.hasMore).toBe(false);
  });

  it("sets hasMore when results exceed limit", async () => {
    // Create 2 rows, but set limit to 1
    mockQuery([
      { id: "m1", sessionId: "s1", toolName: "bash", toolInput: "ls", outcome: "success", durationMs: 100, timestamp: "2024-01-01", userId: "u1", agentId: "a1" },
      { id: "m2", sessionId: "s1", toolName: "bash", toolInput: "pwd", outcome: "success", durationMs: 50, timestamp: "2024-01-01", userId: "u1", agentId: "a1" },
    ]);

    const result = await getHandler("metrics.audit")({ limit: "1" }, "a1");
    expect(result.logs).toHaveLength(1);
    expect(result.hasMore).toBe(true);
  });

  it("converts Date timestamps to ISO strings", async () => {
    const date = new Date("2024-06-15T12:00:00Z");
    mockQuery([
      { id: "m1", sessionId: "s1", toolName: "bash", toolInput: "ls", outcome: "success", durationMs: 100, timestamp: date, userId: "u1", agentId: "a1" },
    ]);

    const result = await getHandler("metrics.audit")({}, "a1");
    expect(result.logs[0].timestamp).toBe("2024-06-15T12:00:00.000Z");
  });
});

describe("metrics.auditDetail", () => {
  it("returns detailed audit entry", async () => {
    mockQuery([
      { id: "m1", sessionId: "sess1", toolName: "bash", toolInput: "ls -la", content: "file1\nfile2", outcome: "success", durationMs: 150, timestamp: "2024-01-01T00:00:00Z", userId: "u1", agentId: "a1" },
    ]);

    const result = await getHandler("metrics.auditDetail")({ id: "m1" }, "a1");
    expect(result.id).toBe("m1");
    expect(result.content).toBe("file1\nfile2");
    expect(result.toolInput).toBe("ls -la");
  });

  it("throws when entry not found", async () => {
    mockQuery([]);
    await expect(
      getHandler("metrics.auditDetail")({ id: "missing" }, "a1"),
    ).rejects.toThrow("Not found");
  });
});

// ================================================================
// Handler count verification
// ================================================================

describe("buildAdapterRpcHandlers", () => {
  it("registers exactly 48 handlers", () => {
    const handlers = buildAdapterRpcHandlers();
    expect(handlers.size).toBe(48);
  });

  it("all expected handler names are registered", () => {
    const handlers = buildAdapterRpcHandlers();
    const expected = [
      "config.getAgent", "config.getResources", "config.getSettings",
      "config.getModelBinding", "config.getMcpServers", "config.getSkillBundle", "config.getKnowledgeBundle",
      "config.getSystemConfig", "config.setSystemConfig", "config.getDefaultModel",
      "credential.list", "credential.get", "credential.checkAccess",
      "credential.resourceManifest", "credential.hostSearch",
      "chat.ensureSession", "chat.resolveSession", "chat.appendMessage", "chat.updateMessage", "chat.updateDelegationToolMessage", "chat.getMessages",
      "task.listActive", "task.getStatus", "task.list", "task.create",
      "task.update", "task.delete", "task.runRecord", "task.runStart",
      "task.runFinalize", "task.updateMeta", "task.fireNow", "task.notify", "task.prune",
      "channel.list", "channel.resolveBinding", "channel.pair", "channel.resetSession",
      "channel.resolvePersonalBinding", "channel.pairPersonal", "channel.resetPersonalSession",
      "agent.listForSkill", "agent.listForMcp", "agent.listForCluster", "agent.listForHost",
      "metrics.summary", "metrics.audit", "metrics.auditDetail",
    ];
    for (const name of expected) {
      expect(handlers.has(name), `Missing handler: ${name}`).toBe(true);
    }
  });
});
