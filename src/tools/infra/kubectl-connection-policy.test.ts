import { expect, it } from "vitest";
import { validateKubectlInPipeline } from "./kubectl-readonly-policy.js";

it.each([
  "--server=https://other.example", "--server https://other.example", "-s https://other.example", "-shttps://other.example", "-Ashttps://other.example",
  "--context=other", "--cluster other", "--user other", "--username other", "--password=value", "--token=value",
  "--client-key=/private/key", "--client-certificate=/private/cert", "--certificate-authority=/private/ca",
  "--insecure-skip-tls-verify", "--tls-server-name=other", "--proxy-url=https://other.example",
  "--as=admin", "--as-group=system:masters", "--as-uid=other", "--kubeconfig=/private/config",
])("rejects connection override %s in every shared kubectl path", flags => {
  for (const command of [`kubectl get pods ${flags}`, `kubectl ${flags} get pods`,
    `kubectl auth can-i get pods ${flags}`, `kubectl rollout history deployment/app ${flags}`]) {
    expect(validateKubectlInPipeline([command]), command).toContain("overrides");
  }
});

it.each([
  "kubectl get pods -nkube-system", "kubectl get pods -lapp=server -ojson",
  "kubectl get nodes -o custom-columns=NAME:.metadata.name", "kubectl logs pod -n app --since=1h",
  "kubectl --warnings-as-errors get nodes", "kubectl config get-contexts",
])("preserves ordinary read arguments: %s", command => {
  expect(validateKubectlInPipeline([command])).toBeNull();
});

it.each(["set-context example", "set-credentials example", "use-context other", "rename-context before after", "delete-cluster prod", "unset users"])("rejects kubeconfig mutation: %s", command => {
  expect(validateKubectlInPipeline([`kubectl config ${command}`])).toContain("read-only");
});
