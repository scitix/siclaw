import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { ExternalScriptTools } from "./external-tools.js";
import { SANDBOX_LEASE_OPEN, SANDBOX_TOOL_PATH } from "../../script-sandbox/external-protocol.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";
import { ScriptSandboxService } from "../../script-sandbox/service.js";
import type { ScriptToolBinding, ScriptChannel } from "../../script-sandbox/types.js";

const principal = { runId: "run-1", agentId: "agent-1", sessionId: "session-1", userId: "user-1", boxId: "box-1", callbackToken: "private-agentbox-token" };
const endpoint = "https://portal.example" + SANDBOX_TOOL_PATH;
const call = { id: "call-1", tool: "bash", arguments: { cluster: "test", command: "kubectl get nodes -o json" } };
function setup() {
  const request = vi.fn(async () => ({ endpoint }));
  const controller = new AbortController();
  const binding: ScriptToolBinding = { principal, timeoutSeconds: 30, signal: controller.signal, call: vi.fn(async () => ({ id: call.id, result: { nodes: [] } })) };
  return { request, controller, binding, registry: new ExternalScriptTools({ request }) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("external run grants", () => {
  it("registers only a token hash and trusted identity, then revokes at completion", async () => {
    const { registry, request, binding } = setup();
    const lease = await registry.open(binding);
    expect(request).toHaveBeenCalledWith(SANDBOX_LEASE_OPEN, expect.objectContaining({ token_hash: createHash("sha256").update(lease.token).digest("hex"), run_id: "run-1" }), 5000);
    expect(JSON.stringify(request.mock.calls)).not.toContain(lease.token);
    expect(JSON.stringify(request.mock.calls)).not.toContain(principal.callbackToken);
    expect(await registry.call({ run_id: "run-1", token: lease.token, call })).toEqual({ id: "call-1", result: { nodes: [] } });
    await lease.close();
    await expect(registry.call({ run_id: "run-1", token: lease.token, call })).rejects.toThrow();
  });
  it("rejects cross-run, forged token, extra authority and restarted registries", async () => {
    const { registry, request, binding } = setup(); const lease = await registry.open(binding);
    for (const raw of [
      { run_id: "another-run", token: lease.token, call },
      { run_id: "run-1", token: "a".repeat(64), call },
      { run_id: "run-1", token: lease.token, call, scope: {} },
    ]) await expect(registry.call(raw)).rejects.toThrow();
    await expect(new ExternalScriptTools({ request }).call({ run_id: "run-1", token: lease.token, call })).rejects.toThrow();
    expect(binding.call).not.toHaveBeenCalled(); await lease.close();
  });
  it("expires grants and synchronously cancels them even if revocation RPC hangs", async () => {
    vi.useFakeTimers();
    const { registry, request, binding, controller } = setup(); const lease = await registry.open(binding);
    vi.advanceTimersByTime(40_000);
    await expect(registry.call({ run_id: "run-1", token: lease.token, call })).rejects.toThrow();
    request.mockImplementation(() => new Promise(() => {}));
    controller.abort();
    await expect(registry.call({ run_id: "run-1", token: lease.token, call })).rejects.toThrow();
  });
  it.each(["http://portal.example" + SANDBOX_TOOL_PATH, "https://portal.example/api/credential", "https://user:password@portal.example" + SANDBOX_TOOL_PATH])("rejects an unsafe destination: %s", async endpoint => {
    const { registry, request, binding } = setup(); request.mockResolvedValue({ endpoint });
    await expect(registry.open(binding)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("shares service scope, replay detection and budget with pipe calls", async () => {
    const { registry } = setup();
    let lease: Awaited<ReturnType<ExternalScriptTools["open"]>>;
    const c: ScriptChannel = { instanceId: "e2b", stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), done: new Promise(() => {}),
      bindTools: async binding => { lease = await registry.open(binding); }, close: async () => { await lease?.close(); } };
    const broker = { authorize: vi.fn(async () => {}), call: vi.fn(async () => ({ safe: true })) };
    const assertions = new Promise<void>((resolve, reject) => {
      c.stdin.once("data", () => { void (async () => {
        expect(await registry.call({ run_id: runId, token: lease.token, call })).toEqual({ id: "call-1", result: { safe: true } });
        await expect(registry.call({ run_id: runId, token: lease.token, call })).rejects.toThrow();
      })().then(resolve, reject); });
    });
    let runId = "";
    const bind = c.bindTools!; c.bindTools = async binding => { runId = binding.principal.runId!; await bind(binding); };
    const config = loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_ENABLED: "true", SICLAW_SCRIPT_SANDBOX_IMAGE: "image", SICLAW_SCRIPT_SANDBOX_MAX_TOOL_CALLS: "1" });
    const result = await new ScriptSandboxService(config, { start: async () => c }, broker).run({ language: "python", code: "pass", clusters: [{ name: "test" }] }, principal);
    await assertions;
    expect(result.status).toBe("failed");
    expect(broker.call).toHaveBeenCalledOnce();
    expect(broker.call.mock.calls[0][1]).toMatchObject({ clusters: [{ name: "test" }] });
  });
});
