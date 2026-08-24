/**
 * The fetching half: what a probe is allowed to run, and what the answer says when part of it fails.
 *
 * `boundedExec` is injected rather than mocked by path, so the real command building, the real
 * `preExecSecurity` gate and the real classification all run — only the process does not. The
 * commands recorded by the fake ARE the assertion for the security claim: a probe cannot do anything
 * restricted_bash would have refused, and that is only checkable by looking at what it tried to run.
 */
import { describe, it, expect } from "vitest";
import { runProbe, collectObject, worstCaseChars, BUDGET, DEADLINES, type ProbeDeps } from "./k8s-inspect.js";
import { KINDS } from "./k8s-relations.js";

/** A fake exec that records every command line and answers from a table. */
function fakeExec(answers: Record<string, string | Error>) {
  const seen: string[] = [];
  const exec = ((command: string) => {
    seen.push(command);
    // Match on a substring so a caller states the distinguishing part of the command, not all of it.
    for (const [needle, answer] of Object.entries(answers)) {
      if (command.includes(needle)) {
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ stdout: answer, stderr: "" });
      }
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  }) as unknown as ProbeDeps["exec"];
  return { exec, seen };
}

function deps(answers: Record<string, string | Error>): ProbeDeps & { seen: string[] } {
  const { exec, seen } = fakeExec(answers);
  return { env: {}, isProd: false, exec, seen };
}

const failure = (stderr: string) => Object.assign(new Error("boom"), { stderr });

const POD = {
  kind: "Pod",
  metadata: {
    name: "web", namespace: "default", uid: "pod-uid-123",
    ownerReferences: [{ kind: "ReplicaSet", name: "web-7d9f" }],
  },
  spec: { nodeName: "node-42" },
  status: {
    phase: "Running",
    conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady" }],
    containerStatuses: [{
      name: "app", ready: false, restartCount: 7,
      lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
    }],
  },
};
const NODE = {
  kind: "Node", metadata: { uid: "node-uid-456" }, spec: { taints: [] },
  status: { conditions: [{ type: "Ready", status: "True" }] },
};
const RS = { kind: "ReplicaSet", spec: { replicas: 3 }, status: { readyReplicas: 2 } };

const pod = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ...POD, ...overrides });
const eventList = (messages: string[] = []) => JSON.stringify({
  kind: "EventList",
  items: messages.map((message, index) => ({
    metadata: { creationTimestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString() },
    type: index % 2 === 0 ? "Warning" : "Normal",
    reason: `Event${index}`,
    involvedObject: { kind: "Pod", name: "web" },
    message,
  })),
});
const NO_EVENTS = eventList();

describe("runProbe — the read-only policy applies to the tool's own commands", () => {
  it("runs an ordinary read", async () => {
    const d = deps({ "get pod web": "hello" });
    const r = await runProbe("kubectl get pod web -n default -o json", d);
    expect(r.ok).toBe(true);
    expect(d.seen).toHaveLength(1);
  });

  it("refuses a command the policy forbids, WITHOUT running it", async () => {
    // The claim this tool makes is that it has no privileges of its own. If a forbidden command were
    // merely absent from the table rather than gated, this file could grow one by accident.
    const d = deps({});
    const r = await runProbe("kubectl delete pod web", d);
    expect(r).toMatchObject({ ok: false, reason: "refused" });
    expect(d.seen).toHaveLength(0);
  });

  it("refuses an unbounded all-namespaces JSON read, which is the shape a relation could regress into", async () => {
    const d = deps({});
    const r = await runProbe("kubectl get pods -A -o json", d);
    expect(r).toMatchObject({ ok: false, reason: "refused" });
    expect(d.seen).toHaveLength(0);
  });

  it("sanitizes before returning, so nothing downstream sees an unredacted value", async () => {
    // Reverting the applySanitizer call to `return stdout` fails here. Asserted on runProbe rather
    // than through the renderer because the fields the renderer promotes are ones the sanitizer does
    // not touch — through the rendering this property is invisible.
    const withSecret = JSON.stringify({
      kind: "Pod",
      spec: { containers: [{ name: "app", env: [{ name: "DB_PASSWORD", value: "hunter2" }] }] },
    });
    const d = deps({ "get pod web": withSecret });
    const r = await runProbe("kubectl get pod web -n default -o json", d);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).not.toContain("hunter2");
      expect(r.text).toContain("REDACTED");
    }
  });

  it("reads the failure's own words rather than guessing from an exit code", async () => {
    const cases: Array<[string, string]> = [
      ['Error from server (NotFound): pods "web" not found', "not_found"],
      ['Error from server (Forbidden): pods "web" is forbidden', "forbidden"],
      ["Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout", "unreachable"],
      ["something nobody has seen before", "error"],
    ];
    for (const [stderr, expected] of cases) {
      const d = deps({ "get pod web": failure(stderr) });
      const r = await runProbe("kubectl get pod web -o json", d);
      expect(r, stderr).toMatchObject({ ok: false, reason: expected });
    }
  });

  it("does not report a missing kubectl or credential plugin as an absent object", async () => {
    const d = deps({ "get pod web": failure("/bin/bash: kubectl: command not found") });
    expect(await runProbe("kubectl get pod web -o json", d)).toMatchObject({ ok: false, reason: "error" });
  });

  it("redacts a generic stderr detail before it can enter the summary", async () => {
    const d = deps({ "get pod web": failure("API_TOKEN=hunter2") });
    const result = await runProbe("kubectl get pod web -o json", d);
    expect(result).toMatchObject({ ok: false, reason: "error" });
    if (!result.ok) {
      expect(result.detail).not.toContain("hunter2");
      expect(result.detail).toContain("REDACTED");
    }
  });

  it("reports a timeout as a timeout, not as a statement about the object", async () => {
    const d = deps({ "get pod web": Object.assign(new Error("timed out"), { timedOut: true }) });
    expect(await runProbe("kubectl get pod web -o json", d)).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("reports an abort as a timeout too, since both mean we stopped waiting", async () => {
    // boundedExec throws `aborted`, not `timedOut`, when the tool's own total budget expires. Reading
    // only `timedOut` reported that as a bare `error` with no message.
    const d = deps({ "get pod web": Object.assign(new Error("aborted"), { aborted: true }) });
    expect(await runProbe("kubectl get pod web -o json", d)).toMatchObject({ ok: false, reason: "timeout" });
  });

  it("lets the sandbox-side deadline fire before the outer one, in production", async () => {
    // The bug #507 fixed in restricted_bash, reintroduced here by giving both the same 8s: in
    // production the inner `timeout` runs as `sandbox` and is the only one that can KILL the command,
    // while the outer timer runs as agentbox without CAP_KILL and can only abandon the call. If the
    // outer fires first it pre-empts the only effective deadline.
    const seen: Array<{ command: string; timeoutMs: number; reap?: () => void }> = [];
    const exec = ((command: string, opts: { timeoutMs: number; reap?: () => void }) => {
      seen.push({ command, timeoutMs: opts.timeoutMs, ...(opts.reap ? { reap: opts.reap } : {}) });
      return Promise.resolve({ stdout: "{}", stderr: "" });
    }) as unknown as ProbeDeps["exec"];

    await runProbe("kubectl get pod web -o json", { env: {}, isProd: true, exec });
    const innerS = Number(/timeout -k \d+ (\d+)/.exec(seen[0].command)![1]);
    expect(seen[0].timeoutMs).toBeGreaterThan(innerS * 1000);
    expect(seen[0].command).toContain("setsid sh -c");
    expect(seen[0].command).toContain("siclaw-bg-k8s-inspect-");
    expect(seen[0].reap).toEqual(expect.any(Function));

    // Outside production there is no wrapper, so the outer timer IS the deadline and padding it would
    // silently extend every probe — the other half of that same fix.
    seen.length = 0;
    await runProbe("kubectl get pod web -o json", { env: {}, isProd: false, exec });
    expect(seen[0].command).not.toContain("timeout -k");
    expect(seen[0].timeoutMs).toBe(8_000);
    expect(seen[0].reap).toBeUndefined();
  });
});

describe("collectObject — the status line", () => {
  const statusOf = (text: string) => {
    const lines = text.trimEnd().split("\n");
    return lines[lines.length - 1];
  };
  const statusCount = (text: string) => text.split("\n").filter((l) => l.startsWith("status:")).length;

  it("reports ok when the subject and every neighbour answered", async () => {
    const d = deps({
      "get pod web": pod(),
      "get node node-42": JSON.stringify(NODE),
      "get replicaset web-7d9f": JSON.stringify(RS),
      "get events": eventList(["Back-off restarting"]),
    });
    const { text, failed } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(statusOf(text)).toBe("status: ok");
    expect(failed).toBe(false);
    expect(text).toContain("OOMKilled");
    expect(text).toContain("--- node (node-42) ---");
    expect(text).toContain("--- owner (web-7d9f) ---");
  });

  it("names a failed neighbour in status and still returns the subject", async () => {
    // The lesson from #493: an absent section and a forbidden section look identical and call for
    // opposite next steps, so the difference has to be stated. The first version of this test then
    // asserted `not.toContain("--- node (")` — demanding the two look identical, the very thing the
    // comment above says must not happen. The section IS emitted, carrying the resolved name and the
    // reason; what makes it distinguishable from a healthy read is the text, not the absence.
    const d = deps({
      "get pod web": pod(),
      "get node node-42": failure('Error from server (Forbidden): nodes "node-42" is forbidden'),
      "get replicaset web-7d9f": JSON.stringify(RS),
      "get events": eventList(["warning"]),
    });
    const { text, failed } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(statusOf(text)).toBe("status: partial (node: forbidden)");
    expect(text).toContain("--- node (node-42) ---");
    expect(text).toContain("not read: forbidden");
    // …and carries no node CONTENT, since none was read. `no taints` is what renderNode emits for the
    // NODE fixture, so its absence is what separates this from a successful read.
    expect(text).not.toContain("no taints");
    // A neighbour failure must not fail the call — the subject is still the answer.
    expect(failed).toBe(false);
    expect(text).toContain("OOMKilled");
  });

  it("emits exactly one status line, always last, in every outcome", async () => {
    const scenarios: Array<Record<string, string | Error>> = [
      { "get pod web": pod(), "get node node-42": JSON.stringify(NODE), "get events": NO_EVENTS },
      { "get pod web": pod(), "get node node-42": failure("Forbidden"), "get events": failure("Forbidden") },
      { "get pod web": failure('Error from server (NotFound): pods "web" not found') },
      { "get pod web": "this is not json at all" },
    ];
    for (const answers of scenarios) {
      const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, deps(answers));
      expect(statusCount(text), text).toBe(1);
      expect(statusOf(text).startsWith("status:"), text).toBe(true);
    }
  });

  it("treats a missing subject as an answer, not as a tool failure", async () => {
    const d = deps({ "get pod web": failure('Error from server (NotFound): pods "web" not found') });
    const { text, failed, subjectReason } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(statusOf(text)).toBe("status: not_found");
    expect(subjectReason).toBe("not_found");
    // not_found is an existence answer — the same distinction classifyExit makes for `local` context.
    expect(failed).toBe(false);
  });

  it("treats an unreachable cluster as a failure, unlike a missing object", async () => {
    const d = deps({ "get pod web": failure("Unable to connect to the server: dial tcp: i/o timeout") });
    const { failed, subjectReason } = await collectObject(KINDS.pod, { kind: "pod", name: "web" }, d);
    expect(subjectReason).toBe("unreachable");
    expect(failed).toBe(true);
  });

  it("does not walk neighbours when the subject never parsed", async () => {
    const d = deps({ "get pod web": "warning: something, and no document" });
    const { text, failed } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).toContain("unparseable");
    expect(failed).toBe(true);
    // One probe, not four: there is no object to read a neighbour's name out of.
    expect(d.seen).toHaveLength(1);
  });
});

describe("collectObject — neighbours", () => {
  it("omits a neighbour the subject does not name, without calling it a miss", async () => {
    // A static pod has no ownerReferences. Reporting that as degraded would make every one look broken.
    const bare = JSON.stringify({ ...POD, metadata: { name: "web", namespace: "default" } });
    const d = deps({ "get pod web": bare, "get node node-42": JSON.stringify(NODE), "get events": NO_EVENTS });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text.trimEnd().endsWith("status: ok")).toBe(true);
    expect(text).not.toContain("--- owner (");
    expect(text).not.toContain("owner:");
  });

  it("follows the owner's declared kind rather than assuming ReplicaSet", async () => {
    const jobOwned = JSON.stringify({
      ...POD,
      metadata: { name: "web", namespace: "default", ownerReferences: [{ kind: "Job", name: "batch-1" }] },
    });
    const d = deps({ "get pod web": jobOwned, "get node node-42": JSON.stringify(NODE), "get events": NO_EVENTS });
    await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(d.seen.some((c) => c.includes("get job batch-1"))).toBe(true);
  });

  it("follows the controller owner rather than the first ownerReference", async () => {
    const multiplyOwned = JSON.stringify({
      ...POD,
      metadata: {
        name: "web", namespace: "default",
        ownerReferences: [
          { kind: "ConfigMap", name: "auxiliary-owner" },
          { kind: "ReplicaSet", name: "web-controller", controller: true },
        ],
      },
    });
    const d = deps({
      "get pod web": multiplyOwned,
      "get node node-42": JSON.stringify(NODE),
      "get replicaset web-controller": JSON.stringify(RS),
      "get events": NO_EVENTS,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(d.seen.some((c) => c.includes("get replicaset web-controller"))).toBe(true);
    expect(d.seen.some((c) => c.includes("get configmap auxiliary-owner"))).toBe(false);
    expect(text).toContain("--- owner (web-controller) ---");
  });

  it("asks for a node's pods with an exact field selector, the only form the policy admits", async () => {
    const d = deps({ "get node node-42": JSON.stringify(NODE), "get pods": JSON.stringify({ items: [] }), "get events": NO_EVENTS });
    const { text } = await collectObject(KINDS.node, { kind: "node", name: "node-42" }, d);
    const podsCall = d.seen.find((c) => c.includes("get pods"))!;
    expect(podsCall).toContain("--field-selector spec.nodeName==node-42");
    expect(text).toContain("none scheduled");
  });

  it("uses -A for a cluster-scoped subject's events and -n for a namespaced one", async () => {
    const dn = deps({ "get node node-42": JSON.stringify(NODE), "get pods": JSON.stringify({ items: [] }) });
    await collectObject(KINDS.node, { kind: "node", name: "node-42" }, dn);
    expect(dn.seen.find((c) => c.includes("get events"))).toContain(" -A ");

    const dp = deps({ "get pod web": pod(), "get node node-42": JSON.stringify(NODE) });
    await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "prod" }, dp);
    expect(dp.seen.find((c) => c.includes("get events"))).toContain("-n prod");
  });

  it("selects a pod's events by the fetched object's UID, not a reusable name", async () => {
    const d = deps({
      "get pod web": pod(),
      "get node node-42": JSON.stringify(NODE),
      "get replicaset web-7d9f": JSON.stringify(RS),
    });
    await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    const eventCall = d.seen.find((c) => c.includes("get events"))!;
    expect(eventCall).toContain("--field-selector involvedObject.uid=pod-uid-123");
    expect(eventCall).not.toContain("involvedObject.name=web");
    expect(eventCall).toContain("-o json");
  });

  it("selects a NODE's events by name and kind, because its uid field holds the name", async () => {
    // The NODE fixture carries a real uid, so a uid-preferring implementation passes every other test in
    // this file and returns a short list here: the kubelet writes `UID:types.UID(nodeName)`, so
    // NodeNotReady / Rebooted / ImageGCFailed never match a uid selector while the controller-manager's
    // events (real uid) do. Reverting `eventsBy` to an unconditional uid preference fails this.
    const d = deps({ "get node node-42": JSON.stringify(NODE), "get pods": JSON.stringify({ items: [] }) });
    await collectObject(KINDS.node, { kind: "node", name: "node-42" }, d);
    const eventCall = d.seen.find((c) => c.includes("get events"))!;
    expect(eventCall).toContain("involvedObject.name=node-42");
    // Paired, because a name is unique only within a kind — a pod named after its node would match too.
    expect(eventCall).toContain("involvedObject.kind=Node");
    expect(eventCall).not.toContain("involvedObject.uid");
    expect(eventCall).not.toContain("node-uid-456");
  });

  it("falls back to the name form when a uid-preferring kind has no usable uid", async () => {
    // Never unfiltered: `-A -o json` without a bounding selector is refused outright, so a missing uid
    // must degrade to the other exact form rather than to no selector.
    const d = deps({
      "get pod web": pod({ metadata: { name: "web", namespace: "default" } }),
      "get node node-42": JSON.stringify(NODE),
    });
    await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    const eventCall = d.seen.find((c) => c.includes("get events"))!;
    expect(eventCall).toContain("involvedObject.name=web");
    expect(eventCall).toContain("involvedObject.kind=Pod");
  });

  it("reports a missing named neighbour as a finding, not as a gap in our own data", async () => {
    // A pod still assigned to a node whose object is gone is the sharpest diagnosis this tool can
    // produce. Filing it under `status: partial (node: not_found)` reads as "we failed to look".
    const d = deps({
      "get pod web": pod(),
      "get node node-42": failure('Error from server (NotFound): nodes "node-42" not found'),
      "get replicaset web-7d9f": JSON.stringify(RS),
      "get events": NO_EVENTS,
    });
    const { text, failed } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).toContain("--- node (node-42) ---");
    expect(text).toContain("not found");
    expect(text.trimEnd().split("\n").at(-1)).toBe("status: ok");
    expect(failed).toBe(false);
  });

  it("still reports a neighbour we were not allowed to read as a gap", async () => {
    // The distinction is the point: forbidden means we do not know, not_found means we do.
    const d = deps({
      "get pod web": pod(),
      "get node node-42": failure('Error from server (Forbidden): nodes "node-42" is forbidden'),
      "get replicaset web-7d9f": JSON.stringify(RS),
      "get events": NO_EVENTS,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text.trimEnd().split("\n").at(-1)).toBe("status: partial (node: forbidden)");
  });

  it("keeps the resolved neighbour NAME when the read of it fails", async () => {
    // The name is the argument the next step needs, and a pod's own summary does not carry one — so
    // dropping it on a failed read left the output with no node name anywhere, costing the caller
    // exactly the round-trip this tool exists to save. Resolving `.spec.nodeName` succeeded; only the
    // node read failed.
    const d = deps({
      "get pod web": pod(),
      "get node node-42": failure('Error from server (Forbidden): nodes "node-42" is forbidden'),
      "get replicaset web-7d9f": JSON.stringify(RS),
      "get events": NO_EVENTS,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).toContain("--- node (node-42) ---");
    expect(text).toContain("not read: forbidden");
    // And the failure is still declared — the section is not a substitute for the status line.
    expect(text.trimEnd().split("\n").at(-1)).toBe("status: partial (node: forbidden)");
  });

  it("says nothing about a neighbour the subject never names", async () => {
    // An unscheduled pod has no `.spec.nodeName`, so there is no read to report on at all. (Guarded by
    // the early return before the probe, not by the failure path below — stated because the two look
    // the same from the output.)
    const d = deps({
      "get pod web": pod({ spec: {} }),
      "get replicaset web-7d9f": JSON.stringify(RS),
      "get events": NO_EVENTS,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).not.toContain("--- node");
    expect(text).not.toContain("not read:");
  });

  it("does not invent a target for a failed LIST relation, which has no single name", async () => {
    // This is where keeping the name has to be conditional: a node's `pods` query resolves no single
    // object, so there is nothing to carry forward and a section headed by a fabricated name would be
    // worse than the status line alone.
    const d = deps({
      "get node node-42": JSON.stringify(NODE),
      "get pods": failure('Error from server (Forbidden): pods is forbidden'),
      "get events": NO_EVENTS,
    });
    const { text } = await collectObject(KINDS.node, { kind: "node", name: "node-42" }, d);
    expect(text).not.toContain("not read:");
    expect(text.trimEnd().split("\n").at(-1)).toBe("status: partial (pods: forbidden)");
  });

  it("keeps a list relation's not_found a gap, because the finding's wording does not apply to it", async () => {
    // A list has no named target, so rendering "the subject names it" would state something false about
    // a query that merely came back NotFound. The stderr here is the API's TYPED NotFound — the only
    // form classified as not_found — so the exclusion is actually exercised.
    const d = deps({
      "get node node-42": JSON.stringify(NODE),
      "get pods": failure("Error from server (NotFound): the server could not find the requested resource"),
      "get events": NO_EVENTS,
    });
    const { text } = await collectObject(KINDS.node, { kind: "node", name: "node-42" }, d);
    expect(text).not.toContain("the subject names it");
    expect(text.trimEnd().split("\n").at(-1)).toBe("status: partial (pods: not_found)");
  });

  it("reports a reused owner name as a finding instead of a stranger's replica counts", async () => {
    // A name is not an identity. Delete a ReplicaSet and let a rolled-back Deployment recreate one with
    // the same name and template hash, and a name-only fetch returns a real object that is NOT the one
    // this pod references — previously rendered as its owner, with `status: ok`.
    const owned = JSON.stringify({
      ...POD,
      metadata: {
        ...POD.metadata,
        ownerReferences: [{ kind: "ReplicaSet", name: "web-7d9f", uid: "rs-uid-OLD", apiVersion: "apps/v1", controller: true }],
      },
    });
    const d = deps({
      "get pod web": owned,
      "get node node-42": JSON.stringify(NODE),
      "get replicaset": JSON.stringify({ ...RS, metadata: { uid: "rs-uid-NEW" } }),
      "get events": NO_EVENTS,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).toContain("--- owner (web-7d9f) ---");
    expect(text).toContain("name reused");
    // The stranger's counts must NOT be attributed to this pod.
    expect(text).not.toContain("desired 3");
  });

  it("renders the owner normally when the uid matches", async () => {
    const owned = JSON.stringify({
      ...POD,
      metadata: {
        ...POD.metadata,
        ownerReferences: [{ kind: "ReplicaSet", name: "web-7d9f", uid: "rs-uid-1", apiVersion: "apps/v1", controller: true }],
      },
    });
    const d = deps({
      "get pod web": owned,
      "get node node-42": JSON.stringify(NODE),
      "get replicaset": JSON.stringify({ ...RS, metadata: { uid: "rs-uid-1" } }),
      "get events": NO_EVENTS,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).toContain("desired 3");
    expect(text).not.toContain("name reused");
  });

  it("keeps the owner summary when the reference carries no uid to check against", async () => {
    // The POD fixture's ownerReference has no uid. Dropping the summary because one field is missing
    // would be worse than checking when we can — and `.spec.nodeName` can never carry a uid at all.
    const d = deps({
      "get pod web": pod(),
      "get node node-42": JSON.stringify(NODE),
      "get replicaset": JSON.stringify({ ...RS, metadata: { uid: "whatever" } }),
      "get events": NO_EVENTS,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).toContain("desired 3");
    expect(text).not.toContain("name reused");
  });

  it("qualifies an owner fetch with its API group, so a same-named CRD cannot answer for it", async () => {
    // A bare `kubectl get job <name>` resolves via the discovery client's preferred version, so a CRD
    // Kind sharing a built-in's name silently answers instead.
    const owned = JSON.stringify({
      ...POD,
      metadata: {
        ...POD.metadata,
        ownerReferences: [{ kind: "Job", name: "batch-1", uid: "job-uid", apiVersion: "batch/v1", controller: true }],
      },
    });
    const d = deps({
      "get pod web": owned,
      "get node node-42": JSON.stringify(NODE),
      "get job.batch batch-1": JSON.stringify({ kind: "Job", metadata: { uid: "job-uid" }, spec: { parallelism: 2 }, status: {} }),
      "get events": NO_EVENTS,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(d.seen.some((c) => c.includes("get job.batch batch-1"))).toBe(true);
    expect(text).toContain("desired 2");
  });

  it("runs the neighbour reads concurrently, not one after another", async () => {
    // The whole point is one wait instead of one per edge. A serial implementation passes every other
    // test in this file.
    let live = 0;
    let peak = 0;
    const exec = ((command: string) => {
      live++; peak = Math.max(peak, live);
      const body = command.includes("get pod web") ? pod()
        : command.includes("get node") ? JSON.stringify(NODE)
        : command.includes("get replicaset") ? JSON.stringify(RS) : NO_EVENTS;
      return new Promise((resolve) => setTimeout(() => { live--; resolve({ stdout: body, stderr: "" }); }, 20));
    }) as unknown as ProbeDeps["exec"];
    await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, { env: {}, isProd: false, exec });
    // events + node + owner all in flight together; the subject read is necessarily first.
    expect(peak).toBeGreaterThanOrEqual(3);
  });
});

describe("the three deadlines", () => {
  // #507's lesson, as arithmetic. Only the inner `timeout -k 5 8` runs as `sandbox` and can KILL; the
  // outer per-probe timer runs as `agentbox` without CAP_KILL and can merely abandon the call, leaving
  // the process behind. So the killing timer must fire FIRST, and the one that fires next must be the
  // total, whose abort carries boundedExec's reap. The three numbers come from three places —
  // SANDBOX_KILL_GRACE_S from infra, the per-probe cap from this file, the total derived from it — so
  // shrinking the infra constant silently inverts the prod ordering with no other test noticing.
  it("lets the only killing timer fire before the one that can merely abandon", () => {
    // `timeout -k <grace> <n>` sends TERM at n and KILL at n+grace, so a command ignoring TERM lives
    // until the KILL. That KILL must land before the outer timer gives up, or the outer abandons a call
    // whose process is still running as `sandbox`.
    expect(DEADLINES.PROBE_WORST_CASE_MS).toBeGreaterThan(DEADLINES.PROBE_TIMEOUT_MS);
    expect(DEADLINES.PROBE_WORST_CASE_MS).toBeLessThan(DEADLINES.outerTimeoutMs(true));
  });

  it("covers both sequential legs at their WORST case, not at their timeout", () => {
    // A call is two SEQUENTIAL legs: the subject, then events and neighbours concurrently. The budget has
    // to cover 2 × what a probe can actually take, which is the KILL point and not the TERM point —
    // deriving it from the 8s cap left a 13s first leg with 7s for the second, and every neighbour was
    // then reported as a timeout it never reached. That is a fabricated diagnosis, not a slow one, and it
    // is the exact failure this derivation exists to rule out.
    expect(DEADLINES.TOTAL_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * DEADLINES.PROBE_WORST_CASE_MS);
  });

  it("uses the unpadded probe cap off the sandbox path, where it is the only deadline", () => {
    expect(DEADLINES.outerTimeoutMs(false)).toBe(DEADLINES.PROBE_TIMEOUT_MS);
  });
});

describe("collectObject — the size budget", () => {
  // The first version of this suite asserted a length on a deliberately noisy fixture, and passed with
  // the final clip removed: `renderNode` and `renderOwner` emit one line each, so no fixture built from
  // the real table could reach the ceiling. It was measuring the renderers' terseness, not the budget.
  //
  // The real risk is a FUTURE relation pushing the total over while every existing test still passes.
  // So the budget is checked as arithmetic over the table, which fails on exactly that change.
  it("holds every kind's worst case inside the total, computed from the table", () => {
    for (const [name, spec] of Object.entries(KINDS)) {
      expect(worstCaseChars(spec), `${name} (${spec.relations.length} relations)`)
        .toBeLessThanOrEqual(BUDGET.MAX_TOTAL_CHARS);
    }
  });

  it("budgets the header for the longest legal identity, since it is never clipped", async () => {
    // The header is deliberately unclipped — identity has to survive or a bundle stops being
    // attributable — so the budget must carry its WORST case. A namespace and a name may each be a full
    // DNS subdomain; the previous hand-picked 340 was the typical case, understating it by ~200 chars.
    const name = "n".repeat(BUDGET.MAX_DNS_NAME_CHARS);
    const namespace = "s".repeat(BUDGET.MAX_DNS_NAME_CHARS);
    const d = deps({ [`get pod ${name}`]: pod({ metadata: { name, namespace, uid: "u" } }), "get events": NO_EVENTS });
    const { text } = await collectObject({ ...KINDS.pod, relations: [] }, { kind: "pod", name, namespace }, d);
    const header = text.split("\n")[0];
    expect(header, "the identity is not truncated").toContain(name);
    expect(header).toContain(namespace);
    expect(header.length).toBeLessThanOrEqual(BUDGET.MAX_SUBJECT_HEADER_CHARS);
  });

  it("would fail if a kind grew relations without the budget being revisited", () => {
    // Pins the guard above as a guard: with enough relations the arithmetic must break, or it is
    // asserting nothing. The number here is whatever the current caps allow, not a target.
    const room = BUDGET.MAX_TOTAL_CHARS - worstCaseChars({ relations: [] });
    const tooMany = Math.floor(room / BUDGET.MAX_NEIGHBOUR_CHARS) + 1;
    expect(worstCaseChars({ relations: new Array(tooMany).fill(null) }))
      .toBeGreaterThan(BUDGET.MAX_TOTAL_CHARS);
  });

  // These next two guards OVERLAP, and the first version of them was worthless for exactly that
  // reason: with a 50k-char renderer and no relations, removing the subject cap still left the total
  // clip to catch it, and removing the total clip still left the subject cap. Each test passed on the
  // other's back. So each one now isolates its own guard — the subject cap is asserted on the SECTION,
  // and the total clip on a shape where no individual part is over its cap.
  it("caps the subject section itself, not merely the total", async () => {
    const spec = { ...KINDS.pod, render: () => "z".repeat(50_000), relations: [] };
    const d = deps({ "get pod web": pod(), "get events": NO_EVENTS });
    const { text } = await collectObject(spec, { kind: "pod", name: "web", namespace: "default" }, d);
    const subjectSection = text.split("\n\n")[1] ?? "";
    expect(subjectSection.length).toBeLessThanOrEqual(BUDGET.MAX_SUBJECT_CHARS);
  });

  it("clips the total when many in-budget parts add up past it", async () => {
    // Every section is inside its own cap here; only the sum is over. That is the state the final clip
    // exists for, and the state a growing relation table would produce.
    const many = Array.from({ length: 30 }, (_, i) => ({
      label: `rel${i}`,
      neighbour: { via: "name" as const, nameAt: ".spec.nodeName", kind: "node", scope: "cluster" as const },
      render: () => "n".repeat(BUDGET.MAX_NEIGHBOUR_CHARS),
    }));
    const spec = { ...KINDS.pod, relations: many };
    const d = deps({ "get pod web": pod(), "get node node-42": JSON.stringify(NODE), "get events": NO_EVENTS });
    const { text } = await collectObject(spec, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text.length).toBeLessThanOrEqual(BUDGET.MAX_TOTAL_CHARS);
    expect(text.trimEnd().split("\n").at(-1)).toBe("status: partial (output: truncated)");
    expect(text.split("\n").filter((line) => line.startsWith("status:"))).toHaveLength(1);
  });

  it("keeps the newest events and says how many there were", async () => {
    const events = eventList(Array.from({ length: 30 }, (_, i) => `Event${i}`));
    const d = deps({ "get pod web": pod(), "get node node-42": JSON.stringify(NODE), "get replicaset": JSON.stringify(RS), "get events": events });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).toContain("--- events (30, newest 6) ---");
    expect(text).toContain("Event29");
    expect(text).not.toContain("Event0 ");
  });

  it("sorts events by time when the apiserver returns them out of order", async () => {
    // The `eventList` helper emits ascending `metadata.creationTimestamp` — the LAST of five fallbacks —
    // so no other test in this file can fail if either the sorting or the fallback chain regresses. This
    // one carries the time ONLY in `eventTime`, in descending order, which is what a modern events.k8s.io
    // response looks like.
    const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
    const events = JSON.stringify({
      kind: "EventList",
      items: [7, 3, 9, 1].map((minute) => ({
        eventTime: at(minute), type: "Warning", reason: `At${minute}`,
        involvedObject: { kind: "Pod", name: "web" }, message: `minute ${minute}`,
      })),
    });
    const d = deps({
      "get pod web": pod(), "get node node-42": JSON.stringify(NODE),
      "get replicaset": JSON.stringify(RS), "get events": events,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    const order = [1, 3, 7, 9].map((m) => text.indexOf(`minute ${m}`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order, "oldest first, newest last").toEqual([...order].sort((a, b) => a - b));
  });

  it("takes a repeated event's latest activity, not the origin its eventTime holds", async () => {
    // The precedence `skills/core/cluster-events/references/` establishes for the v1 shape that
    // `kubectl get events` returns. A v1 event converted from events.k8s.io can carry the ORIGIN in
    // eventTime and the latest activity in lastTimestamp, so reading eventTime first sorts a currently
    // firing event to a month ago and drops it out of the newest window. Live shape: a count=177309
    // BackOff whose lastTimestamp was minutes old and firstTimestamp a month earlier.
    const events = JSON.stringify({
      kind: "EventList",
      items: [
        {
          eventTime: "2026-07-27T10:50:45Z", lastTimestamp: "2026-08-24T09:05:43Z",
          firstTimestamp: "2026-07-27T10:50:45Z", count: 177309,
          type: "Normal", reason: "BackOff", involvedObject: { kind: "Pod", name: "web" },
          message: "still firing",
        },
        {
          lastTimestamp: "2026-08-01T00:00:00Z", type: "Normal", reason: "Pulled",
          involvedObject: { kind: "Pod", name: "web" }, message: "older but after the origin",
        },
      ],
    });
    const d = deps({
      "get pod web": pod(), "get node node-42": JSON.stringify(NODE),
      "get replicaset": JSON.stringify(RS), "get events": events,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text.indexOf("still firing")).toBeGreaterThan(text.indexOf("older but after the origin"));
    // The rendered time is the latest activity too, not the origin the model would then reason from.
    expect(text).toContain("2026-08-24T09:05:43Z");
  });

  it("still prefers a series' own last-observed time over the frozen flat field", async () => {
    // A series event's lastTimestamp stays at first write, so lastTimestamp must not outrank series.
    const events = JSON.stringify({
      kind: "EventList",
      items: [{
        series: { count: 9, lastObservedTime: "2026-08-24T09:00:00Z" },
        lastTimestamp: "2026-01-01T00:00:00Z",
        type: "Warning", reason: "Unhealthy", involvedObject: { kind: "Pod", name: "web" },
        message: "series event",
      }],
    });
    const d = deps({
      "get pod web": pod(), "get node node-42": JSON.stringify(NODE),
      "get replicaset": JSON.stringify(RS), "get events": events,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).toContain("2026-08-24T09:00:00Z");
    expect(text).not.toContain("2026-01-01");
  });

  it("keeps a realistic long FailedScheduling reason instead of clipping it at 160 characters", async () => {
    const reason = "0/100 nodes are available: "
      + "10 Insufficient cpu, 20 Insufficient memory, 30 had untolerated taint, "
      + "40 did not match Pod node affinity/selector; preemption is not helpful for scheduling TAIL";
    const events = eventList([reason]);
    const d = deps({
      "get pod web": pod(),
      "get node node-42": JSON.stringify(NODE),
      "get replicaset": JSON.stringify(RS),
      "get events": events,
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).toContain("TAIL");
  });

  it("states an empty events list, and says retention could explain it", async () => {
    // An omitted section reads as "not looked at", so the zero is stated. But zero events does NOT mean
    // none were emitted — Events expire on a TTL, and a pod Pending for longer than the retention
    // window has none precisely BECAUSE its diagnosis is old. Naming only the first reading is what led
    // the pod-pending skill to conclude "the scheduler never spoke" from the opposite evidence.
    const d = deps({ "get pod web": pod(), "get node node-42": JSON.stringify(NODE), "get replicaset": JSON.stringify(RS), "get events": NO_EVENTS });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).toContain("--- events (0");
    expect(text).toMatch(/events \(0[^)]*(retained|TTL|expire)/);
  });

  it("does not turn an unparseable event response into a genuine empty list", async () => {
    const d = deps({
      "get pod web": pod(),
      "get node node-42": JSON.stringify(NODE),
      "get replicaset": JSON.stringify(RS),
      "get events": "not an EventList",
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).not.toContain("--- events (0) ---");
    expect(text.trimEnd().split("\n").at(-1)).toBe("status: partial (events: unparseable)");
  });

  it("redacts an event message before promoting it into the summary", async () => {
    const d = deps({
      "get pod web": pod(),
      "get node node-42": JSON.stringify(NODE),
      "get replicaset": JSON.stringify(RS),
      "get events": eventList(["DB_PASSWORD=hunter2"]),
    });
    const { text } = await collectObject(KINDS.pod, { kind: "pod", name: "web", namespace: "default" }, d);
    expect(text).not.toContain("hunter2");
    expect(text).toContain("REDACTED");
  });
});
