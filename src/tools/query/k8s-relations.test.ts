/**
 * The pure half: the relation table and its renderers. No cluster, no exec.
 *
 * What these are guarding is mostly the difference between "absent" and "zero", because that
 * distinction is the whole value of a summary — a fabricated `0 ready` reads as a diagnosis.
 */
import { describe, it, expect } from "vitest";
import {
  KINDS, KNOWN_KINDS, resolveKind,
  renderPod, renderPodContainers, renderNode, renderOwner, renderPodDistribution,
  safeText, str, all, one,
} from "./k8s-relations.js";

describe("path reading", () => {
  const doc = { a: { b: "x", n: 3, t: true, empty: "", nil: null }, list: [{ k: 1 }, { k: 2 }] };

  it("reads scalars, coercing numbers and booleans to strings", () => {
    expect(str(doc, ".a.b")).toBe("x");
    expect(str(doc, ".a.n")).toBe("3");
    expect(str(doc, ".a.t")).toBe("true");
  });

  it("collapses absent, null and empty-string to undefined — they mean the same thing to a reader", () => {
    expect(str(doc, ".a.missing")).toBeUndefined();
    expect(str(doc, ".a.nil")).toBeUndefined();
    expect(str(doc, ".a.empty")).toBeUndefined();
  });

  it("distinguishes false from absent, which str() cannot", () => {
    expect(one({ x: false }, ".x")).toBe(false);
    expect(one({ x: false }, ".y")).toBeUndefined();
  });

  it("maps over an array and drops nulls", () => {
    expect(all(doc, ".list[]")).toHaveLength(2);
    expect(all({ items: [1, null, 2] }, ".items[]")).toEqual([1, 2]);
  });
});

describe("safeText — a promoted free-text field", () => {
  // The motivating measurement: the structural pod sanitizer redacts env values by SHAPE, so a
  // credential inside a death message reaches this renderer intact and the text redactor is what
  // stands between it and a summary line the model will actually read.
  it("redacts a message that is a KEY=secret line", () => {
    expect(safeText("DB_PASSWORD=hunter2")).not.toContain("hunter2");
  });

  it("redacts a PEM block, across the lines it spans", () => {
    const out = safeText("-----BEGIN RSA PRIVATE KEY-----\nMIIEvQIBADAN\n-----END RSA PRIVATE KEY-----")!;
    expect(out).not.toContain("MIIEvQIBADAN");
  });

  it("redacts a connection string carrying its own password", () => {
    expect(safeText("connect failed: postgres://user:hunter2@db:5432/app")).not.toContain("hunter2");
  });

  it("leaves an ordinary diagnosis alone — a redactor that eats OOMKilled is worse than none", () => {
    expect(safeText("OOMKilled")).toBe("OOMKilled");
    expect(safeText("container failed to start: exec format error"))
      .toBe("container failed to start: exec format error");
  });

  // KNOWN GAP, asserted so it reads as a decision rather than as coverage. `KV_LINE_RE` anchors the
  // key at the start of a line, so a secret embedded mid-sentence is not matched by any redactor in
  // the tree. Not introduced here: the same message already reaches the model verbatim through the
  // `kubectl get pod -o json` this call replaces. If a scan-anywhere redactor ever lands in the
  // sanitization layer, this test flips and should be rewritten as the positive assertion.
  it("does NOT catch a secret embedded mid-sentence (pre-existing, layer-wide)", () => {
    expect(safeText("boom DB_PASSWORD=hunter2 bye")).toContain("hunter2");
  });

  it("flattens newlines so a stack trace cannot break the layout", () => {
    expect(safeText("line one\nline two\n\tindented")).toBe("line one line two indented");
  });

  it("clips a long message and says so", () => {
    const out = safeText("x".repeat(500))!;
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns undefined for absent and whitespace-only input, so callers omit the field", () => {
    expect(safeText(undefined)).toBeUndefined();
    expect(safeText("   \n ")).toBeUndefined();
  });
});

describe("renderPodContainers", () => {
  it("reports a pod with no container statuses as not started, not as healthy", () => {
    // A Pending pod that never scheduled has no statuses at all. Rendering nothing would read as
    // "nothing wrong with the containers".
    const out = renderPodContainers({ status: {} });
    expect(out).toContain("none started yet");
  });

  it("names the last termination reason and exit code — what CrashLoopBackOff never tells you", () => {
    const out = renderPodContainers({
      status: { containerStatuses: [{
        name: "app", ready: false, restartCount: 7,
        lastState: { terminated: { reason: "OOMKilled", exitCode: 137 } },
      }] },
    });
    expect(out).toContain("app");
    expect(out).toContain("not ready");
    expect(out).toContain("7 restarts");
    expect(out).toContain("OOMKilled");
    expect(out).toContain("exit 137");
  });

  it("omits the restart count when there have been none", () => {
    const out = renderPodContainers({ status: { containerStatuses: [{ name: "app", ready: true, restartCount: 0 }] } });
    expect(out).toContain("ready");
    expect(out).not.toContain("restart");
  });

  it("singularises one restart", () => {
    const out = renderPodContainers({ status: { containerStatuses: [{ name: "a", ready: true, restartCount: 1 }] } });
    expect(out).toContain("1 restart");
    expect(out).not.toContain("1 restarts");
  });

  it("surfaces a waiting reason and the image, which together are the answer for ImagePullBackOff", () => {
    const out = renderPodContainers({
      status: { containerStatuses: [{
        name: "app", ready: false, restartCount: 0, image: "registry.example.com/app:v1",
        state: { waiting: { reason: "ImagePullBackOff", message: "manifest unknown" } },
      }] },
    });
    expect(out).toContain("ImagePullBackOff");
    expect(out).toContain("manifest unknown");
    expect(out).toContain("registry.example.com/app:v1");
  });

  it("omits the image for a running container, where it is noise", () => {
    // This summary pays for every field it prints; the image only earns its line when the question is
    // which registry or tag was contacted.
    const out = renderPodContainers({
      status: { containerStatuses: [{ name: "app", ready: true, restartCount: 0, image: "nginx:latest" }] },
    });
    expect(out).not.toContain("nginx:latest");
  });

  it("routes a promoted message through the redactor, keeping the reason", () => {
    const out = renderPodContainers({
      status: { containerStatuses: [{
        name: "app", ready: false, restartCount: 1,
        lastState: { terminated: { reason: "Error", exitCode: 1, message: "DB_PASSWORD=hunter2" } },
      }] },
    });
    // The diagnosis survives, the credential does not. Reverting safeText() to a bare pass-through
    // fails on the second assertion.
    expect(out).toContain("Error");
    expect(out).toContain("exit 1");
    expect(out).not.toContain("hunter2");
  });
});

describe("renderPod", () => {
  it("reports the phase and the Ready condition's reason when it is not True", () => {
    const out = renderPod({
      status: {
        phase: "Running",
        conditions: [{ type: "Ready", status: "False", reason: "ContainersNotReady" }],
        containerStatuses: [{ name: "app", ready: false, restartCount: 0 }],
      },
    });
    expect(out).toContain("Running");
    expect(out).toContain("Ready=False");
    expect(out).toContain("ContainersNotReady");
  });

  it("does not attach a reason to a healthy Ready condition", () => {
    const out = renderPod({ status: { phase: "Running", conditions: [{ type: "Ready", status: "True", reason: "whatever" }] } });
    expect(out).toContain("Ready=True");
    expect(out).not.toContain("whatever");
  });

  it("says phase unknown rather than inventing one", () => {
    expect(renderPod({})).toContain("unknown");
  });

  it("shows a deleting pod's timestamp and the finalizers holding it", () => {
    // A pod stuck Terminating still reports phase Running, so these two fields are the only ones that
    // answer the question — and the difference between "a finalizer is holding it" and "nothing is"
    // points at completely different causes.
    const out = renderPod({
      metadata: {
        deletionTimestamp: "2026-08-24T10:00:00Z",
        deletionGracePeriodSeconds: 30,
        uid: "4758c8e1-52f9-47e0-bc3c-4f9445314bb9",
        finalizers: ["kubernetes.io/pvc-protection"],
      },
      status: { phase: "Running" },
    });
    expect(out).toContain("2026-08-24T10:00:00Z");
    expect(out).toContain("grace 30s");
    expect(out).toContain("kubernetes.io/pvc-protection");
    // The correlation key for the node's containerd / kubelet logs, which is the next step.
    expect(out).toContain("4758c8e1-52f9-47e0-bc3c-4f9445314bb9");
  });

  it("keeps a zero grace period, which means the delete was forced", () => {
    const out = renderPod({
      metadata: { deletionTimestamp: "2026-08-24T10:00:00Z", deletionGracePeriodSeconds: 0 },
      status: { phase: "Running" },
    });
    expect(out).toContain("grace 0s");
  });

  it("distinguishes a deleting pod with no finalizers from one with them", () => {
    const out = renderPod({ metadata: { deletionTimestamp: "2026-08-24T10:00:00Z" }, status: { phase: "Running" } });
    expect(out).toContain("no finalizers");
  });

  it("says nothing about deletion for a pod that is not deleting", () => {
    expect(renderPod({ metadata: {}, status: { phase: "Running" } })).not.toContain("deleting");
  });

  it("carries the kubelet's own words for an eviction", () => {
    const out = renderPod({ status: { phase: "Failed", reason: "Evicted", message: "node was low on ephemeral-storage" } });
    expect(out).toContain("Evicted");
    expect(out).toContain("ephemeral-storage");
  });
});

describe("renderNode", () => {
  it("reports Ready plus only the pressure conditions that are asserting", () => {
    const out = renderNode({
      status: {
        conditions: [
          { type: "Ready", status: "True" },
          { type: "MemoryPressure", status: "False" },
          { type: "DiskPressure", status: "True" },
        ],
      },
    });
    expect(out).toContain("Ready=True");
    expect(out).toContain("DiskPressure=True");
    // MemoryPressure=False is the normal state of every healthy node; printing it would crowd out
    // the line that matters.
    expect(out).not.toContain("MemoryPressure");
  });

  it("gives an abnormal condition its reason AND its transition time", () => {
    // A bare `DiskPressure=True` sends the reader to `describe node` anyway, so the summary saves
    // nothing. `since` is the sharper half: NotReady four minutes ago and NotReady for a week call
    // for different investigations.
    const out = renderNode({
      status: {
        conditions: [
          { type: "Ready", status: "False", reason: "KubeletNotReady", lastTransitionTime: "2026-08-24T09:55:00Z" },
          { type: "DiskPressure", status: "True", reason: "KubeletHasDiskPressure", lastTransitionTime: "2026-08-24T09:50:00Z" },
        ],
      },
    });
    expect(out).toContain("Ready=False (KubeletNotReady) since 2026-08-24T09:55:00Z");
    expect(out).toContain("DiskPressure=True (KubeletHasDiskPressure) since 2026-08-24T09:50:00Z");
  });

  it("falls back to the condition message when there is no reason", () => {
    const out = renderNode({
      status: { conditions: [{ type: "Ready", status: "Unknown", message: "kubelet stopped posting node status" }] },
    });
    expect(out).toContain("kubelet stopped posting");
  });

  it("does not timestamp a healthy condition", () => {
    const out = renderNode({
      status: { conditions: [{ type: "Ready", status: "True", lastTransitionTime: "2026-01-01T00:00:00Z" }] },
    });
    expect(out).toContain("Ready=True");
    expect(out).not.toContain("2026-01-01");
  });

  it("names taints with their effect, since the effect is why a pod is Pending", () => {
    const out = renderNode({ spec: { taints: [{ key: "gpu", effect: "NoSchedule" }] }, status: {} });
    expect(out).toContain("gpu:NoSchedule");
  });

  it("states explicitly that there are no taints", () => {
    expect(renderNode({ spec: {}, status: {} })).toContain("no taints");
  });

  it("reports a cordoned node", () => {
    expect(renderNode({ spec: { unschedulable: true }, status: {} })).toContain("cordoned");
  });

  it("includes allocatable capacity when present", () => {
    const out = renderNode({ spec: {}, status: { allocatable: { cpu: "64", memory: "512Gi" } } });
    expect(out).toContain("cpu 64");
    expect(out).toContain("mem 512Gi");
  });
});

describe("renderOwner", () => {
  it("reports desired and ready counts under the owner's kind", () => {
    const out = renderOwner({ kind: "ReplicaSet", spec: { replicas: 3 }, status: { readyReplicas: 2 } });
    expect(out).toContain("ReplicaSet");
    expect(out).toContain("desired 3");
    expect(out).toContain("ready 2");
  });

  it("omits a count that is absent rather than printing zero", () => {
    // `ready 0` when the field is simply missing is a fabricated answer, and for a controller that
    // has not reported yet it is the opposite of the truth.
    const out = renderOwner({ kind: "Job", spec: { parallelism: 4 }, status: {} });
    expect(out).toContain("desired 4");
    expect(out).not.toContain("ready");
  });

  it("keeps a genuine zero", () => {
    expect(renderOwner({ kind: "ReplicaSet", spec: { replicas: 3 }, status: { readyReplicas: 0 } })).toContain("ready 0");
  });

  it("says so when a controller reports no counts at all", () => {
    expect(renderOwner({ kind: "CronJob" })).toContain("no counts");
  });
});

describe("renderPodDistribution", () => {
  it("folds pods to phase counts, commonest first", () => {
    const out = renderPodDistribution({ items: [
      { status: { phase: "Running" } }, { status: { phase: "Running" } }, { status: { phase: "Pending" } },
    ] });
    expect(out).toContain("3 total");
    expect(out).toMatch(/Running 2.*Pending 1/);
  });

  it("counts a pod with no phase as Unknown rather than dropping it", () => {
    expect(renderPodDistribution({ items: [{}] })).toContain("Unknown 1");
  });

  it("states an empty node explicitly", () => {
    expect(renderPodDistribution({ items: [] })).toContain("none scheduled");
  });
});

describe("the table", () => {
  it("accepts singular, plural and kubectl short forms, because that is what the prose produces", () => {
    for (const spelling of ["pod", "pods", "po", "Pod", " POD "]) {
      expect(resolveKind(spelling), spelling).toBe(KINDS.pod);
    }
    for (const spelling of ["node", "nodes", "no"]) {
      expect(resolveKind(spelling), spelling).toBe(KINDS.node);
    }
  });

  it("returns undefined for a kind it does not cover, so the caller can say so", () => {
    expect(resolveKind("deployment")).toBeUndefined();
    expect(resolveKind("")).toBeUndefined();
  });

  it("advertises exactly the kinds in the table", () => {
    expect(KNOWN_KINDS.sort()).toEqual(Object.keys(KINDS).sort());
  });

  it("gives a node's pod query an exact single-value field selector", () => {
    // Anything looser is refused by the all-namespaces restriction (hasBoundingFieldSelector), so this
    // is not a style preference — a comma set or a != would make the relation unusable.
    const rel = KINDS.node.relations.find((r) => r.label === "pods")!;
    expect(rel.neighbour.via).toBe("list");
    const selector = rel.neighbour.via === "list" ? rel.neighbour.selector("node-42") : "";
    expect(selector).toBe("spec.nodeName==node-42");
    expect(selector).not.toContain(",");
    expect(selector).not.toContain("!=");
  });

  it("reads a pod owner's KIND from the object rather than assuming one", () => {
    // A pod's controller is a ReplicaSet, a Job, a StatefulSet or a CRD. Fixing the kind here would
    // silently skip every case but one.
    const rel = KINDS.pod.relations.find((r) => r.label === "owner")!;
    expect(rel.neighbour.via).toBe("name");
    expect(typeof rel.neighbour.kind === "object").toBe(true);
  });
});
