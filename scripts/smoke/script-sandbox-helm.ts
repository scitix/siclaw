/** Offline installation matrix. No cluster access or credentials required. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { loadAll } from "js-yaml";
const helm = process.env.HELM ?? "helm";
function render(values: string[], ok = true): any[] {
  const p = spawnSync(helm, ["template", "fixture", "helm/siclaw", "--namespace", "control", ...values.flatMap(v => ["--set", v])], { encoding: "utf8" });
  assert.equal(p.status === 0, ok, p.stderr);
  return ok ? loadAll(p.stdout).filter(Boolean) : [];
}
const disabled = render(["portal.enabled=true", "scriptSandbox.enabled=false", "scriptSandbox.provider=invalid", "scriptSandbox.traffic=null"]);
assert(!JSON.stringify(disabled).includes("SICLAW_SCRIPT_SANDBOX_ENABLED"));
for (const portal of [true, false]) {
  const docs = render([`portal.enabled=${portal}`, "scriptSandbox.enabled=true", "scriptSandbox.image=runner:fixture", "scriptSandbox.traffic=null"]);
  const account = docs.find(d => d.kind === "ServiceAccount" && d.metadata.name === "siclaw-script-runner");
  assert(account && account.automountServiceAccountToken === false && account.metadata.namespace !== "control");
  const namespace = docs.find(d => d.kind === "Namespace" && d.metadata.name === account.metadata.namespace);
  assert.equal(namespace.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted");
  assert(docs.some(d => d.kind === "ResourceQuota"));
}
const external = render(["portal.enabled=true", "scriptSandbox.enabled=true", "scriptSandbox.provider=e2b", "scriptSandbox.publicUrl=https://portal.example", "scriptSandbox.e2b.template=fixture", "scriptSandbox.e2b.apiKeySecret=fixture-key"]);
assert(!external.some(d => d.kind === "Namespace"));
assert(JSON.stringify(external).includes("SICLAW_SANDBOX_PUBLIC_URL"));
render(["portal.enabled=true", "scriptSandbox.enabled=true", "scriptSandbox.provider=e2b"], false);
render(["scriptSandbox.enabled=true", "scriptSandbox.namespace=control"], false);
const noRuntime = render(["runtime.enabled=false", "scriptSandbox.enabled=true"]);
assert(!noRuntime.some(d => d.kind === "Namespace"));
console.log("sandbox chart matrix: 7 cases passed");
