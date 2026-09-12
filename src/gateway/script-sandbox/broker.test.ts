import { describe, expect, it, vi } from "vitest";
import { ReadOnlyScriptBroker, kubeConnection } from "./broker.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";
import { scriptJob, validateRunnerPod } from "./k8s-provider.js";
import { dockerScriptArgs } from "./docker-provider.js";
import https from "node:https";

const config = () => loadScriptSandboxConfig({ SICLAW_SCRIPT_SANDBOX_IMAGE: "runner:latest" });
const p = () => ({ agentId: "a", userId: "u", sessionId: "s", boxId: "b", callbackToken: "private-grant" });
const scope = { language: "python" as const, code: "pass", clusters: [{ name: "prod" }], hosts: ["node"], mcp: [{ server: "metrics", tools: ["query"] }] };
describe("script connectors", () => {
  it("audits an out-of-scope built-in rejection without fetching credentials", async () => {
    const rpc = { request: vi.fn() };
    const audit = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(new ReadOnlyScriptBroker(rpc, config()).call(p(), scope,
        { id: "i", tool: "bash", arguments: { cluster: "undeclared", command: "kubectl get nodes" } },
        new AbortController().signal)).rejects.toThrow();
      expect(rpc.request).not.toHaveBeenCalled();
      expect(audit).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
        event: "script_tool", agentId: "a", userId: "u", sessionId: "s", boxId: "b", tool: "bash", allowed: false,
      }));
    } finally { audit.mockRestore(); }
  });
  it.each([
    ["ssh", { command: "rm -rf /" }], ["k8s.delete_pod", { cluster: "prod" }],
    ["k8s.list_nodes", { cluster: "prod" }],
    ["k8s.list_pods", { cluster: "prod", namespace: "allowed" }],
    ["k8s.pod_logs", { cluster: "prod", namespace: "allowed", command: "rm" }],
    ["host.inspect", { host: "node", check: "os", command: "rm" }],
    ["mcp.call", { server: "metrics", tool: "query", arguments: {} }],
  ])("denies %s before fetching production credentials", async (tool, args) => {
    const rpc = { request: vi.fn() };
    await expect(new ReadOnlyScriptBroker(rpc, config()).call(p(), scope, { id: "i", tool: tool as string, arguments: args as Record<string, unknown> }, new AbortController().signal)).rejects.toThrow();
    expect(rpc.request).not.toHaveBeenCalled();
  });
  it("fails closed on user identity change and capability revocation", async () => {
    const rpc = { request: vi.fn().mockResolvedValueOnce({ status: "active" }).mockResolvedValueOnce({ user_id: "other" }) };
    await expect(new ReadOnlyScriptBroker(rpc, config()).authorize(p(), new AbortController().signal)).rejects.toThrow();
    rpc.request.mockResolvedValue({ status: "active", agent_type: "coordinator" });
    await expect(new ReadOnlyScriptBroker(rpc, config()).authorize(p(), new AbortController().signal)).rejects.toThrow();
  });
  it.each(["active", "disabled"])("rejects retired types independently of %s status", async (status) => {
    const rpc = { request: vi.fn().mockResolvedValue({ status, agent_type: "coordinator" }) };
    await expect(new ReadOnlyScriptBroker(rpc, config()).authorize(p(), new AbortController().signal))
      .rejects.toMatchObject({ code: "AGENT_RETIRED", status: 410, retriable: false });
    expect(rpc.request).toHaveBeenCalledTimes(1);
  });
  it("rejects inherited properties and fixed MCP scope overrides", async () => {
    const c = { ...config() }; c.mcpPolicy = { metrics: { query: { fixedArguments: { tenant: "mine" } } } };
    const rpc = { request: vi.fn() };
    await expect(new ReadOnlyScriptBroker(rpc, c).call(p(), scope, { id: "i", tool: "mcp.call", arguments: { server: "metrics", tool: "query", arguments: { tenant: "other" } } }, new AbortController().signal)).rejects.toThrow();
    expect(rpc.request).not.toHaveBeenCalled();
  });
  const kube = (user: object, cluster: object = {}) => JSON.stringify({ "current-context": "c", contexts: [{ name: "c", context: { cluster: "c", user: "u" } }], clusters: [{ name: "c", cluster: { server: "https://example.test", ...cluster } }], users: [{ name: "u", user }] });
  it("does not execute when the live caller disappears during authorization", async () => {
    let release!: (value: unknown) => void;
    let pending!: () => void;
    const resolving = new Promise<void>(resolve => { pending = resolve; });
    const rpc = { request: vi.fn(async (method: string) => {
      if (method === "config.getAgent") return { status: "active" };
      pending();
      return new Promise(resolve => { release = resolve; });
    }) };
    let live = true;
    const request = vi.spyOn(https, "request");
    try {
      const builtin = vi.fn();
      const broker = new ReadOnlyScriptBroker(rpc, config(), builtin, () => {
        if (!live) throw new Error("Caller is no longer active");
      });
      const call = broker.call(p(), scope, { id: "i", tool: "bash", arguments: { cluster: "prod", command: "kubectl get pods -n allowed -o json" } }, new AbortController().signal);
      await resolving;
      live = false;
      release({ user_id: "u", credential: { type: "kubeconfig", files: [{ name: "cluster.kubeconfig", content: kube({ token: "t" }) }] } });
      await expect(call).rejects.toThrow("Caller is no longer active");
      expect(request).not.toHaveBeenCalled();
      expect(builtin).not.toHaveBeenCalled();
    } finally { request.mockRestore(); }
  });

  it("routes every cluster query to the built-in without opening a Kubernetes connection", async () => {
    const request = vi.spyOn(https, "request");
    const rpc = { request: vi.fn(async (method: string) => method === "config.getAgent" ? { status: "active" } :
      { user_id: "u", credential: { type: "kubeconfig", files: [{ name: "cluster.kubeconfig", content: kube({ token: "private-token" }) }] } }) };
    const builtin = vi.fn(async () => ({ text: "rows" }));
    try {
      const b = new ReadOnlyScriptBroker(rpc, config(), builtin);
      for (const command of ["kubectl get deployments -n allowed -o json", "kubectl logs api -n allowed --tail=100 | grep ERROR"]) {
        const result = await b.call(p(), scope, { id: command, tool: "bash", arguments: { cluster: "prod", command } }, new AbortController().signal);
        expect(result).toEqual({ text: "rows" });
        expect(builtin).toHaveBeenLastCalledWith(expect.anything(), { cluster: "prod", command, timeout_seconds: 10 }, expect.anything(), expect.objectContaining({ tool: "bash" }));
      }
      expect(request).not.toHaveBeenCalled();
      expect(rpc.request.mock.calls.filter(c => c[0] === "sandbox.resolve")).toHaveLength(4);
    } finally { request.mockRestore(); }
  });
  it.each([{ exec: { command: "sh" } }, { "auth-provider": { name: "gcp" } }, { tokenFile: "/etc/secret" }, { "client-key": "/etc/key" }, { "as": "admin" }])("refuses active/file kubeconfig authentication %j", user => {
    expect(() => kubeConnection(kube({ token: "t", ...user }))).toThrow();
  });
  it("requires TLS and only inline authentication", () => {
    expect(kubeConnection(kube({ token: "t" })).options.headers).toEqual({ Authorization: "Bearer t" });
    expect(() => kubeConnection(kube({ token: "t" }, { "insecure-skip-tls-verify": true }))).toThrow();
    expect(() => kubeConnection(kube({ token: "t" }, { "certificate-authority": "/etc/secret" }))).toThrow();
    expect(() => kubeConnection(kube({ token: "t" }, { server: "http://example.test" }))).toThrow();
  });
  it("runner spec carries no credentials and refuses injected sidecars or mounts", () => {
    const c = config(); const job = scriptJob("test", true, 60, c);
    const pod = { spec: job.spec!.template.spec };
    const uid = pod.spec!.securityContext!.runAsUser!;
    expect(uid).toBeGreaterThanOrEqual(100000);
    expect(scriptJob("another-run", true, 60, c).spec!.template.spec!.securityContext!.runAsUser).not.toBe(uid);
    expect(() => validateRunnerPod(pod, c, true, uid, 150)).not.toThrow();
    expect(() => validateRunnerPod(pod, c, true, uid + 1, 150)).toThrow();
    expect(pod.spec?.automountServiceAccountToken).toBe(false);
    expect(pod.spec?.containers[0].args?.[0]).toBe("isolated");
    pod.spec!.containers[0].args![0] = "standard";
    expect(() => validateRunnerPod(pod, c, true, uid, 150)).toThrow();
    pod.spec!.containers[0].args![0] = "isolated";
    pod.spec!.volumes!.push({ name: "secret", secret: { secretName: "prod" } });
    expect(() => validateRunnerPod(pod, c, true, uid, 150)).toThrow();
    const args = dockerScriptArgs("name", true, 30, "image");
    expect(args).toContain("--network=none"); expect(args).not.toContain("--env"); expect(args).not.toContain("--volume");
    expect(dockerScriptArgs("name", false, 30, "image")).not.toContain("--network=none");
  });
  it.each([
    (s: any) => { s.enableServiceLinks = true; },
    (s: any) => { s.securityContext.sysctls = [{ name: "net.ipv4.ip_forward", value: "1" }]; },
    (s: any) => { delete s.containers[0].resources.limits; },
    (s: any) => { s.containers[0].args[6] = "999999"; },
    (s: any) => { s.containers[0].tty = true; },
    (s: any) => { s.volumes[0].emptyDir = {}; },
    (s: any) => { s.containers[0].volumeMounts[0].mountPropagation = "Bidirectional"; },
  ])("rejects admission changes to environment, lifetime, resource bounds and temporary storage", mutate => {
    const c = config(); const spec = scriptJob("test", true, 60, c).spec!.template.spec!;
    const uid = spec.securityContext!.runAsUser!;
    mutate(spec);
    expect(() => validateRunnerPod({ spec }, c, true, uid, 150)).toThrow("isolation boundary");
  });
});
