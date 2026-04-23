/**
 * Route-level tests for `registerCliSnapshotRoute`.
 *
 * Uses a real in-memory SQLite + runPortalMigrations so the SQL queries are
 * exercised against the same DDL Portal actually ships, catching dialect
 * issues the mocked-row unit tests wouldn't.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { initDb, closeDb, getDb } from "../gateway/db.js";
import { runPortalMigrations } from "./migrate.js";
import { createRestRouter } from "../gateway/rest-router.js";
import { registerCliSnapshotRoute } from "./cli-snapshot-api.js";

const CLI_SNAPSHOT_SECRET = "test-cli-snapshot-secret-DO-NOT-USE-IN-PROD";

function fakeReq(opts: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Defaults to 127.0.0.1 so the route's loopback check passes. */
  remoteAddress?: string;
}): any {
  const em = new EventEmitter() as any;
  em.url = opts.url;
  em.method = opts.method ?? "GET";
  em.headers = opts.headers ?? {};
  em.socket = { remoteAddress: opts.remoteAddress ?? "127.0.0.1" };
  return em;
}

/** Headers that satisfy both auth gates (loopback origin set via fakeReq). */
function authedHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "x-siclaw-cli-snapshot-secret": CLI_SNAPSHOT_SECRET,
    ...(extra ?? {}),
  };
}

function runRoute(router: ReturnType<typeof createRestRouter>, req: any) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const res: any = new EventEmitter();
    res.writeHead = (s: number) => { res._status = s; return res; };
    res.setHeader = () => res;
    res.end = (b?: string) => {
      resolve({ status: res._status ?? 0, body: b ? JSON.parse(b) : null });
      return res;
    };
    try {
      if (!router.handle(req, res)) reject(new Error("no route matched"));
    } catch (err) {
      reject(err);
    }
  });
}

describe("GET /api/v1/cli-snapshot", () => {
  let router: ReturnType<typeof createRestRouter>;

  beforeEach(async () => {
    initDb("sqlite::memory:");
    await runPortalMigrations();
    router = createRestRouter();
    registerCliSnapshotRoute(router, CLI_SNAPSHOT_SECRET);
  });

  afterEach(async () => {
    await closeDb();
  });

  it("returns 401 without the cli-snapshot secret header", async () => {
    const { status } = await runRoute(router, fakeReq({ url: "/api/v1/cli-snapshot" }));
    expect(status).toBe(401);
  });

  it("returns 401 with a wrong secret", async () => {
    const { status } = await runRoute(
      router,
      fakeReq({
        url: "/api/v1/cli-snapshot",
        headers: { "x-siclaw-cli-snapshot-secret": "wrong-secret" },
      }),
    );
    expect(status).toBe(401);
  });

  it("rejects a request that doesn't have the header even if a bearer JWT is present", async () => {
    // Hardening: the old scheme used jwtSecret-signed Bearer tokens; confirm
    // presenting one alone no longer unlocks the snapshot.
    const { status } = await runRoute(
      router,
      fakeReq({
        url: "/api/v1/cli-snapshot",
        headers: { authorization: "Bearer anything-here" },
      }),
    );
    expect(status).toBe(401);
  });

  it("rejects non-loopback request origins with 403 even when the secret is correct", async () => {
    const { status, body } = await runRoute(
      router,
      fakeReq({
        url: "/api/v1/cli-snapshot",
        headers: authedHeaders(),
        remoteAddress: "10.0.0.42",
      }),
    );
    expect(status).toBe(403);
    expect(body.error).toMatch(/loopback/i);
  });

  it("accepts ::1 and IPv4-mapped loopback (::ffff:127.0.0.1)", async () => {
    for (const remote of ["::1", "::ffff:127.0.0.1"]) {
      const { status } = await runRoute(
        router,
        fakeReq({
          url: "/api/v1/cli-snapshot",
          headers: authedHeaders(),
          remoteAddress: remote,
        }),
      );
      expect(status, `remoteAddress=${remote}`).toBe(200);
    }
  });

  it("returns empty shape when DB is empty (providers/mcp/skills/knowledge all []/{})", async () => {
    const { status, body } = await runRoute(
      router,
      fakeReq({ url: "/api/v1/cli-snapshot", headers: authedHeaders() }),
    );
    expect(status).toBe(200);
    expect(body.providers).toEqual({});
    expect(body.default).toBeNull();
    expect(body.mcpServers).toEqual({});
    expect(body.skills).toEqual([]);
    expect(body.knowledge).toEqual([]);
    expect(body.credentials).toEqual({ clusters: [], hosts: [] });
    expect(body.availableAgents).toEqual([]);
    expect(body.activeAgent).toBeNull();
    expect(typeof body.generatedAt).toBe("string");
  });

  it("joins model_providers × model_entries into ProviderConfig shape", async () => {
    const db = getDb();
    await db.query(
      "INSERT INTO model_providers (id, org_id, name, base_url, api_key, api_type, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["p1", "default", "openai", "https://api.openai.com/v1", "sk-test", "openai-completions", 0],
    );
    await db.query(
      "INSERT INTO model_entries (id, provider_id, model_id, name, reasoning, context_window, max_tokens, is_default, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["m1", "p1", "gpt-4o", "GPT-4o", 0, 128000, 8192, 1, 0],
    );

    const { status, body } = await runRoute(
      router,
      fakeReq({ url: "/api/v1/cli-snapshot", headers: authedHeaders() }),
    );
    expect(status).toBe(200);
    expect(body.providers.openai).toBeDefined();
    expect(body.providers.openai.baseUrl).toBe("https://api.openai.com/v1");
    expect(body.providers.openai.apiKey).toBe("sk-test");
    expect(body.providers.openai.api).toBe("openai-completions");
    expect(body.providers.openai.models).toHaveLength(1);
    expect(body.providers.openai.models[0].id).toBe("gpt-4o");
    expect(body.providers.openai.models[0].contextWindow).toBe(128000);
    expect(body.default).toEqual({ provider: "openai", modelId: "gpt-4o" });
  });

  it("falls back to first model when no is_default is set", async () => {
    const db = getDb();
    await db.query(
      "INSERT INTO model_providers (id, org_id, name, base_url, api_key, api_type, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["p1", "default", "openai", "https://api.openai.com/v1", "sk-test", "openai-completions", 0],
    );
    await db.query(
      "INSERT INTO model_entries (id, provider_id, model_id, name, reasoning, context_window, max_tokens, is_default, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["m1", "p1", "gpt-4o-mini", "GPT-4o-mini", 0, 128000, 8192, 0, 0],
    );

    const { body } = await runRoute(
      router,
      fakeReq({ url: "/api/v1/cli-snapshot", headers: authedHeaders() }),
    );
    expect(body.default).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
  });

  it("excludes disabled MCP servers (enabled = 0)", async () => {
    const db = getDb();
    await db.query(
      "INSERT INTO mcp_servers (id, org_id, name, transport, url, command, args, env, headers, enabled, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["x1", "default", "enabled-one", "http", "https://a.example", null, null, null, null, 1, null, "system"],
    );
    await db.query(
      "INSERT INTO mcp_servers (id, org_id, name, transport, url, command, args, env, headers, enabled, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["x2", "default", "disabled-one", "http", "https://b.example", null, null, null, null, 0, null, "system"],
    );

    const { body } = await runRoute(
      router,
      fakeReq({ url: "/api/v1/cli-snapshot", headers: authedHeaders() }),
    );
    expect(Object.keys(body.mcpServers)).toEqual(["enabled-one"]);
  });

  it("surfaces custom skills with their specs + scripts", async () => {
    const db = getDb();
    const specs = "---\nname: my-custom-skill\ndescription: test\n---\n# Body\n";
    const scripts = JSON.stringify([{ name: "run.sh", content: "#!/bin/bash\necho hi\n" }]);
    await db.query(
      "INSERT INTO skills (id, org_id, name, description, author_id, status, version, specs, scripts, created_by, is_builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["s1", "default", "my-custom-skill", "test", "u", "active", 1, specs, scripts, "u", 0],
    );

    const { body } = await runRoute(
      router,
      fakeReq({ url: "/api/v1/cli-snapshot", headers: authedHeaders() }),
    );
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0].name).toBe("my-custom-skill");
    expect(body.skills[0].specs).toBe(specs);
    expect(body.skills[0].scripts).toEqual([{ name: "run.sh", content: "#!/bin/bash\necho hi\n" }]);
  });

  it("returns only active knowledge_versions, dataBase64 round-trips the blob", async () => {
    const db = getDb();
    const tarBlob = Buffer.from("not-really-a-tar-but-ok");
    await db.query(
      "INSERT INTO knowledge_repos (id, name, description, created_by) VALUES (?, ?, ?, ?)",
      ["r1", "siclaw-wiki", "test", "system"],
    );
    await db.query(
      `INSERT INTO knowledge_versions (id, repo_id, version, message, data, size_bytes, sha256, file_count, is_active, status, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["v1", "r1", 1, "smoke", tarBlob, tarBlob.length, "fake-sha", 5, 1, "active", "system"],
    );
    // Inactive version should NOT appear.
    await db.query(
      `INSERT INTO knowledge_versions (id, repo_id, version, message, data, size_bytes, sha256, file_count, is_active, status, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["v2", "r1", 2, "inactive", Buffer.from("old"), 3, null, 0, 0, "inactive", "system"],
    );

    const { body } = await runRoute(
      router,
      fakeReq({ url: "/api/v1/cli-snapshot", headers: authedHeaders() }),
    );
    expect(body.knowledge).toHaveLength(1);
    expect(body.knowledge[0].name).toBe("siclaw-wiki");
    expect(body.knowledge[0].version).toBe(1);
    expect(body.knowledge[0].fileCount).toBe(5);
    expect(Buffer.from(body.knowledge[0].dataBase64, "base64").toString()).toBe("not-really-a-tar-but-ok");
  });

  it("returns clusters with non-empty kubeconfigs and skips empty-kubeconfig rows", async () => {
    const db = getDb();
    await db.query(
      "INSERT INTO clusters (id, name, description, kubeconfig, api_server, is_production) VALUES (?, ?, ?, ?, ?, ?)",
      ["c1", "prod-east", "east", "apiVersion: v1\nclusters: []", "https://kube.example", 1],
    );
    await db.query(
      "INSERT INTO clusters (id, name, description, kubeconfig, api_server, is_production) VALUES (?, ?, ?, ?, ?, ?)",
      ["c2", "no-kubeconfig", null, "", null, 0],  // empty -> filtered
    );
    const { body } = await runRoute(
      router,
      fakeReq({ url: "/api/v1/cli-snapshot", headers: authedHeaders() }),
    );
    expect(body.credentials.clusters).toHaveLength(1);
    expect(body.credentials.clusters[0].name).toBe("prod-east");
    expect(body.credentials.clusters[0].kubeconfig).toContain("apiVersion: v1");
  });

  it("returns hosts with usable credential material, skips hosts with neither password nor key", async () => {
    const db = getDb();
    await db.query(
      "INSERT INTO hosts (id, name, ip, port, username, auth_type, password, private_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["h1", "pwd-host", "10.0.0.1", 22, "root", "password", "correct-horse", null],
    );
    await db.query(
      "INSERT INTO hosts (id, name, ip, port, username, auth_type, password, private_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["h2", "key-host", "10.0.0.2", 2222, "ops", "key", null, "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END-----"],
    );
    await db.query(
      "INSERT INTO hosts (id, name, ip, port, username, auth_type, password, private_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["h3", "broken-host", "10.0.0.3", 22, "root", "password", null, null],  // no creds -> filtered
    );
    const { body } = await runRoute(
      router,
      fakeReq({ url: "/api/v1/cli-snapshot", headers: authedHeaders() }),
    );
    expect(body.credentials.hosts).toHaveLength(2);
    const pwd = body.credentials.hosts.find((h: any) => h.name === "pwd-host");
    expect(pwd.authType).toBe("password");
    expect(pwd.password).toBe("correct-horse");
    expect(pwd.privateKey).toBeNull();
    const key = body.credentials.hosts.find((h: any) => h.name === "key-host");
    expect(key.authType).toBe("key");
    expect(key.password).toBeNull();
    expect(key.privateKey).toContain("BEGIN OPENSSH");
  });

  // ── Agent binding ────────────────────────────────────────────────

  it("populates availableAgents even when the request is unscoped", async () => {
    const db = getDb();
    await db.query(
      "INSERT INTO agents (id, name, description, status, model_provider, model_id, is_production, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["a1", "gpu-sre", "GPU cluster SRE", "active", "openai", "gpt-4o", 1, "u"],
    );
    await db.query(
      "INSERT INTO agents (id, name, description, status, model_provider, model_id, is_production, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["a2", "cost-advisor", null, "active", null, null, 1, "u"],
    );
    const { body } = await runRoute(
      router,
      fakeReq({ url: "/api/v1/cli-snapshot", headers: authedHeaders() }),
    );
    expect(body.availableAgents).toHaveLength(2);
    expect(body.availableAgents.map((a: any) => a.name)).toEqual(["cost-advisor", "gpu-sre"]);
    expect(body.activeAgent).toBeNull();
  });

  it("returns 404 with availableAgents list when ?agent=<unknown>", async () => {
    const db = getDb();
    await db.query(
      "INSERT INTO agents (id, name, status, is_production, created_by) VALUES (?, ?, ?, ?, ?)",
      ["a1", "real-agent", "active", 1, "u"],
    );
    const { status, body } = await runRoute(
      router,
      fakeReq({
        url: "/api/v1/cli-snapshot?agent=does-not-exist",
        headers: authedHeaders(),
      }),
    );
    expect(status).toBe(404);
    expect(body.availableAgents).toContain("real-agent");
  });

  it("scopes skills / mcp / knowledge / clusters / hosts to the agent's junction rows", async () => {
    const db = getDb();
    // Insert an agent
    await db.query(
      "INSERT INTO agents (id, name, status, system_prompt, model_provider, model_id, is_production, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["ag1", "scoped-agent", "active", "You are a scoped agent.", "openai", "gpt-4o", 1, "u"],
    );
    // 2 skills; 1 bound
    const specsA = "---\nname: bound-skill\n---\nbody";
    const specsB = "---\nname: unbound-skill\n---\nbody";
    await db.query(
      "INSERT INTO skills (id, org_id, name, description, author_id, status, version, specs, scripts, created_by, is_builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["s1", "default", "bound-skill", "x", "u", "active", 1, specsA, "[]", "u", 0],
    );
    await db.query(
      "INSERT INTO skills (id, org_id, name, description, author_id, status, version, specs, scripts, created_by, is_builtin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["s2", "default", "unbound-skill", "x", "u", "active", 1, specsB, "[]", "u", 0],
    );
    await db.query("INSERT INTO agent_skills (agent_id, skill_id) VALUES (?, ?)", ["ag1", "s1"]);

    // 2 MCP servers; 1 bound
    await db.query(
      "INSERT INTO mcp_servers (id, org_id, name, transport, url, enabled, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["m1", "default", "bound-mcp", "http", "https://a.example", 1, "u"],
    );
    await db.query(
      "INSERT INTO mcp_servers (id, org_id, name, transport, url, enabled, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["m2", "default", "unbound-mcp", "http", "https://b.example", 1, "u"],
    );
    await db.query("INSERT INTO agent_mcp_servers (agent_id, mcp_server_id) VALUES (?, ?)", ["ag1", "m1"]);

    // 2 clusters; 1 bound
    await db.query(
      "INSERT INTO clusters (id, name, kubeconfig, is_production) VALUES (?, ?, ?, ?)",
      ["c1", "bound-cluster", "apiVersion: v1\nkind: Config", 1],
    );
    await db.query(
      "INSERT INTO clusters (id, name, kubeconfig, is_production) VALUES (?, ?, ?, ?)",
      ["c2", "unbound-cluster", "apiVersion: v1\nkind: Config", 1],
    );
    await db.query("INSERT INTO agent_clusters (agent_id, cluster_id) VALUES (?, ?)", ["ag1", "c1"]);

    const { status, body } = await runRoute(
      router,
      fakeReq({
        url: "/api/v1/cli-snapshot?agent=scoped-agent",
        headers: authedHeaders(),
      }),
    );
    expect(status).toBe(200);
    expect(body.activeAgent.name).toBe("scoped-agent");
    expect(body.activeAgent.systemPrompt).toBe("You are a scoped agent.");
    expect(body.default).toEqual({ provider: "openai", modelId: "gpt-4o" });
    expect(body.skills.map((s: any) => s.name)).toEqual(["bound-skill"]);
    expect(Object.keys(body.mcpServers)).toEqual(["bound-mcp"]);
    expect(body.credentials.clusters.map((c: any) => c.name)).toEqual(["bound-cluster"]);
  });

  it("suppresses builtin skills that have an overlay", async () => {
    const db = getDb();
    const base = "---\nname: shared-name\n---\nbase";
    const overlay = "---\nname: shared-name\n---\noverlay";
    await db.query(
      "INSERT INTO skills (id, org_id, name, description, author_id, status, version, specs, scripts, created_by, is_builtin, overlay_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["b1", "default", "shared-name", "base", "u", "active", 1, base, "[]", "u", 1, null],
    );
    await db.query(
      "INSERT INTO skills (id, org_id, name, description, author_id, status, version, specs, scripts, created_by, is_builtin, overlay_of) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["o1", "default", "shared-name", "overlay", "u", "active", 1, overlay, "[]", "u", 0, "b1"],
    );

    const { body } = await runRoute(
      router,
      fakeReq({ url: "/api/v1/cli-snapshot", headers: authedHeaders() }),
    );
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0].specs).toBe(overlay);
  });
});
