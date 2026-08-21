import { describe, it, expect } from "vitest";
import { validateCommand } from "./command-validator.js";
import { CONTAINER_SENSITIVE_PATHS, parseArgs } from "./command-sets.js";
import { validateKubectlInPipeline } from "../cmd-exec/restricted-bash.js";
import { analyzeOutput } from "./output-sanitizer.js";
import { kubectlOutputFormats, kubectlAllNamespaces, getOutputFormat } from "./kubectl-sanitize.js";

/**
 * The forms kubectl actually accepts, written down.
 *
 * Six review rounds on this branch found the same shape of defect each time: a control that recognised
 * the spelling someone had in mind and not the grammar kubectl implements. `-o jsonpath` was covered and
 * `--template` was not; `secret/x` was covered and `secrets.v1.` was not; `-o json` was covered and
 * `-Ao json` was not; the FIRST `-o` was read while kubectl reads the LAST.
 *
 * So this file is a TABLE, not a list of payloads, and the cells are grouped by the grammatical axis they
 * vary — format spelling, flag ordering, short-option clustering, all-namespaces spelling, raw paths. Each
 * axis is filled independently, so a new spelling is added by extending one axis rather than by thinking
 * of a new payload.
 *
 * Every claim about kubectl's own behaviour below was measured against a live cluster, and the ones that
 * turned out to be wrong are recorded as such: `--template` does NOT beat a later `-o`, and `--raw`
 * together with `-o` is rejected by kubectl itself as mutually exclusive.
 */

const opts = {
  context: "local" as const,
  sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
  extraAllowed: new Set(["kubectl"]),
  pipelineValidators: [validateKubectlInPipeline],
};
const check = (cmd: string) => validateCommand(cmd, opts);
const args = (cmd: string) => parseArgs(cmd).slice(1);

// ── Axis 1: how a format is spelled ─────────────────────────────────────────
describe("every spelling of an output format is read", () => {
  const SPELLINGS: Array<[string, string]> = [
    ["-o json", "json"],
    ["-o=json", "json"],
    ["-ojson", "json"],
    ["--output json", "json"],
    ["--output=json", "json"],
    ["-o jsonpath={.data.password}", "jsonpath"],
    ["-ojsonpath={.data.password}", "jsonpath"],
    ["-o custom-columns=P:.data.password", "custom-columns"],
    ["-o go-template={{.data.password}}", "go-template"],
    ["--template={{.data.password}}", "go-template"],
    ["--template {{.data.password}}", "go-template"],
    ["-o yaml", "yaml"],
    ["-oyaml", "yaml"],
    ["--raw /api/v1/x", "raw"],
    ["--raw=/api/v1/x", "raw"],
    // Inside a short cluster, which is the spelling that was invisible.
    ["-Ao json", "json"],
    ["-Aojson", "json"],
    ["-Aoyaml", "yaml"],
  ];
  for (const [spelling, expected] of SPELLINGS) {
    it(`${spelling} → ${expected}`, () => {
      expect(getOutputFormat(args(`kubectl get pods ${spelling}`))).toBe(expected);
    });
  }

  it("and default table output is null, not a guess", () => {
    expect(getOutputFormat(args("kubectl get pods"))).toBeNull();
    expect(getOutputFormat(args("kubectl get pods -A"))).toBeNull();
    expect(getOutputFormat(args("kubectl get pods -n kube-system -l app=x"))).toBeNull();
  });
});

// ── Axis 2: flag ordering ───────────────────────────────────────────────────
describe("kubectl is last-wins, and every declaration is inspected", () => {
  it("reports the declarations in order", () => {
    expect(kubectlOutputFormats(args("kubectl get secret x -o json -o jsonpath={.data.password}")))
      .toEqual(["json", "jsonpath"]);
  });

  it("the effective format is the LAST one", () => {
    // Measured: `-o json -o jsonpath={.data.password}` returns the bare base64.
    expect(getOutputFormat(args("kubectl get secret x -o json -o jsonpath={.data.password}"))).toBe("jsonpath");
    expect(getOutputFormat(args("kubectl get secret x -o jsonpath={.data.password} -o json"))).toBe("json");
  });

  it("a Secret read is refused when ANY declared format is unsafe, whatever the order", () => {
    for (const cmd of [
      "kubectl get secret x -o json -o jsonpath={.data.password}",
      "kubectl get secret x -o jsonpath={.data.password} -o json",
      "kubectl get secret x -o json -o yaml",
      "kubectl get secret x -o yaml -o json",
      "kubectl get secret x -o json --template={{.data.password}}",
    ]) {
      expect(check(cmd), cmd).not.toBeNull();
    }
  });

  it("but a Secret read with only safe formats declared still works", () => {
    for (const cmd of [
      "kubectl get secret x -o json",
      "kubectl get secret x -o json -o json",
      "kubectl get secret x",
      "kubectl describe secret x",
    ]) {
      expect(check(cmd), cmd).toBeNull();
    }
  });

  it("records what kubectl does NOT do, so the table is not aspirational", () => {
    // Both measured against a live cluster; the review that proposed them assumed otherwise.
    //   `-o json --template={{…}}`  → prints JSON. `-o` wins; --template does not override it.
    //   `-o json --raw /path`       → kubectl exits: "--raw and --output are mutually exclusive".
    // The refusals above are therefore stricter than kubectl's own behaviour, which is the safe side.
    expect(kubectlOutputFormats(args("kubectl get secret x -o json --template={{.d}}")))
      .toEqual(["json", "go-template"]);
  });
});

// ── Axis 3: short-option clustering ─────────────────────────────────────────
describe("pflag decomposes a short cluster; so does every reader here", () => {
  const CLUSTERS: Array<[string, { allNs: boolean; format: string | null }]> = [
    ["-A", { allNs: true, format: null }],
    ["-Ao json", { allNs: true, format: "json" }],
    ["-Aojson", { allNs: true, format: "json" }],
    ["-A -o json", { allNs: true, format: "json" }],
    ["--all-namespaces -o json", { allNs: true, format: "json" }],
    ["-o json", { allNs: false, format: "json" }],
    // A value-taking flag ends the cluster and claims the rest: here `n` takes `kube-system`.
    ["-n kube-system", { allNs: false, format: null }],
    ["-An kube-system", { allNs: true, format: null }],
    // An unknown letter is treated as a boolean and scanning continues, so the `o` behind it is seen.
    ["-Rwo json", { allNs: false, format: "json" }],
    ["-ARo json", { allNs: true, format: "json" }],
  ];
  for (const [cluster, expected] of CLUSTERS) {
    it(cluster, () => {
      const a = args(`kubectl get pods ${cluster}`);
      expect(kubectlAllNamespaces(a), "all-namespaces").toBe(expected.allNs);
      expect(getOutputFormat(a), "format").toBe(expected.format);
    });
  }

  it("a clustered -A -o json dump of Secrets is refused", () => {
    // Was permitted AND unsanitized: the -A check matched a bare token and the format reader matched a
    // token starting with -o, so `-Ao json` satisfied neither while kubectl returned every Secret.
    for (const cmd of [
      "kubectl get secrets -Ao json",
      "kubectl get secrets -Aojson",
      "kubectl get secrets -Ao yaml",
      "kubectl get secret -Ao json",
    ]) {
      expect(check(cmd), cmd).not.toBeNull();
    }
  });

  it("and the sanitizer attaches to the clustered form too", () => {
    // The validator refusing is one control; the sanitizer recognising the format is the other, and a
    // disagreement between them is how an allowed command comes back unredacted.
    for (const cmd of ["kubectl get pods -Ao json", "kubectl get pods -Aojson"]) {
      expect(analyzeOutput("kubectl", args(cmd)), cmd).not.toBeNull();
    }
  });

  it("a clustered -A on a bulk read is still rate-limited", () => {
    expect(check("kubectl describe pods -Ao json")).not.toBeNull();
  });
});

// ── Axis 4: raw API paths ───────────────────────────────────────────────────
describe("--raw is permitted only for endpoints that return no API object", () => {
  for (const path of ["/metrics", "/healthz", "/readyz", "/livez", "/version", "/api", "/apis"]) {
    it(`permits ${path}`, () => {
      expect(check(`kubectl get --raw ${path}`), path).toBeNull();
      expect(check(`kubectl get --raw=${path}`), `${path} (= form)`).toBeNull();
    });
  }

  for (const path of [
    "/api/v1/namespaces/default/pods",
    "/api/v1/namespaces/default/configmaps",
    "/api/v1/namespaces/default/configmaps/registry-auth",
    "/api/v1/namespaces/default/secrets/x",
    "/apis/apps/v1/deployments",
    "/api/v1/nodes",
    // A permitted prefix does not make the rest permitted.
    "/metrics/../api/v1/namespaces/x/secrets/y",
    "/api/v1/secrets",
  ]) {
    it(`refuses ${path}`, () => {
      expect(check(`kubectl get --raw ${path}`), path).not.toBeNull();
    });
  }

  it("names the sanitized alternative", () => {
    const refusal = String(check("kubectl get --raw /api/v1/namespaces/default/configmaps"));
    expect(refusal).toContain("-o json");
  });
});

// ── Axis 5: a read-only allowance is per stage, not per pipeline ────────────
describe("a permitted verb in one stage does not clear the others", () => {
  it("checks every stage after rollout history", () => {
    // `return null` from inside the loop declared the whole pipeline safe. Direct calls with a single
    // stage — which is all the tests did — could not see it.
    for (const stages of [
      ["kubectl rollout history deploy/x", "kubectl delete pod victim"],
      ["kubectl rollout history deploy/x", "kubectl exec p -- id"],
      ["kubectl rollout history deploy/x", "kubectl get secret demo -o yaml"],
      ["kubectl rollout history deploy/x", "kubectl apply -f x.yaml"],
      ["kubectl get pods", "kubectl rollout history deploy/x", "kubectl delete pod victim"],
    ]) {
      expect(validateKubectlInPipeline(stages), stages.join(" | ")).not.toBeNull();
    }
  });

  it("through the real entry point, for both separators", () => {
    for (const cmd of [
      "kubectl rollout history deploy/x | kubectl delete pod victim",
      "kubectl rollout history deploy/x ; kubectl delete pod victim",
      "kubectl rollout history deploy/x && kubectl delete pod victim",
      "kubectl rollout history deploy/x | kubectl get secret demo -o yaml",
    ]) {
      expect(check(cmd), cmd).not.toBeNull();
    }
  });

  it("and a pipeline of only permitted stages still passes", () => {
    expect(validateKubectlInPipeline(["kubectl rollout history deploy/x"])).toBeNull();
    expect(validateKubectlInPipeline(["kubectl rollout history deploy/x", "kubectl get pods"])).toBeNull();
    expect(check("kubectl rollout history deploy/x | head -5")).toBeNull();
  });

  it("the same applies to auth, which is on the list as a family", () => {
    // `can-i` and `whoami` are reads; `auth reconcile` creates and updates RBAC objects — kubectl's own
    // help says "Missing objects are created".
    for (const cmd of ["kubectl auth reconcile -f r.yaml", "kubectl auth reconcile"]) {
      expect(check(cmd), cmd).not.toBeNull();
    }
    for (const cmd of ["kubectl auth can-i get pods", "kubectl auth whoami",
                       "kubectl auth can-i --list -n kube-system"]) {
      expect(check(cmd), cmd).toBeNull();
    }
    expect(validateKubectlInPipeline(["kubectl auth can-i get pods", "kubectl delete pod v"])).not.toBeNull();
  });
});

// ── Axis 6: the two readers must agree ──────────────────────────────────────
describe("the validator and the sanitizer read the same argv the same way", () => {
  // A disagreement is a leak: permitted by one, unrecognised by the other. This is the property that
  // `-Ao json` broke — and it broke it in both readers at once, which is why it produced an allowed
  // command with no sanitizer rather than a refusal.
  const FORMS = [
    "kubectl get secret x -o json", "kubectl get secret/x -o json", "kubectl get secrets/x -o json",
    "kubectl get -o json secret x", "kubectl get -n ns secret x -o json",
    "kubectl get secrets -Ao json", "kubectl get secrets -Aojson",
    "kubectl get pod,secret -o json", "kubectl get secret,pod -o json",
    "kubectl get secrets.v1. x -o json", "kubectl get pods -Ao json",
  ];
  for (const cmd of FORMS) {
    it(cmd, () => {
      const permitted = check(cmd) === null;
      if (!permitted) return;   // refused: nothing to sanitize
      // Anything permitted that names a sensitive resource must have a sanitizer attached.
      const a = args(cmd);
      const namesSensitive = /secret|configmap|\bcm\b|pod/.test(cmd);
      if (namesSensitive) {
        expect(analyzeOutput("kubectl", a), `${cmd} is permitted but unsanitized`).not.toBeNull();
      }
    });
  }
});
