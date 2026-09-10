import { expect, it } from "vitest";
import { resolveSandboxBuiltin } from "./tool-dispatch.js";

const scope = { language: "python" as const, code: "pass", clusters: [{ name: "prod" }], hosts: ["host-a"] };
const check = (tool: string, args: Record<string, unknown>) => resolveSandboxBuiltin({ id: "call", tool, arguments: args }, scope);

it.each(["kubectl get deployments -n app -o json", "kubectl logs api -n app --tail=100 | grep ERROR", "kubectl delete pod api"])("leaves command %s unchanged for the built-in policy", command => {
  expect(check("bash", { cluster: "prod", command }).arguments).toEqual({ cluster: "prod", command, timeout_seconds: 10 });
});

it("limits authority to declared resources without implementing a command whitelist", () => {
  expect(() => check("bash", { cluster: "other", command: "kubectl get pods" })).toThrow("scope");
  expect(() => check("host_exec", { host: "other", command: "uname" })).toThrow("scope");
  expect(() => check("node_exec", { cluster: "prod", command: "uname" })).toThrow("explicit node");
  for (const tool of ["k8s.list_nodes", "k8s.list_pods", "k8s.pod_logs", "host.inspect", "local_script", "ssh"]) {
    expect(() => check(tool, { cluster: "prod" })).toThrow("unavailable");
  }
});

it("bounds the callback budget independently of command policy", () => {
  for (const timeout_seconds of [0, 16, 1.5, "2"]) {
    expect(() => check("host_exec", { host: "host-a", command: "uname", timeout_seconds })).toThrow("timeout");
  }
});
