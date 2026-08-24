/**
 * k8s_inspect — read one object and its neighbourhood in a single model round-trip.
 *
 * Measured motivation: across 1411 production traces, model round-trips are 75% of wall-clock time and
 * 77% of them carry a single tool call. Some of that is not the model failing to batch but a chain it
 * cannot batch: `kubectl get pod` -> read `.spec.nodeName` -> read that node is three round-trips
 * because the second command's ARGUMENT is the first command's OUTPUT. Concurrent tool calls cannot
 * collapse that; resolving the edge in code can, which is the same trick `node_script` already uses
 * when it takes a pod and finds the node itself.
 *
 * The edges are a table in `k8s-relations.ts`, so a new kind is a row. What is here is the fetching,
 * and it holds three contracts:
 *
 *   1. A probe cannot do anything the agent could not have done itself. Every probe command goes
 *      through `preExecSecurity` with restricted_bash's own options, including the read-only kubectl
 *      policy — so this tool has no privileges of its own, only fewer round-trips.
 *
 *   2. A neighbour that fails degrades the answer, it does not fail the call, and it is never silent.
 *      Exactly one `status:` line, last, naming what was missed — the convention `get-node-logs.sh`
 *      established, for the reason #493 recorded: an empty section and a forbidden section look
 *      identical and call for opposite next steps.
 *
 *   3. The whole rendering is small enough to survive `processToolOutput` intact. A bundle that gets
 *      truncated in the middle costs more context than the calls it replaced and answers less.
 */
import { Type } from "@sinclair/typebox";
import type { ToolEntry } from "../../core/tool-registry.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { KubeconfigRef } from "../../core/types.js";
import { renderTextResult } from "../infra/tool-render.js";
import { postExecSecurity, preExecSecurity } from "../infra/security-pipeline.js";
import { applySanitizer } from "../infra/output-sanitizer.js";
import { redactDocument } from "../infra/kubectl-sanitize.js";
import { validateKubectlInPipeline } from "../infra/kubectl-readonly-policy.js";
import {
  buildSandboxCommand, SANDBOX_KILL_GRACE_S, OUTER_BACKSTOP_MARGIN_S,
} from "../infra/sandbox-exec.js";
import { boundedExec } from "../infra/bounded-exec.js";
import { parseSanitizedJson } from "../infra/json-projection.js";
import { resolveRequiredKubeconfig } from "../infra/kubeconfig-resolver.js";
import { ensureClusterForTool, classifyClusterFailure } from "../infra/ensure-kubeconfigs.js";
import { sanitizeEnv } from "../infra/sanitize-env.js";
import { loadConfig } from "../../core/config.js";
import { KNOWN_KINDS, resolveKind, str, type KindSpec, type Relation } from "./k8s-relations.js";

/**
 * Budgets. The per-probe cap bounds one hung API call; the total bounds the tool. Both are well under
 * restricted_bash's 60s default because this is a fixed set of small reads — if they are slow the
 * cluster is the finding, and reporting that quickly beats waiting.
 *
 * The two deadlines on a single probe are ORDERED, and getting that wrong is the bug #507 fixed in
 * restricted_bash: in production the command runs as `sandbox` behind `timeout`, while the
 * `boundedExec` timer runs as `agentbox` with no CAP_KILL and can therefore only abandon the CALL,
 * not stop the command. Setting both to the same 8s let the outer one pre-empt the only timer that
 * can actually kill anything. So the outer one is padded by the same margin restricted_bash uses,
 * and only in production, where the wrapper exists at all.
 */
const PROBE_TIMEOUT_MS = 8_000;
const TOTAL_TIMEOUT_MS = 15_000;

function outerTimeoutMs(isProd: boolean): number {
  return isProd
    ? PROBE_TIMEOUT_MS + (SANDBOX_KILL_GRACE_S + OUTER_BACKSTOP_MARGIN_S) * 1000
    : PROBE_TIMEOUT_MS;
}

/**
 * The rendering ceiling, enforced rather than hoped for.
 *
 * `processToolOutput` truncates at 8000 characters keeping only a 3000-char head and tail, so an
 * oversized bundle loses its MIDDLE — which is where the neighbour sections are. A bundle that gets
 * truncated costs more context than the calls it replaced and answers less, so the budget is a
 * first-class constraint here rather than a hope.
 *
 * The per-part caps and the total have to be ARITHMETICALLY consistent, which they were not when
 * these numbers were first written: one cap of 700 for every section put the worst case at ~3460
 * against a 3000 total, and no fixture reached it only because `renderNode` and `renderOwner` happen
 * to emit a single line each. A budget that depends on renderers staying terse is not a budget.
 *
 * So a neighbour gets less than the subject — it is a one-line summary by design — and
 * `worstCaseChars` computes the ceiling from the relation table, which is what lets a test fail when
 * a new relation would push the total over. Adding relations therefore forces a deliberate revisit
 * instead of silently starting to truncate.
 */
const MAX_TOTAL_CHARS = 5_500;
const MAX_SUBJECT_CHARS = 700;
// 400, not 300: a node's abnormal conditions carry their reason and transition time, which is what
// makes the section worth reading instead of a prompt to go run `describe`.
const MAX_NEIGHBOUR_CHARS = 400;
const MAX_EVENT_LINES = 6;
// FailedScheduling messages commonly enumerate several rejection classes. 160 characters cut off
// the reason the pending-pod skill asks the reader to act on, so events receive most of the bundle's
// budget. The output still stays below processToolOutput's 8000-character truncation threshold:
// 220 + 700 + 6*600 + 2*400 = 5320 for the current largest relation table.
const MAX_EVENT_CHARS = 600;
/** Section headers, the `=== kind ns/name ===` line and the trailing `status:` line. */
const CHROME_CHARS = 220;

/** The largest output this kind can produce, from the table. Exported so a test can hold it to the budget. */
export function worstCaseChars(spec: { relations: unknown[] }): number {
  return CHROME_CHARS
    + MAX_SUBJECT_CHARS
    + MAX_EVENT_LINES * MAX_EVENT_CHARS
    + spec.relations.length * MAX_NEIGHBOUR_CHARS;
}

export const BUDGET = { MAX_TOTAL_CHARS, MAX_SUBJECT_CHARS, MAX_NEIGHBOUR_CHARS, MAX_EVENT_LINES, MAX_EVENT_CHARS };

/** How a probe ended. `not_found` is an ANSWER about existence, not a failure — see classifyExit. */
type ProbeFailure = "not_found" | "forbidden" | "timeout" | "refused" | "unreachable" | "error";

interface ProbeOk { ok: true; text: string }
interface ProbeBad { ok: false; reason: ProbeFailure; detail?: string }
type ProbeResult = ProbeOk | ProbeBad;

/**
 * Read the failure's own words rather than guessing from an exit code.
 *
 * Deliberately narrow: only the distinctions that change what the caller should do next. Everything
 * else is `error` with the message kept, because inventing a category for an unrecognised failure is
 * how a transport problem gets reported as a statement about the object.
 */
function classifyProbeFailure(stderr: string, timedOut: boolean): ProbeBad {
  if (timedOut) return { ok: false, reason: "timeout" };
  const s = stderr.toLowerCase();
  // Only the API's typed NotFound answer proves the object is absent. A broad `not found` match also
  // catches `/bin/bash: kubectl: command not found` and missing exec credential plugins, turning a
  // local dependency failure into a successful existence answer.
  if (/error from server\s*\(notfound\)\s*:/.test(s)) return { ok: false, reason: "not_found" };
  if (/forbidden|is not allowed|cannot list|cannot get/.test(s)) return { ok: false, reason: "forbidden" };
  if (/connection refused|no such host|i\/o timeout|dial tcp|unable to connect/.test(s)) {
    return { ok: false, reason: "unreachable" };
  }
  // This detail is later promoted into the model-visible summary rather than passed as stderr to
  // postExecSecurity, so redact it here. Credential plugins and proxies can write secrets to stderr.
  const { text, redacted } = redactDocument(stderr);
  const detail = firstLine(text) + (redacted ? " [sensitive content redacted]" : "");
  return { ok: false, reason: "error", ...(detail ? { detail } : {}) };
}

function firstLine(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 160 ? line.slice(0, 157) + "…" : line;
}

export interface ProbeDeps {
  env: Record<string, string>;
  isProd: boolean;
  signal?: AbortSignal;
  /** Injected so tests exercise the real command-building and classification without a cluster. */
  exec?: typeof boundedExec;
}

/**
 * Run one read and return its SANITIZED text.
 *
 * The sanitizer runs; `processToolOutput` deliberately does not. That split matters and is the one
 * place this file departs from the usual `postExecSecurity` route, so the reasoning is explicit: a
 * probe's output is an INTERMEDIATE value this file parses, and `processToolOutput` would truncate it
 * at 8000 characters — which on a Node document means handing `JSON.parse` a prefix and reading the
 * resulting failure as "the object does not exist". Nothing here reaches the model directly; the
 * rendered result goes out through a single `postExecSecurity` at the end, so the model-visible text
 * is bounded exactly once, by the same function as every other tool.
 */
export async function runProbe(command: string, deps: ProbeDeps): Promise<ProbeResult> {
  // The same gate restricted_bash applies to the model's own commands. This is what makes the claim
  // "no privileges of its own" checkable rather than a comment: a probe this policy would refuse does
  // not run, even though this file wrote it.
  const pre = preExecSecurity(command, {
    context: "local",
    extraAllowed: new Set(["kubectl"]),
    pipelineValidators: [validateKubectlInPipeline],
    analyzeTarget: "single",
  });
  if (pre.error) return { ok: false, reason: "refused", detail: firstLine(pre.error) };

  const line = deps.isProd
    ? buildSandboxCommand(command, { timeoutS: Math.ceil(PROBE_TIMEOUT_MS / 1000) })
    : command;

  const exec = deps.exec ?? boundedExec;
  try {
    const { stdout } = await exec(line, {
      env: deps.env,
      timeoutMs: outerTimeoutMs(deps.isProd),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    // Sanitize before anything reads it, including this file. Parsing raw stdout instead would show
    // this code the values the sanitizer exists to remove.
    return { ok: true, text: applySanitizer(stdout, pre.action) };
  } catch (err: any) {
    // An abort is what the tool's own total budget looks like from here, and it arrives as
    // `aborted`, not `timedOut` — so reading only the latter reported a budget expiry as a generic
    // `error` with no message, which says nothing about what to do next. Both mean "we stopped
    // waiting"; the distinction between our deadline and the caller's is not one the reader can act
    // on differently.
    const stoppedByUs = err?.timedOut === true || err?.code === 124 || err?.aborted === true;
    return classifyProbeFailure(String(err?.stderr ?? err?.message ?? ""), stoppedByUs);
  }
}

// ── Command construction ────────────────────────────────────────────

/**
 * kubectl object names are a restricted alphabet (RFC 1123 subdomain form), and a
 * namespace more restricted still. Rejecting anything else here means no value from the model is
 * interpolated into a command line without having been checked first — the validator downstream
 * parses the command, but it cannot know that a name was supposed to be a name.
 */
const NAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i;

function badName(value: string): boolean {
  return value.length === 0 || value.length > 253 || !NAME_RE.test(value);
}

function nsFlag(namespace: string | undefined, scope: "cluster" | "namespace" | "all-namespaces"): string {
  if (scope === "all-namespaces") return " -A";
  if (scope === "cluster") return "";
  return namespace ? ` -n ${namespace}` : "";
}

function getJsonCommand(resource: string, name: string, namespace: string | undefined, scope: "cluster" | "namespace"): string {
  return `kubectl get ${resource} ${name}${nsFlag(namespace, scope)} -o json`;
}

/**
 * Events for one object, newest last.
 *
 * Prefer the subject UID over its name. Events outlive a deleted object for a while, and another kind
 * in the same namespace may have the same name; the UID is the only selector that identifies this
 * exact incarnation. Fall back to name + kind only for malformed/legacy objects without a usable UID.
 * An exact selector also lets the `-A` form pass the all-namespaces restriction.
 */
function eventsCommand(
  name: string,
  namespace: string | undefined,
  scope: "cluster" | "namespace",
  uid: string | undefined,
  kind: string | undefined,
): string {
  const where = scope === "cluster" ? " -A" : nsFlag(namespace, "namespace");
  const selector = uid && !badName(uid)
    ? `involvedObject.uid=${uid}`
    : [
        `involvedObject.name=${name}`,
        ...(kind && !badName(kind) ? [`involvedObject.kind=${kind}`] : []),
      ].join(",");
  return `kubectl get events${where} --field-selector ${selector} --sort-by=.lastTimestamp`;
}

// ── Rendering ───────────────────────────────────────────────────────

function clip(text: string, max: number): string {
  const t = text.trimEnd();
  return t.length <= max ? t : t.slice(0, max - 1) + "…";
}

/**
 * Keep the newest events. `--sort-by` puts them last, so the tail is what matters — and the header is
 * dropped because the columns are self-evident and cost a line of the budget.
 */
function renderEvents(text: string): string {
  const lines = text.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return "";
  const body = lines[0].startsWith("LAST SEEN") || lines[0].startsWith("NAMESPACE") ? lines.slice(1) : lines;
  if (body.length === 0) return "";
  const shown = body.slice(-MAX_EVENT_LINES);
  const omitted = body.length - shown.length;
  const head = `--- events (${body.length}${omitted > 0 ? `, newest ${shown.length}` : ""}) ---`;
  return [head, ...shown.map((l) => clip(l, MAX_EVENT_CHARS))].join("\n");
}

/** `status:` values, in the vocabulary get-node-logs.sh established. */
function statusLine(subjectOk: boolean, misses: string[]): string {
  if (!subjectOk) return "status: error";
  return misses.length === 0 ? "status: ok" : `status: partial (${misses.join(", ")})`;
}

// ── Orchestration ───────────────────────────────────────────────────

export interface K8sInspectParams {
  kind: string;
  name: string;
  namespace?: string;
  cluster?: string;
}

interface Section { label: string; text: string }

/**
 * Fetch the subject, then every neighbour its kind declares, then render.
 *
 * Neighbours run concurrently: they are independent reads and the whole point is to spend one wait
 * rather than one per edge.
 */
export async function collectObject(
  spec: KindSpec,
  params: K8sInspectParams,
  deps: ProbeDeps,
): Promise<{ text: string; failed: boolean; subjectReason?: ProbeFailure }> {
  const ns = params.namespace;

  const subject = await runProbe(getJsonCommand(spec.resource, params.name, ns, spec.scope), deps);
  if (!subject.ok) {
    // The subject is the answer. A missing object is a legitimate finding, so it is reported as one
    // rather than dressed up as a tool malfunction — but it is not dressed up as a healthy read either.
    const detail = subject.detail ? `\ndetail:  ${subject.detail}` : "";
    return {
      text: `=== ${spec.resource} ${ns ? `${ns}/` : ""}${params.name} ===\nresult:  ${subject.reason}${detail}\n\nstatus: ${subject.reason}`,
      failed: subject.reason !== "not_found",
      subjectReason: subject.reason,
    };
  }

  const parsed = parseSanitizedJson(subject.text);
  if (parsed === undefined) {
    // The read succeeded and the body is not JSON. That is a real, distinct state (a sanitizer that
    // suppressed the document, a kubectl that printed a warning instead) and must not read as absent.
    return {
      text: `=== ${spec.resource} ${ns ? `${ns}/` : ""}${params.name} ===\nresult:  unparseable response\n\nstatus: error`,
      failed: true,
      subjectReason: "error",
    };
  }

  const misses: string[] = [];
  const sections: Section[] = [];

  // Events and the declared neighbours are all independent of each other — one wait for all of them.
  const eventsPromise = runProbe(eventsCommand(
    params.name,
    ns,
    spec.scope,
    str(parsed, ".metadata.uid"),
    str(parsed, ".kind"),
  ), deps);
  const neighbourPromises = spec.relations.map(async (rel: Relation) => {
    const n = rel.neighbour;
    if (n.via === "list") {
      const cmd = `kubectl get ${n.kind} -A --field-selector ${n.selector(params.name)} -o json`;
      return { rel, result: await runProbe(cmd, deps) };
    }
    const name = str(parsed, n.nameAt);
    if (!name) return { rel, result: undefined };
    const kind = typeof n.kind === "string" ? n.kind : str(parsed, n.kind.at);
    if (!kind || badName(kind)) return { rel, result: undefined };
    return { rel, result: await runProbe(getJsonCommand(kind.toLowerCase(), name, ns, n.scope), deps) };
  });

  const [events, neighbours] = await Promise.all([eventsPromise, Promise.all(neighbourPromises)]);

  for (const { rel, result } of neighbours) {
    // `undefined` means the subject does not name this neighbour — a bare pod has no owner. Absent by
    // nature is not a miss, and reporting it as one would make every static pod look degraded.
    if (result === undefined) continue;
    if (!result.ok) {
      misses.push(`${rel.label}: ${result.reason}`);
      continue;
    }
    const obj = parseSanitizedJson(result.text);
    if (obj === undefined) {
      misses.push(`${rel.label}: unparseable`);
      continue;
    }
    sections.push({ label: rel.label, text: clip(rel.render(obj), MAX_NEIGHBOUR_CHARS) });
  }

  const parts: string[] = [
    `=== ${spec.resource} ${ns ? `${ns}/` : ""}${params.name} ===`,
    clip(spec.render(parsed), MAX_SUBJECT_CHARS),
  ];

  if (events.ok) {
    const rendered = renderEvents(events.text);
    // No events is an answer worth stating: for a Pending pod it means the scheduler never spoke.
    parts.push(rendered || "--- events (0) ---");
  } else {
    misses.push(`events: ${events.reason}`);
  }

  for (const s of sections) parts.push(`--- ${s.label} ---\n${s.text}`);

  parts.push(statusLine(true, misses));
  return { text: clip(parts.join("\n\n"), MAX_TOTAL_CHARS), failed: false };
}

// ── Tool ────────────────────────────────────────────────────────────

export function createK8sInspectTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
  return {
    name: "k8s_inspect",
    label: "K8s Object",
    renderCall(args: any, theme: any) {
      const target = [args?.kind, args?.namespace ? `${args.namespace}/${args?.name}` : args?.name]
        .filter(Boolean).join(" ");
      return new Text(theme.fg("toolTitle", theme.bold("k8s_inspect")) + " " + theme.fg("accent", target), 0, 0);
    },
    renderResult: renderTextResult,
    description: `Read one Kubernetes object together with the things you would ask about next, in a
single call: its own key status, its recent events, and its immediate neighbours (for a pod, the node
it runs on and its controller; for a node, what is scheduled on it).

Use this as the FIRST step when triaging a named object — a crashing or pending pod, an unhealthy
node. It replaces the usual opening sequence of \`kubectl get\`, \`kubectl get events\` and a follow-up
read of the node or owner, which cost one model round-trip each because the later commands' arguments
come from the earlier commands' output.

Every read goes through the same read-only kubectl policy as restricted_bash, so this tool can see
nothing the agent could not read itself. Output is deliberately compact and ends with exactly one
\`status:\` line: \`ok\`, \`partial (<what was missed and why>)\`, or a failure naming the subject's own
result. Read that line — \`partial (node: forbidden)\` means the node section is MISSING, not empty, and
an empty events section means the object genuinely has no events rather than that they were not
fetched. For anything this does not cover (logs, exec, arbitrary queries, other kinds) use
restricted_bash.

Kinds: ${KNOWN_KINDS.join(", ")}.`,
    parameters: Type.Object({
      kind: Type.String({ description: `Object kind. One of: ${KNOWN_KINDS.join(", ")}. Singular, plural and kubectl short forms are accepted.` }),
      name: Type.String({ description: "The object's exact name (not a substring or selector)." }),
      namespace: Type.Optional(Type.String({ description: "Namespace for a namespaced kind. Omit for cluster-scoped kinds (node) or to use the kubeconfig's default namespace." })),
      cluster: Type.Optional(Type.String({ description: "Target cluster name from cluster_list. Required when more than one cluster is bound." })),
    }),
    async execute(_toolCallId, rawParams, signal?: AbortSignal) {
      const params = rawParams as K8sInspectParams;

      const spec = resolveKind(params.kind ?? "");
      if (!spec) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: `Unsupported kind "${params.kind}".`,
            supported: KNOWN_KINDS,
            hint: "For a kind this tool does not cover, read it with restricted_bash.",
          }, null, 2) }],
          details: { blocked: true },
        };
      }
      // Checked before any command is built, so nothing unvalidated is ever interpolated.
      for (const [field, value] of [["name", params.name], ["namespace", params.namespace]] as const) {
        if (value !== undefined && badName(value)) {
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: `Invalid ${field} "${value}" — expected a Kubernetes object name.`,
            }, null, 2) }],
            details: { blocked: true },
          };
        }
      }

      const broker = kubeconfigRef?.credentialBroker;
      try {
        await ensureClusterForTool(broker, params.cluster, "k8s_inspect");
      } catch (err) {
        const failure = await classifyClusterFailure(broker, params.cluster, err);
        return {
          content: [{ type: "text", text: JSON.stringify(failure, null, 2) }],
          details: { error: true, reason: failure.reason },
        };
      }
      const resolved = resolveRequiredKubeconfig({ broker }, params.cluster);
      if ("error" in resolved) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            error: true, message: resolved.error, available_clusters: resolved.availableNames,
          }, null, 2) }],
          details: { error: true, reason: "unknown_cluster" },
        };
      }

      const env: Record<string, string> = {
        ...sanitizeEnv(process.env as Record<string, string>),
        SICLAW_DEBUG_IMAGE: loadConfig().debugImage,
        KUBECONFIG: resolved.path ?? "/dev/null",
      };

      // The tool's own deadline, independent of any single probe's. A probe set that cannot finish in
      // this window is itself the finding.
      const budget = AbortSignal.timeout(TOTAL_TIMEOUT_MS);
      const deps: ProbeDeps = {
        env,
        isProd: process.env.NODE_ENV === "production",
        signal: signal ? AbortSignal.any([signal, budget]) : budget,
      };

      const { text, failed, subjectReason } = await collectObject(spec, params, deps);
      return {
        // One postExecSecurity for the whole rendering: the probes' own sanitizers already ran, and this
        // is where the model-visible text gets bounded, exactly like every other tool's output.
        content: [{ type: "text", text: postExecSecurity(text, null) }],
        details: {
          ...(failed ? { error: true } : {}),
          ...(subjectReason ? { subject_result: subjectReason } : {}),
        },
      };
    },
  };
}

/**
 * Read-only and delegable for the same reason `cluster_list` is: every probe it can run is one the
 * read-only kubectl policy already admits, so a delegate holding this tool can reach nothing it
 * could not reach with restricted_bash.
 */
export const registration: ToolEntry = {
  category: "query",
  create: (refs) => createK8sInspectTool(refs.kubeconfigRef),
  readOnlyDelegable: true,
};
