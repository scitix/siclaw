/**
 * The read-only kubectl policy: which subcommands, verbs, output formats and API paths may run.
 *
 * Lifted out of `cmd-exec/restricted-bash.ts` unchanged. It belongs here because it is the POLICY,
 * not the tool — `kubectl.test.ts`, `kubectl-grammar.test.ts` and `command-sets.test.ts` all already
 * reached into the tool module for it, and anything else that runs a kubectl read has to be governed
 * by the same answers or the guarantee is only as good as whichever caller remembered it.
 */
import {
  SAFE_SUBCOMMANDS,
  checkAllNamespacesRestriction,
  checkSecretOutputFormat,
  argsNameSecrets,
  getCommandBinary,
  parseArgs,
} from "./command-sets.js";
import { kubectlSubcommand } from "./kubectl-sanitize.js";

/** The path given to `--raw`, or undefined when the flag is absent. */
function rawPassthroughPath(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--raw") return args[i + 1] ?? "";
    if (a.startsWith("--raw=")) return a.slice("--raw=".length);
  }
  return undefined;
}

/**
 * Endpoints that return no API objects, so having no sanitizer costs nothing.
 *
 * Matched on the path's first segment and required to be the WHOLE path (query string aside): `/metrics`
 * passes, `/metrics/../api/v1/namespaces/x/secrets/y` does not. Discovery endpoints `/api` and `/apis`
 * list group-versions only — a longer path under them names resources and is refused.
 */
function isDiagnosticApiPath(apiPath: string): boolean {
  const clean = apiPath.split("?")[0].replace(/\/+$/, "");
  return ["/metrics", "/healthz", "/readyz", "/livez", "/version", "/api", "/apis"].includes(clean);
}

/**
 * A Secret read that feeds a PIPE has no structural guarantee left.
 *
 * `-o json` is the one permitted format precisely because the structural sanitizer redacts every
 * `data`/`stringData` value. That holds for the tool's own output — and the tool's output is the LAST
 * stage's. `kubectl get secret demo -o json | jq -r .data.password` hands back a bare base64 string: not
 * JSON, so nothing structural applies, and unrecognisable to any text redactor, which is the same reason
 * `-o jsonpath` is refused outright.
 *
 * So the pipe is refused when a stage reads a Secret. Scoped to Secrets: for a ConfigMap or Pod the
 * redaction is pattern-based and survives reshaping far better, and refusing every filtered read would
 * cost far more than it protects.
 */
function checkSecretIntoPipe(commands: string[]): string | null {
  if (commands.length < 2) return null;
  for (let i = 0; i < commands.length - 1; i++) {
    const args = parseArgs(commands[i]);
    if (getCommandBinary(commands[i]).toLowerCase() !== "kubectl") continue;
    // kubectlSubcommand, not a fresh scan: the flag-arity table is the whole point. I wrote this line
    // by hand in the very commit that consolidated the other two readers, and it reproduced the same
    // bypass one layer up — `kubectl -n default get secret … | jq -r .data.password` read as subcommand
    // "default" and was not guarded at all.
    const sub = kubectlSubcommand(args.slice(1));
    if (sub !== "get" && sub !== "describe") continue;
    if (!argsNameSecrets(args, sub)) continue;
    return JSON.stringify({
      error: "Piping a Secret read into another command is not allowed. `-o json` is permitted only because the "
        + "structural sanitizer redacts its values, and that applies to what the LAST stage prints — a "
        + "filter can turn the object into a bare value the redactor cannot recognise.",
      hint: "Run the read on its own (`kubectl get secret <name> -o json`) and work from the redacted "
        + "output, or use `kubectl describe secret <name>` for key names and byte counts.",
    }, null, 2);
  }
  return null;
}

/**
 * Validate kubectl commands within a pipeline.
 * Checks that subcommands are in the safe whitelist.
 * Returns an error message if blocked, or null if all kubectl commands are safe.
 */
export function validateKubectlInPipeline(commands: string[]): string | null {
  // Before the per-command checks: this one is about the pipeline SHAPE, not any single command.
  const piped = checkSecretIntoPipe(commands);
  if (piped) return piped;

  for (const cmd of commands) {
    const binary = getCommandBinary(cmd);
    if (binary !== "kubectl") continue;

    // Extract the kubectl arguments from the command string
    const stripped = cmd.trim().replace(/^\S+\s+/, ""); // remove "kubectl" prefix
    const args = parseArgs(stripped);
    // ONE reader, with the shared flag-arity table. A local copy of the value-flag list is how
    // `kubectl --as get delete pod victim` got through: `--as` was missing from it, so `get` was taken
    // as the subcommand and the mutating `delete` was never examined. The table lives with the
    // sanitizer because both sides must agree about where the verb is.
    const subcommand = kubectlSubcommand(args);

    if (subcommand === "exec") {
      return JSON.stringify({
        error: "kubectl exec is not available through restricted_bash.",
        hint: "Use the pod_exec tool to run commands inside a pod, or node_exec for host-level diagnostics.",
      }, null, 2);
    }

    // `rollout history` is a read: it prints revisions and nothing else. The other rollout verbs
    // (undo, restart, pause, resume) mutate, so the allowance is on the VERB, not the subcommand — a
    // review shows the blanket refusal costing five calls to rebuild the same information out of
    // Deployment annotations and ReplicaSets.
    if (subcommand === "rollout") {
      // The verb needs the same treatment as the subcommand: `kubectl rollout -n history restart …`
      // otherwise reads `history` (the namespace) as the verb and permits a restart, while
      // `kubectl rollout -n x history …` is refused for naming `x`. Wrong in both directions.
      const afterRollout = args.slice(args.indexOf("rollout") + 1);
      const verb = kubectlSubcommand(afterRollout);
      // `continue`, NOT `return null` — this loop examines every stage of the pipeline, and returning
      // from it declared the WHOLE command safe because its first stage was. `kubectl rollout history
      // deploy/x | kubectl delete pod victim` passed, as did `| kubectl exec`, `| kubectl get secret -o
      // yaml`, and the `;` forms. `SAFE_SUBCOMMANDS` lives only in this function, so nothing downstream
      // re-checked the verb. Mine, from the commit that added this allowance.
      if (verb === "history") continue;
      return JSON.stringify({
        error: `kubectl rollout "${verb ?? "(no verb)"}" is not allowed in read-only mode.`,
        hint: "Only `kubectl rollout history` is permitted — the other verbs (undo, restart, pause, "
          + "resume) change cluster state.",
      }, null, 2);
    }

    // `auth` is on the safe list as a FAMILY, and it is not one: `can-i` and `whoami` are reads, but
    // `auth reconcile` creates and updates Roles and RoleBindings — kubectl's own help says "Missing
    // objects are created". The API's RBAC may still refuse it; this validator's claim that no write can
    // pass must not depend on that. Same verb-level treatment as `rollout`.
    if (subcommand === "auth") {
      const verb = kubectlSubcommand(args.slice(args.indexOf("auth") + 1));
      if (verb === "can-i" || verb === "whoami") continue;
      return JSON.stringify({
        error: `kubectl auth "${verb ?? "(no verb)"}" is not allowed in read-only mode.`,
        hint: "Only `kubectl auth can-i` and `kubectl auth whoami` are permitted. `auth reconcile` "
          + "creates and updates RBAC objects.",
      }, null, 2);
    }

    if (!subcommand || !SAFE_SUBCOMMANDS.has(subcommand)) {
      return JSON.stringify({
        error: `kubectl subcommand "${subcommand || "(empty)"}" is not allowed in read-only mode.`,
        allowed: [...SAFE_SUBCOMMANDS],
      }, null, 2);
    }

    // The inline --kubeconfig flag is removed — selecting a cluster is done via the
    // tool's `cluster` parameter (whole-command KUBECONFIG injection). This also
    // closes the file-path-in-flag footgun. To query a different cluster, make a
    // separate bash call with that `cluster`.
    if (args.some((a) => a === "--kubeconfig" || a.startsWith("--kubeconfig="))) {
      return JSON.stringify({
        error: "The --kubeconfig flag is not supported.",
        hint: "Set the `cluster` parameter to the target cluster's name (from cluster_list) instead. For multiple clusters, make a separate bash call per cluster.",
      }, null, 2);
    }

    // ── Rate protection: logs without --tail/--since ─────────────
    if (subcommand === "logs") {
      const hasTail = args.some(a => a === "--tail" || a.startsWith("--tail="));
      const hasSince = args.some(a =>
        a === "--since" || a.startsWith("--since=") ||
        a === "--since-time" || a.startsWith("--since-time="),
      );
      if (!hasTail && !hasSince) {
        return JSON.stringify({
          error: "kubectl logs without --tail or --since can pull excessive data from the kubelet.",
          hint: 'Add --tail=<N> or --since=<duration>, e.g. "kubectl logs my-pod --tail=1000".',
        }, null, 2);
      }
    }

    // ── `get --raw` has no printer, so nothing can sanitize it ───
    //
    // It is an API passthrough: the response arrives with no printer and no resource token, so
    // `detectSensitiveResource` matches nothing and the output sanitizer attaches NOTHING. A `/secrets`
    // path was already refused; `/configmaps` and `/pods` were not, and those carry registry credentials
    // and container env respectively — the two documents the sanitizer exists for.
    //
    // An ALLOW-LIST of paths, not a deny-list of resource kinds. Enumerating which API paths hold
    // credentials is the same guessing game as enumerating how kubectl spells a Secret — a `/secrets`
    // segment was already refused and `/configmaps` and `/pods` were not — and this branch has no
    // sanitizer to fall back on when the guess is wrong.
    //
    // Refusing ALL of it was the first attempt and it was too much: `--raw /metrics`, `/healthz` and
    // `/version` are ordinary diagnostics that return no API objects at all, and an existing test pins
    // them precisely because someone needed them. So the rule is: the non-object endpoints, and nothing
    // else. Anything that could return a serialized resource goes through `kubectl get <kind> -o json`,
    // which is the same data WITH the sanitizer attached.
    const rawPath = rawPassthroughPath(args);
    if (rawPath !== undefined && !isDiagnosticApiPath(rawPath)) {
      return JSON.stringify({
        error: `\`kubectl get --raw ${rawPath}\` is not allowed: a raw API response arrives with no `
          + `printer and no resource type, so no output filter can be applied to it.`,
        hint: "Only the non-object endpoints are permitted this way (/metrics, /healthz, /readyz, /livez, "
          + "/version, /api, /apis). For a resource, use the typed read — `kubectl get configmap <name> "
          + "-o json` — which returns the same object through the sanitizer.",
      }, null, 2);
    }

    // ── A Secret may only be printed in a form that cannot show its values ───
    const secretFmtErr = checkSecretOutputFormat(args, subcommand);
    if (secretFmtErr) {
      return JSON.stringify({ error: secretFmtErr }, null, 2);
    }

    // ── Rate protection: -A/--all-namespaces ───
    const allNsErr = checkAllNamespacesRestriction(args, subcommand);
    if (allNsErr) {
      return JSON.stringify({
        error: allNsErr,
        hint: "Use -n <namespace> to target a specific namespace, or add -l <label> / --field-selector <selector> to narrow the query.",
      }, null, 2);
    }

    // Block "kubectl config view --raw" — leaks full kubeconfig with certs/tokens
    if (subcommand === "config") {
      const configSub = args.filter((a) => !a.startsWith("-"));
      const hasView = configSub.includes("view");
      // `--raw` is a BOOLEAN flag, so kubectl accepts `--raw`, `--raw=true` and `--raw=1` alike — an
      // exact-match check caught only the first, and the other two print the full kubeconfig with its
      // client certificates and tokens. Any `--raw` spelling is refused: a `--raw=false` that someone
      // meant literally loses nothing by being rejected here.
      const hasRaw = args.some((a) => a === "--raw" || a.startsWith("--raw="));
      if (hasView && hasRaw) {
        return JSON.stringify({
          error: "kubectl config view --raw is not allowed — it exposes credentials.",
        }, null, 2);
      }
    }

    // Sensitive resource access (Secret, ConfigMap, Pod) is handled by
    // post-execution sanitization via OUTPUT_RULES["kubectl"] + pipeline
    // fallback redaction. No pre-execution blocking needed here.
  }
  return null;
}
