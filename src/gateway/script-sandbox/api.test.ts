import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CertificateIdentity } from "../security/cert-manager.js";
import { ScriptSandboxPool } from "../../script-sandbox/pool.js";
import { createScriptSandboxApi } from "./api.js";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { ScriptSandboxService } from "../../script-sandbox/service.js";

const constructed = vi.hoisted(() => ({ k8s: vi.fn(), e2b: vi.fn() }));
vi.mock("./k8s-provider.js", () => ({ K8sScriptSandboxProvider: class { constructor() { constructed.k8s(); } } }));
vi.mock("./e2b-provider.js", () => ({ E2bScriptSandboxProvider: class { constructor() { constructed.e2b(); } } }));

const identity = { agentId: "a", boxId: "b" } as CertificateIdentity;
async function request(api: ReturnType<typeof createScriptSandboxApi>, method: string, authenticated = true) {
  let status = 0; let body: any;
  const res = { writeHead: (code: number) => { status = code; }, end: (text: string) => { body = JSON.parse(text); } };
  await api.handle({ method } as IncomingMessage, res as unknown as ServerResponse, authenticated ? identity : undefined);
  return { status, body };
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });
describe("Runtime sandbox deployment gate", () => {
  it("disabled K8s ignores malformed provider, limits and inaccessible policy files", async () => {
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_ENABLED", "false");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_PROVIDER", "invalid");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_MAX_TIMEOUT_SECONDS", "900");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_MCP_POLICY_FILE", "/nonexistent/private-policy");
    const api = createScriptSandboxApi("k8s", { request: vi.fn() });
    expect((await request(api, "GET")).body.enabled).toBe(false);
    expect(constructed.k8s).not.toHaveBeenCalled();
    await api.shutdown();
  });
  it.each(["k8s", "e2b", "docker", "invalid"])("local ignores enabled %s configuration before loading credentials or creating providers", async provider => {
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_ENABLED", "true");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_PROVIDER", provider);
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_E2B_API_KEY_FILE", "/nonexistent/private-key");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_MCP_POLICY_FILE", "/nonexistent/private-policy");
    const prewarm = vi.spyOn(ScriptSandboxPool.prototype, "prewarm").mockImplementation(() => {});
    const control = { request: vi.fn() };
    const api = createScriptSandboxApi("local", control);
    expect(await request(api, "GET")).toEqual({ status: 200, body: { enabled: false, network_isolation: false, require_network_isolation: false } });
    expect((await request(api, "POST")).status).toBe(503);
    expect((await request(api, "GET", false)).status).toBe(401);
    await expect(api.externalTool({})).rejects.toThrow("disabled");
    await api.shutdown();
    expect(constructed.k8s).not.toHaveBeenCalled(); expect(constructed.e2b).not.toHaveBeenCalled();
    expect(prewarm).not.toHaveBeenCalled(); expect(control.request).not.toHaveBeenCalled();
  });

  it("unknown deployment types fail closed", async () => {
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_ENABLED", "true");
    const api = createScriptSandboxApi("unknown", { request: vi.fn() });
    expect((await request(api, "GET")).body.enabled).toBe(false);
  });

  it("K8s deployment explicitly enables and prewarms the native provider", async () => {
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_ENABLED", "true");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_PROVIDER", "k8s");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_IMAGE", "runner:test");
    const prewarm = vi.spyOn(ScriptSandboxPool.prototype, "prewarm").mockImplementation(() => {});
    const api = createScriptSandboxApi("k8s", { request: vi.fn() });
    expect((await request(api, "GET")).body.enabled).toBe(true);
    expect(constructed.k8s).toHaveBeenCalledOnce(); expect(prewarm).toHaveBeenCalledOnce();
    await api.shutdown();
  });

  it.each([30, 120])("publishes only public execution budgets with a %ss timeout ceiling", async maximum => {
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_ENABLED", "true");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_PROVIDER", "k8s");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_IMAGE", "runner:private-deployment");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_MAX_TIMEOUT_SECONDS", String(maximum));
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_MAX_TOOL_CALLS", "12");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_MAX_OUTPUT_BYTES", "8192");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_REQUIRE_NETWORK_ISOLATION", "true");
    vi.spyOn(ScriptSandboxPool.prototype, "prewarm").mockImplementation(() => {});
    const api = createScriptSandboxApi("k8s", { request: vi.fn() });
    try {
      expect(await request(api, "GET")).toEqual({ status: 200, body: {
        enabled: true, network_isolation: true, require_network_isolation: true,
        limits: { default_timeout_seconds: Math.min(60, maximum), max_timeout_seconds: maximum,
          max_tool_calls: 12, max_concurrent_tools: 10, max_output_bytes: 8192 },
      } });
      expect((await request(api, "GET", false)).status).toBe(401);
    } finally { await api.shutdown(); }
  });
});

describe("current caller binding", () => {
  async function post(currentUser?: () => string, claimedOwner = "owner") {
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_ENABLED", "true");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_PROVIDER", "k8s");
    vi.stubEnv("SICLAW_SCRIPT_SANDBOX_IMAGE", "runner:test");
    vi.spyOn(ScriptSandboxPool.prototype, "prewarm").mockImplementation(() => {});
    const control = { request: vi.fn(async (method: string) => method === "config.getAgent" ? { status: "active" } : { user_id: claimedOwner }) };
    const api = createScriptSandboxApi("k8s", control, undefined, currentUser);
    const req = Readable.from([Buffer.from(JSON.stringify({ session_id: "s", request: { language: "python", code: "pass" } }))]) as IncomingMessage;
    req.method = "POST";
    const res = new EventEmitter() as any;
    let status = 0; let body: any;
    res.writeHead = (s: number) => { status = s; };
    res.end = (text: string) => { body = JSON.parse(text); };
    try { await api.handle(req, res, identity); } finally { await api.shutdown(); }
    return { status, body, control };
  }

  it.each([undefined, () => ""])("rejects missing live caller before provisioning or resolving saved ownership", async currentUser => {
    const run = vi.spyOn(ScriptSandboxService.prototype, "run");
    const result = await post(currentUser);
    expect(result.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    expect(result.control.request).not.toHaveBeenCalled();
  });

  it("rejects a live caller who presents another user's stored session", async () => {
    const start = vi.spyOn(ScriptSandboxPool.prototype, "start");
    const result = await post(() => "attacker", "owner");
    expect(result.status).toBe(403);
    expect(result.body.error).toBe("Sandbox authorization denied");
    expect(start).not.toHaveBeenCalled();
  });

  it("passes the authenticated current user to authorization, without accepting it from script JSON", async () => {
    const run = vi.spyOn(ScriptSandboxService.prototype, "run").mockResolvedValue({ status: "completed" } as any);
    await post(() => "owner");
    expect(run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "owner", agentId: "a", sessionId: "s" }), expect.any(AbortSignal));
  });
});
