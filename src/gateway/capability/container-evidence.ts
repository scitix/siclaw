import * as k8s from "@kubernetes/client-node";
import { createHash } from "node:crypto";

interface PendingObservation {
  observation: ContainerObservation;
  declined: boolean;
  declinedRetries: number;
  replay: boolean;
}

// A false receipt can mean either a foreign run or a legacy run awaiting claim.
// Allow three reconnect/reconcile opportunities without retaining it forever.
const MAX_DECLINED_REPLAYS = 3;

export interface ContainerTermination {
  reason: string;
  exit_code: number;
  signal: number;
  started_at?: string;
  finished_at?: string;
}

export interface ContainerObservation {
  run_id: string;
  profile: string;
  source: "observed" | "deleted" | "stopping";
  namespace: string;
  pod_name: string;
  pod_uid: string;
  node_name?: string;
  phase: string;
  reason?: string;
  deletion_timestamp?: string;
  containers: Array<{
    name: string;
    role: "container" | "init" | "ephemeral";
    image: string;
    image_id?: string;
    restart_count: number;
    state: "waiting" | "running" | "terminated" | "unknown";
    waiting_reason?: string;
    termination?: ContainerTermination;
    last_termination?: ContainerTermination;
  }>;
}

function timestamp(value: Date | undefined): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function termination(value: k8s.V1ContainerStateTerminated | undefined): ContainerTermination | undefined {
  return value ? {
    reason: value.reason ?? "", exit_code: value.exitCode, signal: value.signal ?? 0,
    started_at: timestamp(value.startedAt), finished_at: timestamp(value.finishedAt),
  } : undefined;
}

/** Project status only. Never retain PodSpec env/args, annotations or messages. */
export function containerObservation(pod: k8s.V1Pod, source: ContainerObservation["source"], prefix: string): ContainerObservation | undefined {
  const profile = pod.metadata?.labels?.[`${prefix}/boxType`];
  const runId = pod.metadata?.labels?.[`${prefix}/agent`];
  if (!profile?.startsWith("kb-") || !runId || !pod.metadata?.uid || !pod.metadata.name || !pod.metadata.namespace) return;
  const groups = [
    { role: "container" as const, specs: pod.spec?.containers, statuses: pod.status?.containerStatuses },
    { role: "init" as const, specs: pod.spec?.initContainers, statuses: pod.status?.initContainerStatuses },
    { role: "ephemeral" as const, specs: pod.spec?.ephemeralContainers, statuses: pod.status?.ephemeralContainerStatuses },
  ];
  return {
    run_id: runId, profile, source, namespace: pod.metadata.namespace,
    pod_name: pod.metadata.name, pod_uid: pod.metadata.uid, node_name: pod.spec?.nodeName,
    phase: pod.status?.phase ?? "Unknown", reason: pod.status?.reason,
    deletion_timestamp: timestamp(pod.metadata.deletionTimestamp),
    containers: groups.flatMap(({ role, specs, statuses }) => (specs ?? []).map((spec) => {
      const status = statuses?.find((s) => s.name === spec.name);
      return {
        name: spec.name, role, image: spec.image ?? "", image_id: status?.imageID,
        restart_count: status?.restartCount ?? 0,
        state: status?.state?.terminated ? "terminated" as const : status?.state?.waiting ? "waiting" as const : status?.state?.running ? "running" as const : "unknown" as const,
        waiting_reason: status?.state?.waiting?.reason,
        termination: termination(status?.state?.terminated), last_termination: termination(status?.lastState?.terminated),
      };
    })),
  };
}

/** A bounded queue keeps a watch burst from creating unbounded pending RPCs. */
export class ContainerEvidenceQueue {
  private pending = new Map<string, PendingObservation>();
  private failed = new Map<string, PendingObservation>();
  private acknowledged = new Map<string, true>();
  private draining?: Promise<void>;
  private closed = false;
  private inFlight?: string;

  constructor(private readonly send: (observation: ContainerObservation) => Promise<unknown>) {}

  record(observation: ContainerObservation): void {
    if (this.closed) return;
    const key = createHash("sha256").update(JSON.stringify(observation)).digest("hex");
    if (this.acknowledged.has(key) || this.pending.has(key) || this.inFlight === key) return;
    const previous = this.failed.get(key);
    if (!previous) console.info("[capability-container]", JSON.stringify(observation));
    this.failed.delete(key);
    this.enqueue(key, { observation, declined: previous?.declined ?? false,
      declinedRetries: previous?.declinedRetries ?? 0, replay: false });
  }

  private enqueue(key: string, entry: PendingObservation) {
    if (this.closed || this.acknowledged.has(key) || this.pending.has(key) || this.inFlight === key) return;
    if (this.pending.size >= 256) {
      // Old replay traffic must not displace newly observed exit evidence.
      if (entry.replay) {
        this.retainForReconnect(key, entry);
        return;
      }
      // This is evidence loss, not a successful observation. Keep a log that
      // central logging can retain even while the consumer store is overloaded.
      const oldest = [...this.pending].find(([, value]) => value.declined)?.[0] ?? this.pending.keys().next().value!;
      console.error("[capability-container] queue full; evicting oldest snapshot", this.pending.get(oldest)!.observation.run_id);
      this.pending.delete(oldest);
    }
    this.pending.set(key, entry);
    this.pump();
  }

  private pump() {
    if (this.closed || this.draining || this.pending.size === 0) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      // A reconnect may enqueue between drain completion and this microtask.
      this.pump();
    });
  }

  private async drain() {
    while (this.pending.size > 0) {
      const [key, entry] = this.pending.entries().next().value!;
      const { observation } = entry;
      this.pending.delete(key);
      this.inFlight = key;
      try {
        const result = await this.send(observation);
        const observed = (result as { observed?: boolean } | null)?.observed;
        if (observed === true) this.acknowledged.set(key, true);
        else {
          entry.declined = observed === false;
          // A watch burst is not three recovery opportunities. Only explicit
          // declines after reconnect/reconcile consume this snapshot's budget.
          if (entry.declined && entry.replay) entry.declinedRetries++;
          if (entry.declinedRetries >= MAX_DECLINED_REPLAYS) {
            console.error("[capability-container] receiver declined replay budget; retained in logs", observation.run_id);
          } else this.retainForReconnect(key, entry);
        }
        if (this.acknowledged.size > 1024) this.acknowledged.delete(this.acknowledged.keys().next().value!);
      } catch (error) {
        // Diagnostic transport is a top-level boundary, independent of running
        // work. Failed observations are not deduplicated on a later relist.
        // Transport errors do not consume the explicit-decline budget.
        entry.declined = false;
        this.retainForReconnect(key, entry);
        console.error("[capability-container] persistence failed", observation.run_id, error);
      } finally {
        this.inFlight = undefined;
      }
    }
  }

  private retainForReconnect(key: string, entry: PendingObservation) {
    if (this.closed) return;
    if (!this.failed.has(key) && this.failed.size >= 256) {
      const declined = [...this.failed].find(([, value]) => value.declined)?.[0];
      console.error("[capability-container] reconnect backlog full", entry.observation.run_id);
      // Namespace-wide foreign receipts must not evict transport-failed work.
      if (entry.declined && !declined) return;
      this.failed.delete(declined ?? this.failed.keys().next().value!);
    }
    this.failed.set(key, entry);
  }

  retry() {
    const snapshots = [...this.failed].sort((a, b) => Number(a[1].declined) - Number(b[1].declined));
    this.failed.clear();
    for (const [key, entry] of snapshots) this.enqueue(key, { ...entry, replay: true });
  }

  async close() {
    this.closed = true;
    // Each queued snapshot was already logged. Shutdown waits only for the
    // active RPC (the transport imposes a 3s deadline), never the whole backlog.
    if (this.pending.size) console.error("[capability-container] shutdown dropped pending persistence", this.pending.size);
    this.pending.clear();
    this.failed.clear();
    await this.draining;
  }
}

export function observeContainerLifecycle(kc: k8s.KubeConfig, api: k8s.CoreV1Api, namespace: string, prefix: string,
  send: (observation: ContainerObservation) => Promise<unknown>) {
  const selector = `${prefix}/app=agentbox,${prefix}/boxType in (kb-compile,kb-compile-codex,kb-compile-pi,kb-test)`;
  const informer = k8s.makeInformer<k8s.V1Pod>(kc, `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods`,
    () => api.listNamespacedPod({ namespace, labelSelector: selector }), selector);
  const queue = new ContainerEvidenceQueue(send);
  let closed = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  const record = (pod: k8s.V1Pod, source: ContainerObservation["source"]) => {
    const observation = containerObservation(pod, source, prefix);
    if (observation) queue.record(observation);
  };
  informer.on("add", (pod) => { void record(pod, "observed"); });
  informer.on("update", (pod) => { void record(pod, "observed"); });
  informer.on("delete", (pod) => { void record(pod, "deleted"); });
  const onError = (error: unknown) => {
    console.error("[capability-container] Kubernetes watch interrupted", error);
    if (!closed && !reconnect) {
      // Kubernetes watches disconnect/expire; the informer resumes its
      // resource version and relists after expiration.
      reconnect = setTimeout(() => { reconnect = undefined; if (!closed) void informer.start().catch(onError); }, 5_000);
      reconnect.unref();
    }
  };
  informer.on("error", onError);
  void informer.start().catch(onError);
  return {
    retry: () => queue.retry(),
    beforeStop: (podName: string) => {
      const pod = informer.get(podName, namespace);
      if (pod) record(pod, "stopping");
    },
    stop: async () => {
      closed = true;
      clearTimeout(reconnect);
      await informer.stop();
      await queue.close();
    },
  };
}
