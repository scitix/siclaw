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
  /**
   * The referenced object's uid, when the reference carries one. A name is NOT an identity: delete a
   * ReplicaSet and let a rolled-back Deployment recreate one with the same name and template hash, and
   * a name-only fetch returns a real object that is not the one this pod references — reported as its
   * owner, with `status: ok`. The uid is what turns that into a finding.
   */
  uid?: string;
  /**
   * `apps/v1`, or `v1` for the core group. Two Kinds can share a name across API groups (a CRD `Job`
   * beside `batch/v1` Job), and a bare `kubectl get job <name>` resolves to whichever the discovery
   * client prefers — silently the wrong object.
   */
  apiVersion?: string;
}

/**
 * Where a neighbour is fetched from: a name carried by the subject, or a list query over it.
 *
 * `scope` says whether the neighbour is read cluster-wide or inside a namespace, and for `namespace` it
 * means THE SUBJECT'S namespace — the only one a relation can currently express.
 *
 * That is not a limitation to work around, for the edges that exist: Kubernetes requires an owner to be
 * either cluster-scoped or in the same namespace as its dependent, so `ownerReferences` cannot point
 * elsewhere. It is written down because the field NAME implies a generality the reader might supply —
 * a future relation crossing namespaces would inherit the subject's and query the wrong one silently,
 * which is exactly the kind of confident wrong answer this file is trying not to produce. Such a
 * relation must add the path to the neighbour's namespace, not reuse `namespace` and hope.
 */
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
 * Which conditions earn a line, per kind.
 *
 * Polarity is NOT uniform across kinds and cannot be read off the value. A node's non-Ready conditions
 * are PROBLEM assertions — `DiskPressure=True` is bad and `False` is the normal state of every working
 * node. A pod's are READINESS assertions — `PodScheduled=True` is the normal state and `False` is the
 * answer. The first version printed every True condition, which is right for a node and exactly
 * inverted for a pod: measured on a live healthy pod, four timestamped `=True` lines took ~200 of the
 * subject section's 700 characters, and a broken pod's `Ready=False` was buried in that green wall.
 *
 * The sharper half is what was DROPPED rather than what was added: a Pending pod's
 * `PodScheduled=False (Unschedulable)` is the one field that answers why it is Pending, and the old
 * rule printed nothing for it. Its message also outlives the `FailedScheduling` event, so for a pod
 * pending longer than the event TTL it is the only copy of the answer left in the cluster.
 */
export interface ConditionPolicy {
  /** Printed even when healthy: the kind's one-line verdict. */
  wanted: string;
  /**
   * When a NON-wanted condition of this kind is worth a line. `notTrue` means anything other than
   * `True`, `Unknown` included — a kubelet that stopped reporting leaves conditions Unknown, and for a
   * readiness assertion that is as much of an answer as `False`. Naming this after the k8s status values
   * rather than a boolean is deliberate: `abnormal: "false"` read as "not abnormal", and its actual
   * meaning covered a third value it did not name.
   */
  abnormalWhen: "True" | "notTrue";
  /** Types that break the kind's own rule — a pod's `DisruptionTarget=True` means it is being evicted. */
  invert?: readonly string[];
}

const NODE_CONDITIONS: ConditionPolicy = { wanted: "Ready", abnormalWhen: "True" };
const POD_CONDITIONS: ConditionPolicy = { wanted: "Ready", abnormalWhen: "notTrue", invert: ["DisruptionTarget"] };

/**
 * A condition message is clipped harder than other promoted text.
 *
 * It shares a section budget with the fields around it (a node's taints and allocatable capacity come
 * AFTER the conditions and are what a clip would eat), and the specific thing worth having is short: a
 * scheduler's `0/115 nodes are available: 3 Insufficient cpu, 112 node(s) didn't match …` fits well
 * inside this.
 */
const MAX_CONDITION_MESSAGE_CHARS = 120;

/**
 * The `wanted` condition, plus every condition this kind considers abnormal — and for an abnormal one,
 * WHY and SINCE WHEN.
 *
 * A bare `DiskPressure=True` was the first version and it was too thin to be worth printing: the
 * reader's next question is always the reason and the transition time, so they had to run
 * `describe node` anyway and the summary had saved nothing. `since` matters most on `Ready`: "the
 * node went NotReady four minutes ago" and "it has been NotReady for a week" call for different
 * investigations, and a pod that crashed in between is explained by the first and not the second.
 *
 * A healthy `wanted` gets nothing but its name — `Ready=True` needs no excuse, and its transition time
 * would crowd out the line that matters. A healthy non-wanted condition gets no line at all:
 * `MemoryPressure=False` is the normal state of every working node, and `PodScheduled=True` of every
 * running pod.
 *
 * The reason AND the message, when both exist. An earlier version printed only the reason, on the
 * grounds that a reason is the machine-readable form of the same fact — which holds for
 * `KubeletHasDiskPressure` / "kubelet has disk pressure" and fails for exactly the case this summary
 * exists to answer: `Unschedulable` names the category while the message carries the per-node-class
 * breakdown. Occasionally paying for the same sentence twice, clipped, is the cheaper mistake.
 *
 * Conditions carrying the SAME explanation are folded onto one line, measured on a live
 * ImagePullBackOff pod: `Ready` and `ContainersReady` reported an identical status, reason, message and
 * transition time, which is ~110 characters of a 700-character budget spent restating one fact — and it
 * is the ordinary shape of a pod that is not ready, not an edge case. Folding requires a NON-EMPTY
 * explanation: an empty one says only "no reason given", so merging on it would assert a shared cause
 * that nothing in the object supports, and across the wanted/abnormal boundary it would be actively
 * wrong — a node's `Ready=True` and `DiskPressure=True` are opposite findings that happen to share a
 * blank tail.
 */
function conditionSummary(obj: unknown, policy: ConditionPolicy): string {
  const conds = all(obj, ".status.conditions[]");
  /** One rendered line, still open for another condition type reporting the identical explanation. */
  interface Entry { types: string[]; status: string; tail: string }
  const entries: Entry[] = [];
  const tailOf = (c: unknown): string => {
    const reason = str(c, ".reason");
    const since = str(c, ".lastTransitionTime");
    const message = safeText(str(c, ".message"), MAX_CONDITION_MESSAGE_CHARS);
    const why = [reason, message].filter(Boolean).join(": ");
    return `${why ? ` (${why})` : ""}${since ? ` since ${since}` : ""}`;
  };
  const isAbnormal = (type: string, status: string): boolean => {
    const rule = policy.invert?.includes(type)
      ? (policy.abnormalWhen === "True" ? "notTrue" : "True")
      : policy.abnormalWhen;
    return rule === "True" ? status === "True" : status !== "True";
  };
  const add = (type: string, status: string, tail: string, first: boolean): void => {
    const shared = tail === "" ? undefined : entries.find((e) => e.status === status && e.tail === tail);
    if (shared) { shared.types.push(type); return; }
    const entry: Entry = { types: [type], status, tail };
    if (first) entries.unshift(entry); else entries.push(entry);
  };
  for (const c of conds) {
    const type = str(c, ".type");
    const status = str(c, ".status");
    if (!type || !status) continue;
    if (type === policy.wanted) {
      // A healthy `wanted` needs no excuse, so it carries no tail and never absorbs another condition.
      add(type, status, status === "True" ? "" : tailOf(c), true);
      continue;
    }
    if (isAbnormal(type, status)) add(type, status, tailOf(c), false);
  }
  const parts = entries.map((e) => `${e.types.join("/")}=${e.status}${e.tail}`);
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
  const conditions = conditionSummary(obj, POD_CONDITIONS);
  lines.push(conditions.startsWith("conditions:") ? conditions : `conditions: ${conditions}`);
  return lines.join("\n");
}

/** A node, as a neighbour of something else or as the subject. */
export function renderNode(obj: unknown): string {
  const bits: string[] = [conditionSummary(obj, NODE_CONDITIONS)];
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
  if (!selected) return undefined;
  // uid and apiVersion are both REQUIRED fields on an ownerReference, but they are read as optional
  // here: this runs on whatever the apiserver returned, and a summary that throws away the identity
  // check because one field was missing is worse than one that checks when it can.
  return {
    name: selected.name,
    kind: selected.kind,
    uid: str(selected.ref, ".uid"),
    apiVersion: str(selected.ref, ".apiVersion"),
  };
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
  /**
   * Which field selector finds this kind's events — a per-kind fact about WHO writes them, not a style
   * choice, so it lives in the table.
   *
   * `uid` is the stronger selector where it works: events outlive a deleted object for a while, and a
   * name can be reused by the next incarnation, so a pod's uid names the exact one that crashed.
   *
   * A node needs `name`, because the kubelet does not derive its node reference from the node object.
   * It writes `ObjectReference{Kind:"Node", Name:nodeName, UID:types.UID(nodeName)}` — the node's NAME
   * in the uid field. So a uid selector matches the controller-manager's node events and misses every
   * kubelet-emitted one: NodeNotReady, Rebooted, ImageGCFailed, FreeDiskSpaceFailed, which is the exact
   * set `node-health-check` exists to read. The name selector matches both, and a node name is a stable
   * identity in a way a pod name is not — the reuse this trades away is the same physical machine.
   */
  eventsBy: "uid" | "name";
  render: (obj: unknown) => string;
  relations: Relation[];
}

export const KINDS: Record<string, KindSpec> = {
  pod: {
    resource: "pod",
    scope: "namespace",
    eventsBy: "uid",
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
    eventsBy: "name",
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

const ALIASES: Record<string, string> = { po: "pod", no: "node" };

/**
 * Own properties only. `KINDS` and `ALIASES` are object literals, so they inherit Object.prototype and
 * a bare index lookup answers `constructor`, `toString` and `__proto__` with a truthy non-KindSpec —
 * from a model-supplied string. The caller's `if (!spec)` then passes and the first `spec.relations`
 * throws. Same bug class as the denial-reason Map lookup in the Feishu path.
 */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Normalise what the model asked for. Accepts the singular, the plural and kubectl's short form,
 * because those are what the SKILL.md prose and the model's own habits produce.
 *
 * The EXACT spelling is tried before any de-pluralising. Stripping a trailing `s` unconditionally read
 * `ingress` as `ingres` and `endpoints` as `endpoint`, so the table's own promise — supporting a kind is
 * adding a row — would have silently failed for every kind whose singular ends in s, at the moment
 * someone added the row and not before.
 */
export function resolveKind(raw: string): KindSpec | undefined {
  const k = raw.trim().toLowerCase();
  for (const candidate of [own(ALIASES, k) ?? k, k.replace(/s$/, ""), k.replace(/es$/, "")]) {
    const hit = own(KINDS, candidate);
    if (hit) return hit;
  }
  return undefined;
}
