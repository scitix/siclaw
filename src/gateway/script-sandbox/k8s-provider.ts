import WebSocket from "ws";
import { WebSocketHandler } from "@kubernetes/client-node/dist/web-socket-handler.js";
import * as k8s from "@kubernetes/client-node";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { scriptRunnerUid } from "../../script-sandbox/identity.js";
import { SandboxToolError } from "../../script-sandbox/errors.js";
import type { ScriptChannel, ScriptSandboxConfig, ScriptSandboxProvider } from "../../script-sandbox/types.js";

export function scriptJob(runId: string, isolated: boolean, seconds: number, config: ScriptSandboxConfig): k8s.V1Job {
  const uid = scriptRunnerUid(`siclaw-script-${runId}`);
  return {
    apiVersion: "batch/v1", kind: "Job",
    metadata: { name: `siclaw-script-${runId}`, namespace: config.namespace, labels: { "siclaw.io/component": "script-runner" } },
    spec: {
      backoffLimit: 0, activeDeadlineSeconds: seconds + 90, ttlSecondsAfterFinished: 60,
      template: {
        metadata: { labels: { "siclaw.io/component": "script-runner" } },
        spec: {
          restartPolicy: "Never", terminationGracePeriodSeconds: 0, serviceAccountName: config.serviceAccount,
          automountServiceAccountToken: false, enableServiceLinks: false,
          hostNetwork: false, hostPID: false, hostIPC: false, shareProcessNamespace: false,
          ...(config.runtimeClass ? { runtimeClassName: config.runtimeClass } : {}),
          securityContext: { runAsNonRoot: true, runAsUser: uid, runAsGroup: uid, fsGroup: uid },
          containers: [{
            name: "runner", image: config.image, imagePullPolicy: "IfNotPresent", stdin: true, tty: false,
            command: ["/usr/local/bin/siclaw-launcher"],
            args: [isolated ? "isolated" : "standard", "/usr/local/bin/python3", "-I", "-B", "-u", "/opt/siclaw/runner.py", String(seconds + 90)],
            workingDir: "/work",
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } },
            resources: { requests: { cpu: "20m", memory: "64Mi" }, limits: { cpu: "1", memory: "256Mi", "ephemeral-storage": "128Mi" } },
            volumeMounts: [{ name: "work", mountPath: "/work" }, { name: "tmp", mountPath: "/tmp" }],
          }],
          volumes: [{ name: "work", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } }, { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "32Mi" } }],
        },
      },
    },
  };
}

function apiOptions(signal?: AbortSignal): k8s.ConfigurationOptions {
  return { middleware: k8s.createConfiguration({ promiseMiddleware: [{
    pre: async context => { context.setSignal(signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000)); return context; },
    post: async context => context,
  }] }).middleware };
}

export function validateRunnerPod(pod: k8s.V1Pod, config: ScriptSandboxConfig, isolated: boolean, expectedUid: number, lifetimeSeconds: number): void {
  const spec = pod.spec;
  const c = spec?.containers?.[0];
  if (!spec || !c || spec.containers.length !== 1 || spec.initContainers?.length || spec.ephemeralContainers?.length ||
    spec.hostNetwork || spec.hostPID || spec.hostIPC || spec.shareProcessNamespace || spec.automountServiceAccountToken !== false ||
    spec.enableServiceLinks !== false || spec.restartPolicy !== "Never" || c.stdin !== true || c.tty ||
    spec.terminationGracePeriodSeconds !== 0 || spec.serviceAccountName !== config.serviceAccount || c.name !== "runner" || c.image !== config.image || c.env?.length || c.envFrom?.length ||
    JSON.stringify(c.command) !== JSON.stringify(["/usr/local/bin/siclaw-launcher"]) ||
    JSON.stringify(c.args?.slice(0, 6)) !== JSON.stringify([isolated ? "isolated" : "standard", "/usr/local/bin/python3", "-I", "-B", "-u", "/opt/siclaw/runner.py"]) ||
    c.args?.length !== 7 || c.args[6] !== String(lifetimeSeconds) || c.workingDir !== "/work" ||
    c.securityContext?.seccompProfile?.type !== "RuntimeDefault" || c.volumeDevices?.length || c.lifecycle || c.readinessProbe || c.livenessProbe || c.startupProbe ||
    c.securityContext?.procMount && c.securityContext.procMount !== "Default" ||
    c.securityContext?.runAsUser !== undefined && c.securityContext.runAsUser !== expectedUid ||
    c.securityContext?.runAsGroup !== undefined && c.securityContext.runAsGroup !== expectedUid ||
    c.securityContext?.runAsNonRoot === false || spec.runtimeClassName !== config.runtimeClass ||
    c.securityContext?.privileged || c.securityContext?.allowPrivilegeEscalation !== false || c.securityContext?.readOnlyRootFilesystem !== true ||
    c.securityContext?.capabilities?.add?.length || !c.securityContext?.capabilities?.drop?.includes("ALL") ||
    spec.securityContext?.runAsUser !== expectedUid || spec.securityContext?.runAsGroup !== expectedUid ||
    spec.securityContext?.fsGroup !== expectedUid || spec.securityContext?.supplementalGroups?.length || spec.securityContext?.sysctls?.length || spec.securityContext?.runAsNonRoot !== true ||
    c.resources?.limits?.cpu !== "1" || c.resources?.limits?.memory !== "256Mi" || c.resources?.limits?.["ephemeral-storage"] !== "128Mi" ||
    spec.volumes?.length !== 2 || spec.volumes.some(v => !v.emptyDir || Object.keys(v).some(k => k !== "name" && k !== "emptyDir")) ||
    !spec.volumes.some(v => v.name === "work" && v.emptyDir?.medium === "Memory" && v.emptyDir.sizeLimit === "64Mi") ||
    !spec.volumes.some(v => v.name === "tmp" && v.emptyDir?.medium === "Memory" && v.emptyDir.sizeLimit === "32Mi") ||
    c.volumeMounts?.length !== 2 || !c.volumeMounts.some(v => v.name === "work" && v.mountPath === "/work") ||
    !c.volumeMounts.some(v => v.name === "tmp" && v.mountPath === "/tmp") ||
    c.volumeMounts.some(v => v.subPath || v.subPathExpr || v.mountPropagation && v.mountPropagation !== "None")) {
    throw new Error("Runner admission changed the isolation boundary");
  }
}

export class K8sScriptSandboxProvider implements ScriptSandboxProvider {
  private owned = new Map<string, () => Promise<void>>();
  private pendingCleanup = new Set<string>();
  private stopped = false;
  private core: k8s.CoreV1Api;
  private batch: k8s.BatchV1Api;
  private kubeConfig: k8s.KubeConfig;

  constructor(private readonly config: ScriptSandboxConfig, kubeConfig?: k8s.KubeConfig) {
    const kc = kubeConfig ?? new k8s.KubeConfig();
    if (!kubeConfig) kc.loadFromDefault();
    this.core = kc.makeApiClient(k8s.CoreV1Api);
    this.batch = kc.makeApiClient(k8s.BatchV1Api);
    this.kubeConfig = kc;
  }

  async start(runId: string, isolated: boolean, seconds: number, signal: AbortSignal): Promise<ScriptChannel> {
    await Promise.allSettled([...this.pendingCleanup].map(id => this.owned.get(id)?.()));
    if (this.stopped) throw new SandboxToolError("SERVICE_UNAVAILABLE");
    if (this.owned.size >= this.config.maxConcurrentRuns + this.config.warmPoolSize) throw new SandboxToolError("RUNNER_CAPACITY");
    const job = scriptJob(runId, isolated, seconds, this.config);
    const name = job.metadata!.name!;
    const namespace = this.config.namespace;
    if (this.owned.has(name)) throw new SandboxToolError("RUNNER_CAPACITY");
    let socket: Awaited<ReturnType<k8s.Attach["attach"]>> | undefined;
    let attempted = false;
    let jobUid: string | undefined;
    let created!: () => void;
    const creationSettled = new Promise<void>(resolve => { created = resolve; });
    let closing: Promise<void> | undefined;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    const missing = (error: unknown) => (error as { code?: number })?.code === 404;
    const remove = async () => {
      await creationSettled;
      socket?.terminate();
      stdin.destroy(); stdout.destroy(); stderr.destroy();
      if (!attempted) { this.owned.delete(name); this.pendingCleanup.delete(name); return; }
      const cleanupSignal = AbortSignal.timeout(10_000);
      try {
        if (!jobUid) {
          // CREATE may have committed even when its reply never reached Runtime.
          // Recover only this unpredictable invocation name, then fence deletion by UID.
          const existing = await this.batch.readNamespacedJob({ name, namespace }, apiOptions(cleanupSignal));
          if (existing.metadata?.labels?.["siclaw.io/component"] !== "script-runner" || !existing.metadata.uid) throw new Error("Unknown Job ownership");
          jobUid = existing.metadata.uid;
        }
        await this.batch.deleteNamespacedJob({ name, namespace, body: { propagationPolicy: "Foreground", preconditions: { uid: jobUid } } }, apiOptions(cleanupSignal));
        // Accepted DELETE is not a completion acknowledgement. Foreground deletion
        // keeps the Job until its dependent Pods have been removed.
        for (;;) {
          const existing = await this.batch.readNamespacedJob({ name, namespace }, apiOptions(cleanupSignal));
          if (existing.metadata?.uid !== jobUid) throw new Error("Job identity changed during cleanup");
          await delay(100, undefined, { signal: cleanupSignal });
        }
      } catch (error) {
        // An absent object is conclusive only after observing the CREATE's UID.
        // A lost CREATE reply followed by 404 may race an apiserver still committing.
        if (missing(error) && jobUid) { attempted = false; this.owned.delete(name); this.pendingCleanup.delete(name); return; }
        this.pendingCleanup.add(name);
        throw new SandboxToolError("CLEANUP_PENDING", "UNKNOWN", "pending");
      }
    };
    const cleanup = (): Promise<void> => closing ??= remove().finally(() => { closing = undefined; });
    this.owned.set(name, cleanup);
    try {
      let result: k8s.V1Job;
      try {
        signal.throwIfAborted();
        attempted = true;
        result = await this.batch.createNamespacedJob({ namespace, body: job }, apiOptions(signal));
        jobUid = result.metadata?.uid;
      }
      catch (error) {
        const code = (error as { code?: number })?.code;
        if (code && code >= 400 && code < 500 && code !== 408) attempted = false;
        throw error;
      }
      finally { created(); }
      if (this.stopped) throw new SandboxToolError("SERVICE_UNAVAILABLE");
      if (!jobUid) throw new Error("Runner Job has no UID");
      const deadline = Date.now() + 90_000;
      let pod: k8s.V1Pod | undefined;
      let nextEvents = 0;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        const list = await this.core.listNamespacedPod({ namespace, labelSelector: `job-name=${name}` }, apiOptions(signal));
        pod = list.items.find(p => p.metadata?.ownerReferences?.some(o => o.uid === jobUid));
        if (!pod && Date.now() >= nextEvents) {
          nextEvents = Date.now() + 1000;
          const events = await this.core.listNamespacedEvent({ namespace, fieldSelector: `involvedObject.uid=${jobUid}` }, apiOptions(signal)).catch(() => undefined);
          if (events?.items.some(e => e.reason === "FailedCreate" && /quota|forbidden|serviceaccount|admission/i.test(e.message ?? ""))) throw new SandboxToolError("RUNNER_CAPACITY");
        }
        if (pod?.status?.containerStatuses?.some(s => ["ErrImagePull", "ImagePullBackOff", "InvalidImageName"].includes(s.state?.waiting?.reason ?? ""))) throw new SandboxToolError("IMAGE_UNAVAILABLE");
        if (pod?.status?.conditions?.some(c => c.type === "PodScheduled" && c.status === "False" && c.reason === "Unschedulable")) throw new SandboxToolError("RUNNER_CAPACITY");
        if (pod?.status?.containerStatuses?.some(s => s.state?.terminated)) throw new Error("Runner failed before accepting code (check image/isolation support)");
        if (pod?.status?.containerStatuses?.some(s => s.name === "runner" && s.state?.running)) break;
        await delay(100, undefined, { signal });
      }
      if (!pod?.metadata?.name || !pod.metadata.uid || !pod.status?.containerStatuses?.some(s => s.state?.running)) throw new Error("Runner startup timed out");
      const podName = pod.metadata.name;
      const uid = pod.metadata.uid;
      const expectedUid = job.spec!.template.spec!.securityContext!.runAsUser!;
      validateRunnerPod(pod, this.config, isolated, expectedUid, seconds + 90);
      const attach = new k8s.Attach(this.kubeConfig, new WebSocketHandler(this.kubeConfig,
        (uri, protocols, options) => new WebSocket(uri, protocols, { ...options, handshakeTimeout: 10_000, signal })));
      socket = await attach.attach(namespace, podName, "runner", stdout, stderr, stdin, false);
      const checked = await this.core.readNamespacedPod({ name: podName, namespace }, apiOptions(signal));
      validateRunnerPod(checked, this.config, isolated, expectedUid, seconds + 90);
      if (checked.metadata?.uid !== uid) throw new Error("Runner instance changed during attach");
      signal.throwIfAborted();
      const connection = socket;
      const done = new Promise<number | null>((resolve) => {
        connection.once("close", () => { stdout.end(); stderr.end(); resolve(null); });
        connection.once("error", () => { stdout.end(); stderr.end(); resolve(null); });
      });
      return { instanceId: uid, stdout, stderr, stdin, done, close: cleanup };
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    const results = await Promise.allSettled([...this.owned.values()].map(close => close()));
    if (results.some(r => r.status === "rejected")) throw new SandboxToolError("CLEANUP_PENDING", "UNKNOWN", "pending");
  }

}
