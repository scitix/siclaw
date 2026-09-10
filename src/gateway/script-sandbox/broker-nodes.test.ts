import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import https from "node:https";
import { ReadOnlyScriptBroker } from "./broker.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";
import type { ScriptRequest } from "../../script-sandbox/types.js";

const principal = () => ({ agentId: "a", userId: "u", sessionId: "s", boxId: "b" });
const scope: ScriptRequest = { language: "python", code: "pass", clusters: [{ name: "test", nodes: true }] };
const kubeconfig = JSON.stringify({ "current-context": "c", contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
  clusters: [{ name: "c", cluster: { server: "https://cluster.test" } }], users: [{ name: "u", user: { token: "private-token" } }] });
const rpc = () => ({ request: vi.fn(async (method: string) => method === "config.getAgent" ? { status: "active" } :
  { user_id: "u", credential: { type: "kubeconfig", files: [{ name: "test.kubeconfig", content: kubeconfig }] } }) });
const broker = (controlPlane = rpc()) => new ReadOnlyScriptBroker(controlPlane, loadScriptSandboxConfig({}));
const call = (arguments_: Record<string, unknown> = { cluster: "test" }) => ({ id: "i", tool: "k8s.list_nodes", arguments: arguments_ });

function mockKube(pages: Array<{ status?: number; body: unknown }>) {
  const sent: Array<{ url: URL; method?: string }> = [];
  vi.spyOn(https, "request").mockImplementation(((url: URL, options: https.RequestOptions, callback: (res: any) => void) => {
    sent.push({ url, method: options.method });
    const req = new EventEmitter() as any;
    req.destroy = (error: Error) => req.emit("error", error);
    req.end = () => {
      const page = pages.shift()!;
      const res = new EventEmitter() as any; res.statusCode = page.status ?? 200;
      callback(res);
      res.emit("data", Buffer.from(JSON.stringify(page.body)));
      res.emit("end");
    };
    return req;
  }) as any);
  return sent;
}

afterEach(() => vi.restoreAllMocks());

describe("read-only node summaries", () => {
  it.each([
    { cluster: "other" }, { cluster: "test", namespace: "team" }, { cluster: "test", path: "/api/v1/secrets" },
    { cluster: "test", method: "PATCH" }, { cluster: "test", continue: 1 }, { cluster: "test", continue: "x".repeat(4097) },
  ])("denies invalid node requests before resolving credentials: %j", async args => {
    const control = rpc();
    await expect(broker(control).call(principal(), scope, call(args), new AbortController().signal)).rejects.toThrow();
    expect(control.request).not.toHaveBeenCalled();
  });

  it("keeps namespace and cluster-scoped node declarations separate", async () => {
    const control = rpc(); const b = broker(control); const signal = new AbortController().signal;
    for (const clusters of [undefined, [{ name: "test", namespaces: ["team"] }], [{ name: "test", nodes: false }]]) {
      await expect(b.call(principal(), { ...scope, clusters }, call(), signal)).rejects.toThrow("Outside node scope");
    }
    await expect(b.call(principal(), scope, { id: "i", tool: "k8s.list_pods", arguments: { cluster: "test", namespace: "team" } }, signal)).rejects.toThrow("Outside cluster scope");
    expect(control.request).not.toHaveBeenCalled();
  });

  it("projects diagnostic attributes, paginates only the fixed GET, and reauthorizes every page", async () => {
    const token = "opaque/../token?&path=/api/v1/secrets";
    const node = { metadata: { name: "worker", annotations: { password: "secret" }, labels: { private: "secret" } },
      spec: { unschedulable: true, providerID: "private-provider" }, status: {
        conditions: [{ type: "Ready", status: "True", message: "private-message" }], images: [{ names: ["private-image"] }],
        addresses: [{ address: "private-address" }], capacity: { cpu: "8", memory: "32Gi" }, allocatable: { cpu: "7" },
        nodeInfo: { kubeletVersion: "v1.30.0", kernelVersion: "6.1", osImage: "Linux", architecture: "amd64", containerRuntimeVersion: "containerd://1.7", machineID: "private-machine" } } };
    const sent = mockKube([{ body: { items: [node], metadata: { continue: token } } }, { body: { items: [{ metadata: { name: "worker-2" } }] } }]);
    const control = rpc(); const b = broker(control); const p = principal(); const signal = new AbortController().signal;
    const first = await b.call(p, scope, call(), signal);
    expect(first).toEqual({ nodes: [{ name: "worker", ready: "True", unschedulable: true, kubelet_version: "v1.30.0", kernel_version: "6.1", os_image: "Linux",
      architecture: "amd64", container_runtime: "containerd://1.7", capacity: { cpu: "8", memory: "32Gi" }, allocatable: { cpu: "7" } }], continue: token });
    expect(JSON.stringify(first)).not.toMatch(/private-|password|annotations|labels/);
    const second = await b.call(p, scope, call({ cluster: "test", continue: token }), signal);
    expect(second).toMatchObject({ nodes: [{ name: "worker-2", ready: "Unknown", unschedulable: false }], continue: null });
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.method).toBe("GET"); expect(request.url.pathname).toBe("/api/v1/nodes");
      expect(request.url.searchParams.get("limit")).toBe("10"); expect(request.url.searchParams.has("path")).toBe(false);
    }
    expect(sent[1].url.searchParams.get("continue")).toBe(token);
    expect(control.request.mock.calls.filter(c => c[0] === "sandbox.resolve")).toHaveLength(2);
  });

  it("honors Kubernetes RBAC denial despite declared node scope", async () => {
    mockKube([{ status: 403, body: { message: "private server denial" } }]);
    await expect(broker().call(principal(), scope, call(), new AbortController().signal)).rejects.toThrow("Kubernetes read failed");
  });

  it("bounds upstream node pages at 1 MiB", async () => {
    mockKube([{ body: { items: [], padding: "x".repeat(1024 * 1024) } }]);
    await expect(broker().call(principal(), scope, call(), new AbortController().signal)).rejects.toThrow("Kubernetes response too large");
  });
});
