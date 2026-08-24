/**
 * What you ask next, as data.
 *
 * Reading one Kubernetes object almost never answers the question — the answer is one edge away, and
 * which edge is fixed per kind. A crashing pod sends you to its node and its owner; a Pending pod to
 * the node's capacity; a NotReady node to what is scheduled on it. Every triage skill in `skills/core`
 * documents one of these walks in prose, and the traces show the agent performing them one model
 * round-trip per edge.
 *
 * So the edges live here, as a TABLE. Supporting another kind is a row, not a branch and not another
 * tool — which is the whole difference between this and seven scenario-shaped snapshots.
 *
 * Everything in this file is pure: table plus renderers, no I/O, no clock, no cluster. `k8s-object.ts`
 * does the fetching. That split is what makes the interesting half testable without a cluster.
 */

import { readJsonPath } from "../infra/json-projection.js";
import { redactDocument } from "../infra/kubectl-sanitize.js";

/**
 * Default maximum length of a cluster-supplied free-text field promoted into the summary.
 * A container's death message is occasionally a whole stack trace; callers with their own enclosing
 * line budget (Events) may pass a different ceiling.
 */
const MAX_MESSAGE_CHARS = 200;

/**
 * A cluster-supplied free-text field, redacted and clipped before it is promoted.
 *
 * The structural pod sanitizer does NOT cover these. Measured, not assumed: for a pod carrying
 * `DB_PASSWORD=hunter2` both in `env[].value` and inside `lastState.terminated.message`, `sanitizeJSON`
 * redacts the env value and passes the message through verbatim — reasonably, since it redacts by
 * SHAPE and a message is prose.
 *
 * That is survivable while the message sits in a 40-line JSON document the model may not read closely.
 * This file's whole purpose is to promote a handful of fields into a summary that WILL be read, so the
 * text redactor is applied to exactly the promoted ones. `redactDocument` rather than `redactLines`
 * because it carries state across lines, and a death message can be several.
 *
 * What that does and does not buy, measured rather than assumed — a message that IS a `KEY=secret`
 * line, a PEM block, or a `scheme://user:pass@host` URL is redacted; a token embedded mid-sentence
 * (`failed to auth with token eyJ…`) is NOT, because `KV_LINE_RE` anchors the key at the start of a
 * line and prose has no key there.
 *
 * That residual gap is accepted, for a stated reason: it is not introduced here. The same message
 * already reaches the model verbatim through the `kubectl get pod -o json` the agent would otherwise
 * have run itself, so this call strictly REDUCES what gets through. Closing the gap properly means a
 * redactor that scans anywhere in a line, which is a change to the sanitization layer for every
 * caller — not something to invent inside one renderer.
 */
export function safeText(raw: string | undefined, maxChars = MAX_MESSAGE_CHARS): string | undefined {
  if (!raw) return undefined;
  const { text } = redactDocument(raw);
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > maxChars ? flat.slice(0, maxChars - 1) + "…" : flat;
}

// ── Reading values out of a fetched object ──────────────────────────

/** First value at `path`, or undefined. The common case: a scalar field that may be absent. */
export function one(obj: unknown, path: string): unknown {
  const hits = readJsonPath(obj, path);
  return hits.length > 0 ? hits[0] : undefined;
}

/** First value at `path` as a non-empty string, or undefined. Absent, null and "" all collapse. */
export function str(obj: unknown, path: string): string | undefined {
  const v = one(obj, path);
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

/** Every value at `path`, dropping absent ones. */
export function all(obj: unknown, path: string): unknown[] {
  return readJsonPath(obj, path).filter((v) => v !== undefined && v !== null);
}

// ── The relation shape ──────────────────────────────────────────────

export interface NamedNeighbourTarget {
  name: string;
  kind: string;
}

/** Where a neighbour is fetched from: a name carried by the subject, or a list query over it. */
export type Neighbour =
  /**
   * The subject names the neighbour. `nameAt` is where; `kindAt` lets the kind come from the object
   * too, which `ownerReferences` needs — a pod's owner is a ReplicaSet, a Job, a StatefulSet or a
   * CRD, and hardcoding one of them would silently skip the others.
   */
  | {
      via: "name";
      nameAt: string;
      kind: string | { at: string };
      resolve?: never;
      scope: "cluster" | "namespace";
    }
  /**
   * Some relations cannot be expressed as two independent paths. OwnerReferences are an unordered
   * set, for example: the controller is the entry with `controller: true`, not necessarily index 0.
   */
  | {
      via: "name";
      resolve: (subject: unknown) => NamedNeighbourTarget | undefined;
      nameAt?: never;
      kind?: never;
      scope: "cluster" | "namespace";
    }
  /** No name to follow — a field-selector query. `node -> pods scheduled here` is the case. */
  | { via: "list"; kind: string; selector: (subjectName: string) => string; scope: "all-namespaces" };

export interface Relation {
  /** Section label in the output, e.g. `node`. Also what a failure is reported against in `status:`. */
  label: string;
  neighbour: Neighbour;
  /** At most a couple of lines. The budget is the point — see MAX_RENDER_CHARS in k8s-object.ts. */
  render: (obj: unknown) => string;
}

// ── Renderers ───────────────────────────────────────────────────────

/**
 * `Ready=True`, plus any condition that is asserting a problem — and for an abnormal one, WHY and
 * SINCE WHEN.
 *
 * A bare `DiskPressure=True` was the first version and it was too thin to be worth printing: the
 * reader's next question is always the reason and the transition time, so they had to run
 * `describe node` anyway and the summary had saved nothing. `since` matters most on `Ready`: "the
 * node went NotReady four minutes ago" and "it has been NotReady for a week" call for different
 * investigations, and a pod that crashed in between is explained by the first and not the second.
 *
 * A healthy condition still gets nothing but its name. `Ready=True` needs no excuse, and
 * `MemoryPressure=False` is the normal state of every working node — printing either with its
 * timestamp would crowd out the line that matters.
 */
function conditionSummary(obj: unknown, wanted: string): string {
  const conds = all(obj, ".status.conditions[]");
  const parts: string[] = [];
  const describe = (type: string, status: string, c: unknown): string => {
    const reason = str(c, ".reason");
    const since = str(c, ".lastTransitionTime");
    const message = safeText(str(c, ".message"));
    // The message only when there is no reason: a reason is the machine-readable form of the same
    // fact, and printing both is usually the same sentence twice.
    const why = reason ?? message;
    return `${type}=${status}${why ? ` (${why})` : ""}${since ? ` since ${since}` : ""}`;
  };
  for (const c of conds) {
    const type = str(c, ".type");
    const status = str(c, ".status");
    if (!type || !status) continue;
    if (type === wanted) {
      parts.unshift(status === "True" ? `${type}=True` : describe(type, status, c));
      continue;
    }
    if (status === "True") parts.push(describe(type, status, c));
  }
  return parts.join("  ") || "conditions: none reported";
}

/** One terminated state, current or previous. */
function renderTermination(state: unknown, label: "terminated" | "last"): string {
  const reason = str(state, ".reason") ?? "Terminated";
  const exit = str(state, ".exitCode");
  const signal = str(state, ".signal");
  const msg = safeText(str(state, ".message"));
  return `${label}: ${reason}${exit !== undefined ? ` exit ${exit}` : ""}`
    + `${signal !== undefined ? ` signal ${signal}` : ""}${msg ? ` — ${msg}` : ""}`;
}

/** Per-container: current state, readiness, restarts, and why it last died. */
export function renderPodContainers(obj: unknown): string {
  const statuses = [
    ...all(obj, ".status.initContainerStatuses[]").map((status) => ({ status, role: "init" as const })),
    ...all(obj, ".status.containerStatuses[]").map((status) => ({ status, role: "container" as const })),
    ...all(obj, ".status.ephemeralContainerStatuses[]").map((status) => ({ status, role: "ephemeral" as const })),
  ];
  if (statuses.length === 0) {
    // Not an error: a Pending pod that never got scheduled has no container statuses at all, and
    // saying so is the answer rather than a gap.
    return "containers: none started yet";
  }
  const lines: string[] = [];
  for (const { status: cs, role } of statuses) {
    const rawName = str(cs, ".name") ?? "?";
    const name = role === "container" ? rawName : `${role}/${rawName}`;
    const ready = one(cs, ".ready") === true;
    const restarts = Number(str(cs, ".restartCount") ?? "0");
    const bits: string[] = role === "container" ? [ready ? "ready" : "not ready"] : [];
    if (restarts > 0) bits.push(`${restarts} restart${restarts === 1 ? "" : "s"}`);

    // Why it is not running now. Init and ephemeral statuses are included because an init-container
    // image pull or crash prevents every regular container from starting.
    const waiting = str(cs, ".state.waiting.reason");
    if (waiting) {
      const msg = safeText(str(cs, ".state.waiting.message"));
      bits.push(`waiting: ${waiting}${msg ? ` — ${msg}` : ""}`);
      // The image, but ONLY here. For a waiting container it is frequently the answer — which
      // registry was contacted, which tag was asked for — and `image-pull-debug` spent a whole
      // round-trip on it. For a running one it is noise the reader already knows, and this summary
      // pays for every field it prints.
      const image = str(cs, ".image");
      if (image) bits.push(`image: ${image}`);
    }
    if (!waiting && role !== "container" && one(cs, ".state.running") !== undefined) bits.push("running");

    // A terminal pod has the reason in CURRENT state. CrashLoopBackOff has it in lastState. Reading
    // only the latter made a one-shot `Error`/`OOMKilled` pod look like an unexplained non-ready one.
    const terminated = one(cs, ".state.terminated");
    if (terminated !== undefined) bits.push(renderTermination(terminated, "terminated"));
    const lastTerminated = one(cs, ".lastState.terminated");
    if (lastTerminated !== undefined) bits.push(renderTermination(lastTerminated, "last"));

    if (bits.length === 0) bits.push("state unknown");
    lines.push(`  ${name}  ${bits.join("  ")}`);
  }
  return `containers:\n${lines.join("\n")}`;
}

/** The subject pod itself. */
export function renderPod(obj: unknown): string {
  const lines = [`phase:      ${str(obj, ".status.phase") ?? "unknown"}`];
  // A deleting pod is its own scenario, and `phase` does not show it: a pod stuck Terminating still
  // reads `Running`. The two fields that DO answer it are the deletion timestamp and the finalizers
  // still holding the object — which `pod-stuck-terminating` spends its first step reading with
  // `-o json | jq`. Conditional, so an ordinary pod pays nothing for them.
  const deleting = str(obj, ".metadata.deletionTimestamp");
  if (deleting) {
    const finalizers = all(obj, ".metadata.finalizers[]").filter((f) => typeof f === "string");
    const grace = str(obj, ".metadata.deletionGracePeriodSeconds");
    // The uid is not a deletion fact, but it is the key that correlates this pod with containerd's
    // and the kubelet's log lines — the next step of every stuck-Terminating investigation. It rides
    // the same gate, so an ordinary pod never pays for a 36-character identifier it has no use for.
    const uid = str(obj, ".metadata.uid");
    const bits = [`since ${deleting}`];
    if (grace !== undefined) bits.push(`grace ${grace}s`);
    bits.push(finalizers.length > 0 ? `finalizers: ${finalizers.join(",")}` : "no finalizers");
    if (uid) bits.push(`uid ${uid}`);
    lines.push(`deleting:   ${bits.join(", ")}`);
  }
  // `.status.reason`/`.message` carry the scheduler's and kubelet's own words (Evicted, and why).
  const reason = str(obj, ".status.reason");
  if (reason) {
    const msg = safeText(str(obj, ".status.message"));
    lines.push(`reason:     ${reason}${msg ? ` — ${msg}` : ""}`);
  }
  lines.push(renderPodContainers(obj));
  const conditions = conditionSummary(obj, "Ready");
  lines.push(conditions.startsWith("conditions:") ? conditions : `conditions: ${conditions}`);
  return lines.join("\n");
}

/** A node, as a neighbour of something else or as the subject. */
export function renderNode(obj: unknown): string {
  const bits: string[] = [conditionSummary(obj, "Ready")];
  const taints = all(obj, ".spec.taints[]");
  if (taints.length === 0) {
    bits.push("no taints");
  } else {
    // A taint is only ever interesting with its effect: NoSchedule is why a pod is Pending,
    // PreferNoSchedule almost never is.
    bits.push(`taints: ${taints.map((t) => `${str(t, ".key") ?? "?"}${str(t, ".effect") ? `:${str(t, ".effect")}` : ""}`).join(",")}`);
  }
  if (one(obj, ".spec.unschedulable") === true) bits.push("cordoned");
  const cpu = str(obj, ".status.allocatable.cpu");
  const mem = str(obj, ".status.allocatable.memory");
  if (cpu || mem) bits.push(`allocatable: ${[cpu && `cpu ${cpu}`, mem && `mem ${mem}`].filter(Boolean).join(" ")}`);
  return bits.join("   ");
}

/** A pod's controller. Deliberately shallow: desired-vs-ready is the question, the spec is not. */
export function renderOwner(obj: unknown): string {
  const kind = str(obj, ".kind") ?? "owner";
  const bits: string[] = [];
  // Every controller spells its counts differently, and a missing field must read as absent rather
  // than as zero — `0 ready` when the field simply is not there would be a fabricated answer.
  const desired = str(obj, ".spec.replicas") ?? str(obj, ".spec.parallelism") ?? str(obj, ".spec.minAvailable");
  const ready = str(obj, ".status.readyReplicas") ?? str(obj, ".status.ready") ?? str(obj, ".status.succeeded");
  if (desired !== undefined) bits.push(`desired ${desired}`);
  if (ready !== undefined) bits.push(`ready ${ready}`);
  const unavailable = str(obj, ".status.unavailableReplicas");
  if (unavailable !== undefined) bits.push(`unavailable ${unavailable}`);
  return `${kind}: ${bits.join("   ") || "no counts reported"}`;
}

/** Pods scheduled on a node, folded to phase counts — the distribution, not the inventory. */
export function renderPodDistribution(obj: unknown): string {
  const items = all(obj, ".items[]");
  if (items.length === 0) return "pods: none scheduled here";
  const byPhase = new Map<string, number>();
  for (const p of items) {
    const phase = str(p, ".status.phase") ?? "Unknown";
    byPhase.set(phase, (byPhase.get(phase) ?? 0) + 1);
  }
  const parts = [...byPhase.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`);
  return `pods: ${items.length} total (${parts.join(", ")})`;
}

/**
 * The owner that actually controls a pod.
 *
 * Kubernetes permits multiple ownerReferences and assigns no meaning to their order. At most one is
 * the controller; choosing index 0 can therefore walk to an auxiliary owner and omit the ReplicaSet,
 * Job or other controller that determines the pod's lifecycle. Legacy objects occasionally omit the
 * flag, so the first complete reference remains a compatibility fallback only when none is marked.
 */
export function resolveControllerOwner(obj: unknown): NamedNeighbourTarget | undefined {
  const refs = all(obj, ".metadata.ownerReferences[]");
  const complete = refs.flatMap((ref) => {
    const name = str(ref, ".name");
    const kind = str(ref, ".kind");
    return name && kind ? [{ ref, name, kind }] : [];
  });
  const selected = complete.find(({ ref }) => one(ref, ".controller") === true) ?? complete[0];
  return selected ? { name: selected.name, kind: selected.kind } : undefined;
}

// ── The table ───────────────────────────────────────────────────────

/**
 * Which kinds may be asked for, and how each one is fetched and rendered.
 *
 * `resource` is the kubectl token, not the API kind: it goes into a command line the read-only policy
 * then validates, so it must be spelled the way kubectl spells it.
 */
export interface KindSpec {
  resource: string;
  scope: "cluster" | "namespace";
  render: (obj: unknown) => string;
  relations: Relation[];
}

export const KINDS: Record<string, KindSpec> = {
  pod: {
    resource: "pod",
    scope: "namespace",
    render: renderPod,
    relations: [
      {
        label: "node",
        neighbour: { via: "name", nameAt: ".spec.nodeName", kind: "node", scope: "cluster" },
        render: renderNode,
      },
      {
        // The kind travels with the selected controller reference — a pod may be owned by a
        // ReplicaSet, Job, StatefulSet or a custom controller, so fixing it here would silently skip
        // every other case.
        label: "owner",
        neighbour: {
          via: "name",
          resolve: resolveControllerOwner,
          scope: "namespace",
        },
        render: renderOwner,
      },
    ],
  },
  node: {
    resource: "node",
    scope: "cluster",
    render: renderNode,
    relations: [
      {
        label: "pods",
        neighbour: {
          via: "list",
          kind: "pods",
          // An exact single-value field selector, which is what lets this pass the -A restriction:
          // `hasBoundingFieldSelector` admits `spec.nodeName==<exact>` and refuses the unbounded read
          // (command-sets.ts). Anything looser here is refused by the policy, correctly.
          selector: (name) => `spec.nodeName==${name}`,
          scope: "all-namespaces",
        },
        render: renderPodDistribution,
      },
    ],
  },
};

/** The kinds the tool advertises, for the schema and the error message. */
export const KNOWN_KINDS = Object.keys(KINDS);

/**
 * Normalise what the model asked for. Accepts the singular, the plural and kubectl's short form,
 * because those are what the SKILL.md prose and the model's own habits produce.
 */
export function resolveKind(raw: string): KindSpec | undefined {
  const k = raw.trim().toLowerCase().replace(/s$/, "");
  const aliases: Record<string, string> = { po: "pod", no: "node" };
  return KINDS[aliases[k] ?? k];
}
