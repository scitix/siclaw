import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import https from "node:https";
import { ReadOnlyScriptBroker } from "./broker.js";
import { loadScriptSandboxConfig } from "../../script-sandbox/config.js";

const principal = () => ({ agentId: "a", userId: "u", sessionId: "s", boxId: "b" });
const scope = { language: "python" as const, code: "pass", clusters: [{ name: "test", namespaces: ["team"] }] };
const kubeconfig = JSON.stringify({ "current-context": "c", contexts: [{ name: "c", context: { cluster: "c", user: "u" } }],
  clusters: [{ name: "c", cluster: { server: "https://cluster.test" } }], users: [{ name: "u", user: { token: "private-token" } }] });
const rpc = () => ({ request: vi.fn(async (method: string) => method === "config.getAgent" ? { status: "active" } :
  { user_id: "u", credential: { type: "kubeconfig", files: [{ name: "test.kubeconfig", content: kubeconfig }] } }) });
const call = (extra: Record<string, unknown> = {}) => ({ id: "i", tool: "k8s.list_pods", arguments: { cluster: "test", namespace: "team", ...extra } });

function mockKube(pages: unknown[]) {
  const sent: Array<{ url: URL; method?: string }> = [];
  vi.spyOn(https, "request").mockImplementation(((url: URL, options: https.RequestOptions, callback: (res: any) => void) => {
    sent.push({ url, method: options.method });
    const req = new EventEmitter() as any;
    req.destroy = (error: Error) => req.emit("error", error);
    req.end = () => {
      const res = new EventEmitter() as any; res.statusCode = 200;
      callback(res); res.emit("data", Buffer.from(JSON.stringify(pages.shift()))); res.emit("end");
    };
    return req;
  }) as any);
  return sent;
}
afterEach(() => vi.restoreAllMocks());

describe("read-only pod pagination", () => {
  it("follows opaque tokens on the fixed GET and reauthorizes every page", async () => {
    const token = "opaque/../token?&path=/api/v1/secrets";
    const pod = { metadata: { name: "worker", namespace: "team", annotations: { secret: "private" } },
      spec: { nodeName: "node", containers: [{ env: [{ name: "PASSWORD", value: "private" }] }] },
      status: { phase: "Running", conditions: [{ type: "Ready", status: "True", message: "private" }] } };
    const sent = mockKube([{ items: [pod], metadata: { continue: token } }, { items: [], metadata: {} }]);
    const control = rpc(); const broker = new ReadOnlyScriptBroker(control, loadScriptSandboxConfig({}));
    const signal = new AbortController().signal; const p = principal();
    const first = await broker.call(p, scope, call(), signal);
    expect(first).toEqual({ pods: [{ name: "worker", namespace: "team", phase: "Running", node: "node", conditions: [{ type: "Ready", status: "True" }] }], continue: token });
    expect(JSON.stringify(first)).not.toMatch(/private|PASSWORD|message|annotations/);
    expect(await broker.call(p, scope, call({ continue: token }), signal)).toEqual({ pods: [], continue: null });
    expect(sent).toHaveLength(2);
    for (const req of sent) {
      expect(req.method).toBe("GET"); expect(req.url.pathname).toBe("/api/v1/namespaces/team/pods");
      expect(req.url.searchParams.get("limit")).toBe("10"); expect(req.url.searchParams.has("path")).toBe(false);
    }
    expect(sent[1].url.searchParams.get("continue")).toBe(token);
    expect(control.request.mock.calls.filter(c => c[0] === "sandbox.resolve")).toHaveLength(2);
  });

  it.each([{ continue: 1 }, { continue: "x".repeat(4097) }, { namespace: ".." }, { namespace: "other" }, { method: "DELETE" }])("rejects invalid scope/query before resolving credentials", async args => {
    const control = rpc(); const broker = new ReadOnlyScriptBroker(control, loadScriptSandboxConfig({}));
    await expect(broker.call(principal(), scope, call(args), new AbortController().signal)).rejects.toThrow();
    expect(control.request).not.toHaveBeenCalled();
  });

  it("bounds upstream pages at 1 MiB", async () => {
    mockKube([{ items: [], padding: "x".repeat(1024 * 1024) }]);
    await expect(new ReadOnlyScriptBroker(rpc(), loadScriptSandboxConfig({})).call(principal(), scope, call(), new AbortController().signal)).rejects.toThrow("Kubernetes response too large");
  });
});
