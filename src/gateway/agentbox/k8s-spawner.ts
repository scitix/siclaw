/**
 * K8s Pod Spawner
 *
 * Creates and manages AgentBox Pods via the Kubernetes API.
 */

import * as k8s from "@kubernetes/client-node";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo, AgentBoxStatus } from "./types.js";
import { getBoxProfile } from "./box-profile.js";
import { CertificateManager } from "../security/cert-manager.js";
import {
  certExpiryLabel,
  certificateNeedsRenewal,
  parseCertExpiryLabel,
  readCertificateNotAfter,
} from "../../shared/cert-validity.js";

export interface K8sSpawnerConfig {
  /** K8s namespace */
  namespace?: string;
  /** AgentBox image */
  image?: string;
  /** Image pull policy */
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  /** Pod label prefix */
  labelPrefix?: string;
  /** Shared PVC for user data persistence (memory, sessions).
   *  Gateway creates per-user subdirectories; AgentBox pods mount via subPath. */
  persistence?: {
    enabled: boolean;
    /** Name of the pre-existing shared PVC (e.g. "siclaw-data") */
    claimName: string;
  };
  /**
   * Node selector applied to every spawned AgentBox pod. Constrains pods to
   * nodes carrying all of these labels. Empty/undefined ⇒ no constraint
   * (scheduler picks any eligible node).
   */
  nodeSelector?: Record<string, string>;
}

const DEFAULT_CONFIG: Required<Omit<K8sSpawnerConfig, "persistence" | "nodeSelector">> = {
  namespace: "default",
  image: "siclaw-agentbox:latest",
  imagePullPolicy: "Always",
  labelPrefix: "siclaw.io",
};

/** K8s resource quantity → number (comparable within one resource kind).
 *  Handles the shapes our profiles use: bare numbers, cpu millicores ("500m"),
 *  and binary/decimal byte suffixes. Unknown shapes → NaN (caller skips). */
export function parseK8sQuantity(q: string): number {
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(q.trim());
  if (!m) return NaN;
  const n = Number(m[1]);
  const suffix = m[2];
  if (suffix === "") return n;
  if (suffix === "m") return n / 1000; // cpu millicores
  const scale: Record<string, number> = {
    Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
    k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12,
  };
  return suffix in scale ? n * scale[suffix] : NaN;
}

/**
 * Baseline resources for a spawned box, when neither the call nor the profile says.
 *
 * The memory REQUEST is what the scheduler packs nodes on, and the old 256Mi sat
 * BELOW what a box uses while doing nothing (measured: 164–282Mi idle across three
 * production pods). That both overcommits the node and, because the request/limit
 * split makes these Burstable, puts them first in line for eviction under node
 * pressure. 1Gi is the same request the KB compile profile already declared for
 * itself. Raising the limit costs nothing at schedule time — a limit reserves no
 * capacity — and buys headroom for the sub-agent fan-out.
 *
 * These are the FALLBACK for the no-env case (LocalSpawner, a hand-rolled manifest).
 * A helm deployment sets the same numbers through `agentbox.resources`; keep the two
 * in step. The right values depend on the sub-agent concurrency in use —
 * `siclaw_box_rss_bytes` (labelled by box_id) is the measurement to set them from.
 * Read per call so a test can vary the environment.
 */
function defaultBoxResources(): { cpu: string; cpuRequest: string; memory: string; memoryRequest: string } {
  return {
    cpu: process.env.SICLAW_AGENTBOX_CPU_LIMIT || "2000m",
    cpuRequest: process.env.SICLAW_AGENTBOX_CPU_REQUEST || "100m",
    memory: process.env.SICLAW_AGENTBOX_MEMORY_LIMIT || "8Gi",
    memoryRequest: process.env.SICLAW_AGENTBOX_MEMORY_REQUEST || "1Gi",
  };
}

/**
 * How long a box gets to shut down cleanly before SIGKILL.
 *
 * Chosen against what the teardown actually does rather than a round number: a metrics
 * flush over the network, one kubectl eviction per cached debug pod, an MCP shutdown per
 * live session, and a tracing flush (self-capped at 3s). The K8s default of 30s can be
 * exceeded by the debug-pod evictions alone on a busy box.
 *
 * This is a CEILING, not a delay — a box that finishes in two seconds exits in two seconds.
 */
function gracePeriodSeconds(): number {
  const raw = Number(process.env.SICLAW_AGENTBOX_TERMINATION_GRACE_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60;
}

/** requests ≤ limits guard (review): the request/limit split lets a profile
 *  declare a request ABOVE the (possibly default) limit — the API server
 *  rejects such a pod outright, taking the capability down on a config typo.
 *  Clamp the request down to the limit and say so; unparseable values pass
 *  through untouched (the API server remains the authority). */
export function clampRequestToLimit(request: string, limit: string, podName: string, kind: string): string {
  const req = parseK8sQuantity(request);
  const lim = parseK8sQuantity(limit);
  if (Number.isFinite(req) && Number.isFinite(lim) && req > lim) {
    console.warn(
      `[k8s-spawner] ${podName}: ${kind} request ${request} exceeds limit ${limit}; clamping request to the limit`,
    );
    return limit;
  }
  return request;
}

/**
 * Startup gate handed to kubelet: `periodSeconds × failureThreshold` is how long a container
 * gets to answer its first probe.
 *
 * 🔴 IT MUST COVER WORK THAT HAPPENS BEFORE THE BOX CAN LOG ANYTHING, and 60s did not.
 * A production pool could never fill: kubelet killed every box here, the Runtime reported a
 * spawn failure and respawned one that met the same end. Under `restartPolicy: Never` the
 * kill is terminal:
 *
 *   t+0s    container starts
 *   t+59s   30th probe fails → kubelet: "Container agentbox failed startup probe", KillPod
 *   t+119s  termination grace elapses → SIGKILL → exitCode 137, phase Failed
 *
 * The box was not slow at anything it logs — measured from its own first line to `listen()`
 * is 0.4s. The time went to the entrypoint's `chown -R` over the NFS-backed user-data
 * subPath, which runs before node starts, is silent, and grows with the agent's accumulated
 * session history. **That is the root cause and it is NOT fixed here** — this number only
 * stops a slow start from being a permanent one.
 *
 * Which is also why the margin is wide rather than merely sufficient: the span this window
 * has to cover includes pre-node work that no code here can see or time, and it grows on its
 * own. Nobody connects "the agent accumulated more state" to "pods stopped starting", and
 * being one second short costs a pod that never runs again.
 *
 * Named constants rather than literals at the call site because two other timeouts are
 * defined RELATIVE to this window — the Runtime's readiness wait above it and the box's own
 * startup budget below it — and `startup-probe-window.test.ts` asserts those relations. A
 * literal here would let the window move without the relations being rechecked.
 */
export const STARTUP_PROBE_PERIOD_SECONDS = 2;
export const STARTUP_PROBE_FAILURE_THRESHOLD = 90;

/** The window itself, in ms: how long kubelet allows before it gives up on the container. */
export const STARTUP_PROBE_WINDOW_MS =
  STARTUP_PROBE_PERIOD_SECONDS * STARTUP_PROBE_FAILURE_THRESHOLD * 1000;

/**
 * How long the Runtime waits for a pod it created to become Ready.
 *
 * MUST stay well above {@link STARTUP_PROBE_WINDOW_MS} — see waitForPodReady for why the two
 * measure different spans and what happened when they were equal. Raised with the window for
 * that reason; `startup-probe-window.test.ts` pins the ratio.
 *
 * Seven minutes reads long, and the two costs are not symmetric: a window too SMALL kills a
 * healthy box permanently, while a timeout too LARGE only delays reporting a spawn that is
 * genuinely broken — and is only ever waited out in that case, since a box that comes up
 * returns in under a minute.
 */
export const POD_READY_TIMEOUT_MS = 420_000;

/**
 * How kubelet asks a box whether it is up.
 *
 * Capability boxes run under a NetworkPolicy that admits only Runtime ingress, and kubelet
 * probes originate outside that podSelector on several CNIs — so they self-check from
 * inside the container instead. ONE declaration, shared by all three probes: a profile
 * that got the wrong dialect for even one of them would fail the probe kubelet cannot
 * route, and with a startup gate in place that means the box never becomes ready at all.
 */
function healthProbeFor(profileName: string): Record<string, unknown> {
  const inContainer = profileName === "kb-compile" || profileName === "kb-compile-codex" || profileName === "kb-test";
  return inContainer
    ? {
        exec: { command: [
          "python", "-c",
          "import ssl,urllib.request; urllib.request.urlopen('https://127.0.0.1:3000/health', context=ssl._create_unverified_context(), timeout=2).read()",
        ] },
        timeoutSeconds: 3,
      }
    : { httpGet: { path: "/health", port: 3000, scheme: "HTTPS" } };
}

export class K8sSpawner implements BoxSpawner {
  readonly name = "k8s";

  private kc: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;
  private config: Required<Omit<K8sSpawnerConfig, "persistence" | "nodeSelector">> & Pick<K8sSpawnerConfig, "persistence" | "nodeSelector">;
  private certManager: CertificateManager | null = null;

  constructor(config?: K8sSpawnerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Load kubeconfig
    this.kc = new k8s.KubeConfig();
    this.kc.loadFromDefault();

    this.coreApi = this.kc.makeApiClient(k8s.CoreV1Api);
  }

  /** Inject CertificateManager after DB initialization */
  setCertManager(cm: CertificateManager): void {
    this.certManager = cm;
  }

  /**
   * Generate Pod name. Sanitized to the K8s name charset and capped so the full name
   * stays under 63 chars.
   *
   * The prefix comes from the BoxProfile (default "agentbox"; compile boxes use
   * "kbc-box"). Both prefixes are ≤ 8 chars, so the 50-char agentId cap keeps the
   * full name well under 63.
   *
   * Every instance carries its index, `-0` included. Instance 0 used to be unsuffixed,
   * because that was the name every pod already had before an agent could run more than
   * one — but the asymmetry cost more than it saved: a replacement for instance 0 took
   * the identical name, so a box that had died and come back was indistinguishable from
   * the one that had been there all along.
   *
   * The old name is still recognised for as long as such a pod can exist: the manager
   * treats it as stale, so it drains and its replacement comes back as `-0`.
   *
   * Nothing parses the index back out of a name; the `instance` label is the record.
   */
  private podName(agentId: string, prefix = "agentbox", instance = 0): string {
    return `${this.podBaseName(agentId, prefix)}-${instance}`;
  }

  /** The name every box of this agent shares, without an instance index. */
  private podBaseName(agentId: string, prefix = "agentbox"): string {
    const sanitized = agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
    return `${prefix}-${sanitized}`;
  }

  /**
   * The pod name a box WOULD have. The manager asks rather than deriving it: two copies of
   * a naming rule are two chances to disagree, and the last time they did, a `stop()`
   * targeted a name no pod had — it 404'd, was swallowed, and the box ran on forever.
   */
  boxIdFor(agentId: string, profile?: string, instance = 0): string {
    return this.podName(agentId, getBoxProfile(profile).podNamePrefix ?? "agentbox", instance);
  }

  /**
   * What instance 0 was called before every instance carried its index.
   *
   * Exposed so the manager can recognise such a pod and roll it, rather than leaving it
   * running under a name nothing looks up any more.
   */
  legacyPodName(agentId: string, profile?: string): string {
    return this.podBaseName(agentId, getBoxProfile(profile).podNamePrefix ?? "agentbox");
  }

  /**
   * Name of the certificate Secret for an agent — derived from the INSTANCE-0 pod name,
   * so every box of the agent mounts the same one.
   *
   * The certificate asserts the agent, not the pod (`CN = agentId`, every SAN
   * agentId-derived; the pod name appears only in the informational `serialNumber`), so
   * one Secret per agent is what it already meant. Naming it per pod instead would mint
   * and orphan one per replica on every scale change.
   *
   * For a single-box agent this is byte-identical to the previous `${podName}-cert`.
   */
  private certSecretName(agentId: string, prefix = "agentbox"): string {
    // Deliberately the BASE name, not instance 0's pod name: this Secret is shared by
    // every box of the agent, and it already exists under this name in every running
    // deployment. Deriving it from the pod name would have renamed it the moment
    // instance 0 gained its index, orphaning the old one and re-issuing every cert.
    return `${this.podBaseName(agentId, prefix)}-cert`;
  }

  /**
   * What an existing cert Secret holds: the CA that signed it, and when its leaf dies.
   *
   * The CA comes from the label (that is what stamps it), but `notAfter` is parsed from
   * the certificate ITSELF rather than from a second label. A label would be a separate
   * answer to a question the bytes already answer, and the two could disagree — the leaf
   * is the thing pods actually present.
   *
   * Null ⇒ the Secret could not be read at all, which the caller treats as stale.
   */
  private async readCertSecret(name: string): Promise<{ caFp?: string; notAfter: Date | null } | null> {
    const { namespace, labelPrefix } = this.config;
    try {
      const s = await this.coreApi.readNamespacedSecret({ name, namespace });
      const encoded = s.data?.["tls.crt"];
      return {
        caFp: s.metadata?.labels?.[`${labelPrefix}/ca-fp`],
        notAfter: encoded
          ? readCertificateNotAfter(Buffer.from(encoded, "base64").toString("utf8"))
          : null,
      };
    } catch {
      return null; // unreadable ⇒ treat as stale and take the replace path
    }
  }

  /**
   * Make sure the agent's cert Secret holds a certificate a new pod can actually use, and
   * report when that certificate expires.
   *
   * 🔴 TWO reasons a Secret is stale, and for a long time only the first was checked. A
   * ROTATED CA is the loud one. The quiet one is EXPIRY: the leaf is valid for
   * AGENTBOX_CERT_VALIDITY_DAYS, a fresh certificate is minted on every spawn, and the
   * 409 branch below then threw it away whenever the CA still matched — so the Secret was
   * written once and never again. Past day 30 every box of the agent failed mTLS in both
   * directions (the Runtime reporting CERT_HAS_EXPIRED, the box seeing only a socket hang
   * up), and recreating the pod did not help because the new pod mounted the same dead
   * Secret. Judging the LEAF is what closes that.
   *
   * The Secret is per-AGENT, so two replicas spawning at once both land in the 409 branch.
   * Replacing a certificate a sibling is already mounting is safe in the sense that
   * matters — a certificate signed by the current CA authenticates any box of the agent —
   * but it does not help a RUNNING sibling: the box reads its certificate off disk once at
   * startup, so the pod has to be recreated to pick a new one up. That is the manager's
   * job (see AgentBoxManager.isCertFresh); here we only guarantee that a pod being created
   * now gets a live certificate.
   *
   * Returns null when the effective expiry could not be determined, which callers must
   * treat as "unknown", never as "expired".
   */
  private async ensureCertSecret(
    certSecretName: string,
    secretLabels: Record<string, string>,
    certBundle: { cert: string; key: string; ca: string },
    caFp: string,
  ): Promise<Date | null> {
    const { namespace } = this.config;
    const body: k8s.V1Secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: certSecretName, labels: secretLabels },
      type: "kubernetes.io/tls",
      data: {
        "tls.crt": Buffer.from(certBundle.cert).toString("base64"),
        "tls.key": Buffer.from(certBundle.key).toString("base64"),
        "ca.crt": Buffer.from(certBundle.ca).toString("base64"),
      },
    };

    try {
      await this.coreApi.createNamespacedSecret({ namespace, body });
      console.log(`[k8s-spawner] Created certificate Secret ${certSecretName}`);
      return readCertificateNotAfter(certBundle.cert);
    } catch (err: any) {
      if (err.code !== 409 && err.statusCode !== 409) throw err;
    }

    const existing = await this.readCertSecret(certSecretName);
    // 🔴 An unreadable SECRET is stale; a Secret whose CERTIFICATE will not parse is not.
    // The difference is deliberate. `certificateNeedsRenewal(null)` is false, so a parse
    // failure lands on the reuse branch — because this Secret is per-agent, and replacing
    // on a parse failure would make any blind spot in the parser delete and recreate, on
    // every single spawn, a certificate the agent's other boxes are mounting. A genuinely
    // corrupt certificate is caught by the pod failing to start, which the spawn-retry
    // cooldown already bounds.
    const staleReason =
      !existing ? "unreadable"
      : existing.caFp !== caFp ? `CA rotated (secret=${existing.caFp ?? "none"}, current=${caFp})`
      : certificateNeedsRenewal(existing.notAfter)
        ? `certificate expires ${existing.notAfter?.toISOString() ?? "unknown"}`
        : null;

    if (!staleReason) {
      // The pod below mounts the existing Secret; the certificate just minted is discarded.
      console.log(`[k8s-spawner] Reusing certificate Secret ${certSecretName} (current CA, expires ${existing?.notAfter?.toISOString() ?? "unknown"})`);
      return existing?.notAfter ?? null;
    }

    console.log(`[k8s-spawner] Replacing certificate Secret ${certSecretName}: ${staleReason}`);
    // 404-tolerant: a sibling replica may have replaced it first.
    try {
      await this.coreApi.deleteNamespacedSecret({ name: certSecretName, namespace });
    } catch (delErr: any) {
      if (delErr?.code !== 404 && delErr?.statusCode !== 404) throw delErr;
    }
    try {
      await this.coreApi.createNamespacedSecret({ namespace, body });
      console.log(`[k8s-spawner] Replaced certificate Secret ${certSecretName}`);
      return readCertificateNotAfter(certBundle.cert);
    } catch (recreateErr: any) {
      // A sibling won the race and already recreated it. Its certificate is the one this
      // pod will mount, so re-read rather than reporting the expiry of ours.
      if (recreateErr?.code !== 409 && recreateErr?.statusCode !== 409) throw recreateErr;
      return (await this.readCertSecret(certSecretName))?.notAfter ?? null;
    }
  }

  /**
   * Upgrade migration: reap a pod left under the OLD "agentbox-" name for a
   * profile that now spawns under a different prefix (e.g. "kbc-box-"). Deletes
   * the pod and its cert Secret, then waits for it to disappear so the agent
   * never has two live boxes across the rename.
   *
   * Guard: only a compile box (boxType label "kb-compile*") is reaped. A chat
   * box (boxType "agent") keeps the "agentbox-" name and owns its own lifecycle;
   * it must never be touched even if it happens to share this agentId. A missing
   * legacy pod (404) is the normal post-migration steady state → no-op.
   */
  private async reapRenamedLegacyPod(legacyName: string, namespace: string, labelPrefix: string): Promise<void> {
    let existing: k8s.V1Pod;
    try {
      existing = await this.coreApi.readNamespacedPod({ name: legacyName, namespace });
    } catch (err: any) {
      if (err.code === 404 || err.statusCode === 404) return;
      throw err;
    }
    const boxType = existing.metadata?.labels?.[`${labelPrefix}/boxType`] || "agent";
    if (!boxType.startsWith("kb-compile")) return;
    console.log(`[k8s-spawner] Reaping legacy-named pod ${legacyName} (boxType=${boxType}) superseded by renamed prefix`);
    await this.stop(legacyName); // deletes pod + cert Secret, 404-tolerant
    await this.waitForPodDeleted(legacyName, namespace);
  }

  private gatewayUrl(namespace: string): string {
    if (process.env.SICLAW_GATEWAY_INTERNAL_URL) {
      return process.env.SICLAW_GATEWAY_INTERNAL_URL;
    }

    if (process.env.SICLAW_GATEWAY_HOSTNAME) {
      const port = process.env.SICLAW_INTERNAL_PORT || "3002";
      return `https://${process.env.SICLAW_GATEWAY_HOSTNAME}:${port}`;
    }

    return `https://siclaw-runtime.${namespace}.svc.cluster.local:3002`;
  }

  /**
   * Create an AgentBox Pod
   */
  async spawn(boxConfig: AgentBoxConfig): Promise<AgentBoxHandle> {
    const { namespace, imagePullPolicy, labelPrefix } = this.config;
    // A box's shape (image, extra env/HOME/volumes, tool/trust envelope) comes
    // from its BoxProfile — the default "agent" profile is a normal agentbox; a
    // capability like "kb-compile" declares its own image + writable /work etc.
    // All flavors reuse the same spawn/cert/mTLS/port machinery below.
    const profile = getBoxProfile(boxConfig.profile);
    const healthProbe = healthProbeFor(profile.name);
    const needsBubblewrap = profile.nestedSandbox === "bubblewrap";
    const image = boxConfig.image ?? profile.image ?? this.config.image;
    const agentId = boxConfig.agentId;
    if (!agentId) throw new Error("K8sSpawner.spawn requires a non-empty agentId");
    const podPrefix = profile.podNamePrefix ?? "agentbox";
    const podName = this.podName(agentId, podPrefix, boxConfig.instance ?? 0);
    const orgId = boxConfig.orgId || "";

    console.log(`[k8s-spawner] Creating pod: ${podName} for agent: ${agentId}`);

    // Upgrade compatibility: a profile that carries a non-default pod prefix used
    // to spawn under the "agentbox-" name. After the rename, the spawner looks up
    // (and reuses) the NEW name only, so a pre-upgrade pod under the old name would
    // leak — two boxes for one agent, the old one never reaped. Reap the stale
    // old-named pod (+ its cert Secret) first, but only when it is a compile box
    // (boxType "kb-compile*") — never a chat box that merely shares the agentId.
    if (podPrefix !== "agentbox") {
      // The pod it is looking for predates instance indices, so it wants the BASE name.
      await this.reapRenamedLegacyPod(this.legacyPodName(agentId, "agent"), namespace, labelPrefix);
    }

    // Stamp the pod + its cert Secret with the CA fingerprint, and the pod with its
    // certificate's expiry. The runtime uses the first to detect pods whose mTLS cert was
    // signed by a rotated CA and the second to detect pods whose cert is simply running
    // out — neither can complete mTLS in either direction once it happens, so both mean
    // recycle. See the reuse branch below and AgentBoxManager.isCertFresh.
    if (!this.certManager) throw new Error("CertificateManager not initialized — call setCertManager() first");
    const caFp = this.certManager.caFingerprint();
    const caFpLabel = `${labelPrefix}/ca-fp`;
    const certExpLabel = `${labelPrefix}/cert-exp`;

    // Clean up any existing pod in non-running state (Failed, Succeeded, Error)
    // so we can recreate with the same name
    try {
      const existing = await this.coreApi.readNamespacedPod({ name: podName, namespace });
      const phase = existing.status?.phase;

      // 🔴 Cross-agent name collision. podName() sanitizes and truncates, so distinct
      // agentIds can map to one pod name ("a.b" and "a-b" both become "a-b"), and the
      // instance suffix adds the pair X / X-<n> ("foo" instance 1 and agent "foo-1"
      // instance 0 are both agentbox-foo-1). Reusing another agent's pod would serve this
      // agent's sessions from a box holding the OTHER agent's certificate and PVC subPath.
      //
      // Fail loudly instead. Deleting it would be worse — that is someone else's live box.
      // The caller treats a failed instance as unavailable and moves on to another index.
      const owner = existing.metadata?.labels?.[`${labelPrefix}/agent`];
      if (owner !== undefined && owner !== agentId) {
        throw new Error(
          `Pod name collision: ${podName} belongs to agent "${owner}", not "${agentId}". ` +
          `Refusing to reuse or replace another agent's box.`,
        );
      }
      // A pod being torn down (or spawned) under this name for a DIFFERENT profile
      // must not be reused — its image/tools/volumes are the old shape. Treat a
      // profile mismatch (or an in-progress deletion) like a stale pod: delete +
      // wait, then create fresh with the requested profile.
      const existingProfile = existing.metadata?.labels?.[`${labelPrefix}/boxType`] || "agent";
      const profileMismatch = existingProfile !== profile.name;
      const terminating = existing.metadata?.deletionTimestamp != null;
      // 🔴 An explicit rebuild is judged BEFORE the phase, not inside one branch of it.
      // Attached to the Running/Pending arm, it silently did nothing for a pod with NO phase
      // at all — which is precisely a pod the manager maps to `error` and asks to rebuild, so
      // the budget was spent and the create below then hit 409 and reused the same pod. The
      // caller's decision does not depend on which phase the pod happens to report.
      const explicitRebuild = boxConfig.recreate === true;
      if (phase === "Failed" || phase === "Succeeded" || phase === "Unknown" || profileMismatch || terminating || explicitRebuild) {
        console.log(
          explicitRebuild && phase !== "Failed" && phase !== "Succeeded" && phase !== "Unknown" && !profileMismatch && !terminating
            ? `[k8s-spawner] Replacing pod ${podName} — caller asked for a rebuild (phase: ${phase ?? "none"})`
            : `[k8s-spawner] Removing stale pod ${podName} (phase: ${phase ?? "none"}, profile: ${existingProfile}→${profile.name})`,
        );
        // Let delete errors reach the outer catch, which swallows 404 (pod
        // already gone) and rethrows everything else (finding F): a blanket
        // `.catch(() => {})` here turned a real API error — RBAC, etc. — into a
        // waitForPodDeleted timeout instead of a clear failure. Consistent with
        // the CA-mismatch delete below, which never swallowed.
        await this.coreApi.deleteNamespacedPod({ name: podName, namespace });
        // Wait for pod to be fully deleted
        await this.waitForPodDeleted(podName, namespace);
      } else if (phase === "Running" || phase === "Pending") {
        const podFp = existing.metadata?.labels?.[caFpLabel];
        // Two ways the pod's certificate can be unusable, and both mean the runtime can no
        // longer talk to it in either direction. A MISSING expiry label is not one of them
        // — pods created before the label existed have none, and reading that as stale
        // would recycle every one of them on sight.
        const podCertExp = parseCertExpiryLabel(existing.metadata?.labels?.[certExpLabel]);
        // Reached only when the caller did NOT ask for a rebuild (that is handled above,
        // phase-independently), so this arm is purely about the certificate.
        const replaceReason =
          podFp !== caFp ? `stale CA (pod=${podFp ?? "none"}, current=${caFp})`
          : certificateNeedsRenewal(podCertExp)
            ? `certificate expires ${podCertExp?.toISOString() ?? "unknown"}`
            : null;
        if (!replaceReason) {
          console.log(`[k8s-spawner] Pod ${podName} already exists (phase: ${phase}), reusing`);
          const endpoint = await this.waitForPodReady(podName, namespace);
          return { boxId: podName, agentId, endpoint };
        }
        // Recycle it rather than returning an endpoint that cannot serve. For the certificate
        // reasons the Secret is re-issued below, since ensureCertSecret judges the leaf too.
        console.log(`[k8s-spawner] Replacing pod ${podName} — ${replaceReason}`);
        await this.coreApi.deleteNamespacedPod({ name: podName, namespace });
        await this.waitForPodDeleted(podName, namespace);
      }
    } catch (err: any) {
      if (err.code !== 404 && err.statusCode !== 404) {
        throw err;
      }
      // Pod doesn't exist, proceed to create
    }

    // Issue client certificate for mTLS authentication. The serialNumber carries the
    // agent's BASE pod name, not this instance's: it is the identity every box of the
    // agent presents, and the Gateway uses it as the authorization root when a box
    // reports which pod it actually is (see handleMetricsFlush).
    // The AGENT's name, not a pod's: this identity is shared by every box, and the
    // metrics-flush authorizer accepts `<certBase>-<instance>` from any of them.
    const certBase = this.podBaseName(agentId, podPrefix);
    const certBundle = this.certManager.issueAgentBoxCertificate(agentId, orgId, certBase);
    const certSecretName = this.certSecretName(agentId, podPrefix);

    const secretLabels = {
      [`${labelPrefix}/app`]: "agentbox",
      [`${labelPrefix}/agent`]: agentId,
      [caFpLabel]: caFp,
      // boxType scopes the orphan sweep: without it the Secret pass could not
      // tell a capability box's cert from a chat box's (review finding).
      [`${labelPrefix}/boxType`]: profile.name,
    };
    const certNotAfter = await this.ensureCertSecret(certSecretName, secretLabels, certBundle, caFp);

    // Environment variables — only bootstrap deps that cannot come from settings.json
    const env: k8s.V1EnvVar[] = [
      { name: "PI_CODING_AGENT_DIR", value: ".siclaw/user-data/agent" },
      { name: "SICLAW_GATEWAY_URL", value: this.gatewayUrl(namespace) },
      { name: "SICLAW_AGENT_ID", value: agentId },
      // Which pod this process is. Every box of an agent presents the SAME certificate,
      // so the cert can no longer tell the Gateway which replica is reporting — the box
      // has to say, and the Gateway authorizes the claim against the cert (see
      // handleMetricsFlush). Downward API rather than a literal so it cannot drift.
      { name: "SICLAW_POD_NAME", valueFrom: { fieldRef: { fieldPath: "metadata.name" } } },
    ];
    // Normal AgentBoxes need Runtime-level memory/embedding/sub-agent settings.
    // Lean capability profiles do not use those features, and inheriting this
    // base allowlist would copy SICLAW_EMBEDDING_API_KEY into an unrelated KB
    // PodSpec. Capability boxes receive only their profile-declared env below.
    if (profile.name === "agent") {
      if (process.env.SICLAW_MEMORY_ENABLED !== undefined) {
        env.push({ name: "SICLAW_MEMORY_ENABLED", value: process.env.SICLAW_MEMORY_ENABLED });
      }

      const AGENTBOX_FORWARDED_ENV = [
        // Sub-agent capacity: per conversation, and the box-wide ceiling. Both are read
        // inside the box, so forwarding is what makes the runtime-level setting real.
        "SICLAW_SUBAGENT_CONCURRENCY",
        "SICLAW_SUBAGENT_POD_CONCURRENCY",
        // Sub-agent model tiering, and the batch-group switch. Both are read inside
        // the box (getSubagentModelTierOverride / isSubagentGroupEnabled) and both
        // are documented as the OPS ROLLBACK lever for their feature — while neither
        // was forwarded, so setting them on the Runtime deployment did nothing
        // whatsoever in K8s mode. A switch that silently does nothing is worse than
        // an absent one: the control plane deleted its own config-table kill switch
        // on the strength of this env, leaving tiering with no working brake at all.
        //
        // Forwarding does not make either one INSTANT, and nothing here could: a live
        // AgentBox keeps the env it was created with, so the new value reaches an
        // existing session only when its pod is recycled or idles out.
        "SICLAW_SUBAGENT_MODEL_TIER",
        "SICLAW_SUBAGENT_GROUP_ENABLED",
        // Embedding endpoint for the memory indexer. The agentbox reads these via
        // loadConfig() env overrides (config.ts); set on the runtime deployment to
        // configure every normal AgentBox it spawns.
        "SICLAW_EMBEDDING_BASE_URL",
        "SICLAW_EMBEDDING_MODEL",
        "SICLAW_EMBEDDING_DIMENSIONS",
        "SICLAW_EMBEDDING_API_KEY",
        // Visual tools execute inside the AgentBox, while their renderer URL is
        // configured on the Runtime deployment. Forward the complete non-secret
        // renderer contract so a configured endpoint does not disappear at the
        // process boundary and fall back to an invented cluster DNS name.
        "SICLAW_VISUAL_EXPORT_URL",
        "SICLAW_VISUAL_EXPORT_TIMEOUT_MS",
        "SICLAW_VISUAL_EXPORT_THEME",
        "SICLAW_VISUAL_EXPORT_CHROMIUM",
        // Trace deployment environment (Langfuse deployment.environment.name).
        "SICLAW_TRACING_ENVIRONMENT",
      ];
      for (const name of AGENTBOX_FORWARDED_ENV) {
        const value = process.env[name];
        if (value !== undefined && value !== "") {
          env.push({ name, value });
        }
      }
    }

    // Profile-declared extra env forwarding, ON TOP of the base allowlist. A lean
    // capability box (e.g. kb-compile) does NOT phone home for settings, so its LLM
    // Anthropic-compatible model proxy endpoint must be injected as env
    // ("credentials don't enter the sandbox" → the base URL is a proxy, key
    // injected proxy-side). Which names to forward is the profile's declaration.
    // A trailing "*" forwards every var with that prefix (e.g. "KBC_*" — the KB
    // box's ops knobs: PK on/off, budgets, model tiers — so production can tune
    // them via the runtime deployment env instead of rebuilding the box image).
    const forwarded = new Set(env.map((e) => e.name));
    const forwardOne = (name: string, value: string | undefined) => {
      if (value !== undefined && value !== "" && !forwarded.has(name)) {
        forwarded.add(name);
        env.push({ name, value });
      }
    };
    // Prefix forwarding is trust-by-naming: everything it matches lands in the
    // PodSpec in cleartext (readable by anyone with pod-get in the namespace).
    // Forwarded prefixes are for OPS KNOBS only — a secret must never be named
    // under one (credentials reach the box via the /session body, not env).
    // Belt-and-braces: refuse secret-shaped names so a credential parked in the
    // runtime env can't ride the glob into the pod spec.
    const secretShaped = /(TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|PRIVATE)/i;
    for (const name of profile.envForward ?? []) {
      if (name.endsWith("*")) {
        const prefix = name.slice(0, -1);
        for (const [key, value] of Object.entries(process.env)) {
          if (!key.startsWith(prefix)) continue;
          if (secretShaped.test(key.slice(prefix.length))) {
            console.warn(`[k8s-spawner] refusing to forward secret-shaped env ${key} (matched prefix ${name})`);
            continue;
          }
          forwardOne(key, value);
        }
      } else {
        forwardOne(name, process.env[name]);
      }
    }
    // The pod rootfs is read-only; a profile that runs Claude Code needs a writable
    // HOME (its default e.g. /home/kbc is not writable, so ~/.claude writes hit
    // EROFS and break the in-box Bash tool). The profile points HOME at one of its
    // writable volumes below (e.g. /work → ~/.claude = /work/.claude).
    if (profile.home) {
      env.push({ name: "HOME", value: profile.home });
    }

    // Add custom environment variables
    if (boxConfig.env) {
      for (const [key, value] of Object.entries(boxConfig.env)) {
        env.push({ name: key, value });
      }
    }

    // Shared PVC is now scoped per-agent only — all users of the agent share
    // this subdirectory (memory is agent-shared per the 2026-04-18 spec).
    const safeAgentId = this.sanitizePathSegment(agentId);

    // Persistence decision is per-agent: boxConfig.persistence overrides the
    // spawner's global config (undefined → fall back to global). Mounting the
    // PVC requires a claimName, so an agent that requests persistence on a
    // runtime with no shared PVC configured falls back to emptyDir (with a
    // warning) rather than spawning a pod that can never mount.
    const persistenceClaimName = this.config.persistence?.claimName;
    const wantsPersistence = boxConfig.persistence ?? !!this.config.persistence?.enabled;
    const persistenceEnabled = wantsPersistence && !!persistenceClaimName;
    if (wantsPersistence && !persistenceClaimName) {
      console.warn(
        `[k8s-spawner] Agent ${agentId} requests persistence but no shared PVC claimName is configured; ` +
        `falling back to emptyDir (session/memory will NOT survive pod restarts)`,
      );
    }
    if (persistenceEnabled) {
      const subDir = `agents/${safeAgentId}`;
      console.log(`[k8s-spawner] Persistence enabled for agent ${agentId}: shared PVC "${persistenceClaimName}", subPath "${subDir}"`);
      this.ensureAgentDir(safeAgentId);
    }

    // user-data volume: shared PVC when persistence resolved on (claimName is
    // narrowed to string by the && below), otherwise an ephemeral emptyDir.
    const userDataVolume: k8s.V1Volume = persistenceEnabled && persistenceClaimName
      ? { name: "user-data", persistentVolumeClaim: { claimName: persistenceClaimName } }
      : { name: "user-data", emptyDir: {} };

    // Pod definition
    const pod: k8s.V1Pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace,
        ...(needsBubblewrap
          ? {
              // Kubernetes 1.29 exposes AppArmor through the legacy per-container
              // annotation. Bubblewrap immediately installs the narrower inner
              // filesystem/network boundary; without this exception AppArmor
              // rejects its namespace mounts before that boundary exists.
              annotations: {
                "container.apparmor.security.beta.kubernetes.io/agentbox": "unconfined",
              },
            }
          : {}),
        labels: {
          // Keep app=agentbox so existing list()/cleanup() lifecycle management
          // covers capability pods too; the profile name distinguishes them for
          // observability (label key kept as boxType for continuity).
          [`${labelPrefix}/app`]: "agentbox",
          [`${labelPrefix}/agent`]: agentId,
          [caFpLabel]: caFp,
          // Expiry of the certificate this pod actually mounts — which may be the one
          // ensureCertSecret reused from a sibling, not the one minted above. Omitted when
          // unknown: an ABSENT label means "no answer", and the manager reads it as
          // fresh. Stamping a wrong date would be worse than stamping none.
          ...(certNotAfter ? { [certExpLabel]: certExpiryLabel(certNotAfter) } : {}),
          [`${labelPrefix}/boxType`]: profile.name,
          // Which replica of the agent this is. The label is the record — the pod NAME
          // is not, because instance 0 is deliberately unsuffixed (see podName).
          [`${labelPrefix}/instance`]: String(boxConfig.instance ?? 0),
        },
      },
      spec: {
        hostname: podName,
        subdomain: "agentbox-hs",
        automountServiceAccountToken: false,
        restartPolicy: "Never",
        // A box's SIGTERM path is not instant: it flushes its final metrics over the
        // network, evicts cached debug pods (a kubectl call each), closes every session's
        // MCP connections, then flushes tracing. K8s defaults to 30s, after which the
        // process is SIGKILLed mid-teardown — losing the trailing metrics and orphaning
        // debug pods, which then survive only on their Job TTL.
        terminationGracePeriodSeconds: gracePeriodSeconds(),
        ...(this.config.nodeSelector && Object.keys(this.config.nodeSelector).length > 0
          ? { nodeSelector: this.config.nodeSelector }
          : {}),
        // Spread an agent's boxes over nodes. Without this the scheduler packs them, and
        // a pool that exists to survive one box's loss ends up sharing one node's failure
        // domain — the node goes, the whole agent goes with it.
        //
        // PREFERRED, never required: a small cluster (or one whose nodeSelector admits a
        // single node) must still be able to place the pods. Spreading is worth a lot and
        // costs nothing when it succeeds; refusing to schedule would cost everything.
        affinity: {
          podAntiAffinity: {
            preferredDuringSchedulingIgnoredDuringExecution: [{
              weight: 100,
              podAffinityTerm: {
                topologyKey: "kubernetes.io/hostname",
                labelSelector: {
                  matchLabels: {
                    [`${labelPrefix}/app`]: "agentbox",
                    [`${labelPrefix}/agent`]: agentId,
                  },
                },
              },
            }],
          },
        },
        // ── Security: dual-user isolation (ADR-010) ─────────────────
        // Container starts as root (entrypoint fixes volume permissions,
        // then drops to agentbox via runuser). Child processes run as
        // sandbox user via sudo. CHOWN/FOWNER are needed for the
        // entrypoint to fix volume permissions; SETUID/SETGID for user
        // switching. The non-root Codex compile image needs none of those
        // capabilities; its container context below drops everything.
        securityContext: {
          // Only the compile profile may create its declared nested sandbox.
          // Normal AgentBoxes and closed-book kb-test boxes retain the outer
          // RuntimeDefault policy.
          seccompProfile: { type: needsBubblewrap ? "Unconfined" : "RuntimeDefault" },
        },
        volumes: [
          {
            name: "credentials",
            emptyDir: {},
          },
          {
            name: "config",
            emptyDir: {},
          },
          {
            name: "skills-local",
            emptyDir: {},
          },
          {
            name: "knowledge-local",
            emptyDir: {},
          },
          userDataVolume,
          {
            name: "client-cert",
            secret: { secretName: certSecretName },
          },
          {
            name: "tmp",
            emptyDir: { sizeLimit: "100Mi" },
          },
          // Profile-declared writable volumes (rootfs is read-only). e.g. kb-compile
          // needs /work for the agent's raw/candidate/bundle + ~/.claude.
          ...(profile.volumes ?? []).map(
            (v) =>
              ({
                name: v.name,
                emptyDir: v.sizeLimit ? { sizeLimit: v.sizeLimit } : {},
              }) as k8s.V1Volume,
          ),
        ],
        containers: [
          {
            name: "agentbox",
            image,
            imagePullPolicy,
            securityContext: {
              capabilities: needsBubblewrap
                ? { drop: ["ALL"] }
                : {
                    drop: ["ALL"],
                    add: ["SETUID", "SETGID", "CHOWN", "FOWNER", "AUDIT_WRITE"],
                  },
              readOnlyRootFilesystem: true,
            },
            ports: [
              { containerPort: 3000, name: "https" },
            ],
            env,
            volumeMounts: [
              {
                name: "credentials",
                mountPath: "/app/.siclaw/credentials",
              },
              {
                name: "config",
                mountPath: "/app/.siclaw/config",
              },
              {
                name: "skills-local",
                mountPath: "/app/.siclaw/skills",
              },
              {
                name: "knowledge-local",
                mountPath: "/app/.siclaw/knowledge",
              },
              {
                name: "user-data",
                mountPath: "/app/.siclaw/user-data",
                ...(persistenceEnabled
                  ? { subPath: `agents/${safeAgentId}` }
                  : {}),
              },
              {
                name: "client-cert",
                mountPath: "/etc/siclaw/certs",
                readOnly: true,
              },
              {
                name: "tmp",
                mountPath: "/tmp",
              },
              ...(profile.volumes ?? []).map(
                (v) => ({ name: v.name, mountPath: v.mountPath }) as k8s.V1VolumeMount,
              ),
            ],
            // Per-call resources win; the BoxProfile's resources are the fallback
            // (jacoblee review: profile.resources was declared but read nowhere,
            // so a memory-hungry profile silently got the default limit and could
            // OOM). Same precedence as profile.image / profile.volumes above.
            resources: (() => {
              const res = boxConfig.resources ?? profile.resources;
              const dflt = defaultBoxResources();
              const cpuLimit = res?.cpu || dflt.cpu;
              const memoryLimit = res?.memory || dflt.memory;
              return {
                requests: {
                  cpu: clampRequestToLimit(res?.cpuRequest || res?.cpu || dflt.cpuRequest, cpuLimit, podName, "cpu"),
                  memory: clampRequestToLimit(res?.memoryRequest || res?.memory || dflt.memoryRequest, memoryLimit, podName, "memory"),
                },
                limits: {
                  cpu: cpuLimit,
                  memory: memoryLimit,
                },
              };
            })(),
            // NetworkPolicy for capability boxes admits only Runtime ingress.
            // Kubelet HTTP probes originate outside that podSelector on several
            // CNIs, so use an in-container HTTPS check for KB profiles. The
            // endpoint is deliberately the sole route that needs no client cert.
            // Nothing is probed until the box answers once. Without this, readiness opens
            // fire 2s in against a process still fetching settings and syncing skills —
            // and, because instance names are reused, sometimes against a pod with no IP
            // yet ("connect: invalid argument"). Every rolled box therefore published one
            // or two Warning events on the way up, which is what a rolling upgrade looked
            // like from the outside: a pool full of unhealthy boxes, none of them failing.
            //
            // 30 x 2s is the same 60s the manager waits before calling a box crashed, so
            // the two do not disagree about when a box has failed to come up. Readiness
            // and liveness carry no initialDelay: kubelet holds them until this passes,
            // and a delay measured from container start would be spent by then anyway.
            startupProbe: {
              ...healthProbe,
              periodSeconds: STARTUP_PROBE_PERIOD_SECONDS,
              failureThreshold: STARTUP_PROBE_FAILURE_THRESHOLD,
            },
            readinessProbe: { ...healthProbe, periodSeconds: 2 },
            livenessProbe: { ...healthProbe, periodSeconds: 10 },
          },
        ],
      },
    };

    // Create Pod (handle 409 Conflict if another process created it concurrently)
    try {
      await this.coreApi.createNamespacedPod({ namespace, body: pod });
    } catch (err: any) {
      if (err.code === 409 || err.statusCode === 409) {
        console.log(`[k8s-spawner] Pod ${podName} already exists (concurrent create), reusing`);
      } else {
        throw err;
      }
    }

    // Wait for Pod to obtain an IP
    const endpoint = await this.waitForPodReady(podName, namespace);

    return {
      boxId: podName,
      agentId,
      endpoint,
    };
  }

  /** Sanitize a path segment — keep only safe characters for directory names and K8s subPath. */
  private sanitizePathSegment(segment: string): string {
    return segment.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 63);
  }

  /**
   * Ensure per-agent subdirectory exists on the shared PVC (synchronous, idempotent).
   * Expects already-sanitized path segments.
   * Directory layout: `/app/.siclaw/user-data/agents/{safeAgentId}/`
   */
  private ensureAgentDir(safeAgentId: string): void {
    const base = path.resolve("/app/.siclaw/user-data");
    const dir = path.join(base, "agents", safeAgentId);
    if (!dir.startsWith(base)) {
      throw new Error(`[k8s-spawner] Path traversal detected: ${dir}`);
    }
    fs.mkdirSync(dir, { recursive: true });
  }

  /**
   * Wait for Pod to be Ready and obtain its IP.
   *
   * 🔴 This deadline and the pod's `startupProbe` window (see `healthProbeFor`:
   * periodSeconds × failureThreshold) do NOT measure the same thing, so they must not carry
   * the same number — and for a long time both were 60s. The probe budget starts when the
   * CONTAINER starts; this one starts at pod CREATION and additionally has to cover
   * scheduling, the image pull and volume attachment. A pod that spent 30s being scheduled
   * and then passed its probe in 40s is healthy and Ready at t=70s, yet the runtime had
   * already declared the spawn failed at t=60s — which is exactly what the pool-fill
   * storm was made of: several boxes of one agent cold-starting together contend for the
   * node and the shared PVC, every one of them is reported failed, and every failure feeds
   * another fill attempt.
   *
   * Raising this does NOT hide a broken pod: a genuinely failed one leaves through the
   * `Failed` branch below within seconds of kubelet giving up on it.
   */
  private async waitForPodReady(
    podName: string,
    namespace: string,
    timeoutMs = POD_READY_TIMEOUT_MS,
  ): Promise<string> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      let pod: k8s.V1Pod;
      try {
        pod = await this.coreApi.readNamespacedPod({ name: podName, namespace });
      } catch (err: any) {
        // The pod went away while we were waiting for it — a concurrent spawn of the same
        // index recycled it, or a reaper collected it. That is a plain fact about this
        // spawn, so say it plainly instead of letting a raw k8s ApiException (HTTP headers
        // and all) surface as the reason a box could not be created.
        if (err?.code === 404 || err?.statusCode === 404) {
          throw new Error(`Pod ${podName} disappeared while waiting for it to become ready`);
        }
        throw err;
      }

      const podIP = pod.status?.podIP;
      const phase = pod.status?.phase;
      const ready =
        pod.status?.conditions?.find((c: k8s.V1PodCondition) => c.type === "Ready")?.status ===
        "True";

      if (phase === "Running" && ready && podIP) {
        return `https://${podIP}:3000`;
      }

      if (phase === "Failed" || phase === "Unknown") {
        throw new Error(`Pod ${podName} failed to start: ${phase}`);
      }

      // Wait 1 second before retrying
      await new Promise((r) => setTimeout(r, 1000));
    }

    throw new Error(`Pod ${podName} did not become ready within ${timeoutMs}ms`);
  }

  /**
   * Wait for a pod to be fully deleted
   */
  private async waitForPodDeleted(
    podName: string,
    namespace: string,
    timeoutMs = 30000,
  ): Promise<void> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      try {
        await this.coreApi.readNamespacedPod({ name: podName, namespace });
        // Still exists, wait
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err: any) {
        if (err.code === 404 || err.statusCode === 404) {
          return; // Pod is gone
        }
        throw err;
      }
    }
    console.warn(`[k8s-spawner] Pod ${podName} not fully deleted within ${timeoutMs}ms, proceeding anyway`);
  }

  /**
   * Stop an AgentBox
   */
  async stop(boxId: string): Promise<void> {
    const { namespace, labelPrefix } = this.config;

    console.log(`[k8s-spawner] Stopping pod: ${boxId}`);

    try {
      await this.coreApi.deleteNamespacedPod({ name: boxId, namespace });
    } catch (err: any) {
      if (err.code !== 404 && err.statusCode !== 404) {
        throw err;
      }
      // Pod does not exist, ignore.
    }

    // 🔴 The certificate Secret is NOT deleted here. It belongs to the agent, not to this
    // pod, so stopping one box says nothing about whether it is still in use — and any
    // "does the agent still have pods?" check is a point-in-time read that races the spawn
    // of a replacement: the Secret is created BEFORE its pod, so a concurrent stop of the
    // last old box would see no sibling, delete it, and leave the new pod stuck in
    // ContainerCreating forever on a missing volume (restartPolicy is Never).
    //
    // `sweepOrphans` owns Secret lifetime instead. It has the age guard that closes exactly
    // this race and can see the whole namespace at once.
  }

  /**
   * Periodic orphan GC for CAPABILITY boxes (kb-compile variants / kb-test) + their cert
   * Secrets. Two orphan shapes (audit finding — both accumulate forever):
   *   - a pod in a terminal phase (Succeeded/Failed): its process exited, a
   *     capability run never reuses a pod;
   *   - a RUNNING pod whose run is no longer live (`isLive(boxId)` false): the
   *     aiohttp server idles on after its run ended — the shape a normally-
   *     completed run used to leave behind (the relay-close stop now covers
   *     the common path; this sweep covers crashes, runtime restarts, and
   *     pre-existing debris).
   * A RUNNING chat agent box (boxType "agent") is never touched — its idle
   * self-destruct owns that lifecycle, and the `isLive` oracle is scoped to
   * capability runs, so it cannot speak for a chat agent at all. A TERMINAL one is
   * reaped: `restartPolicy: Never` plus the clean exit that self-destruct performs
   * leaves the pod `Succeeded` forever, and the next spawn creates a fresh pod under
   * the same name rather than reviving it. Nothing else collects those.
   */
  async sweepOrphans(isLive: (runRef: string) => boolean | Promise<boolean>): Promise<void> {
    const { namespace, labelPrefix } = this.config;
    const selector = `${labelPrefix}/app=agentbox`;
    const capabilityTypes = new Set(["kb-compile", "kb-compile-codex", "kb-test"]);
    const pods = await this.coreApi.listNamespacedPod({ namespace, labelSelector: selector });
    const keptPods = new Set<string>();
    // Agents that still have at least one pod after this sweep. A cert Secret now belongs to
    // the AGENT, so pod-name matching can no longer decide whether it is in use.
    const liveAgents = new Set<string>();
    // Pods this sweep actually removed. `pods.items` is the pre-sweep snapshot, so without
    // this a just-reaped pod would still "exist" and shield its own Secret for another
    // round — which used to be masked by stop() deleting the Secret itself.
    const removedPods = new Set<string>();
    for (const pod of pods.items ?? []) {
      const name = pod.metadata?.name;
      if (!name) continue;
      const boxType = pod.metadata?.labels?.[`${labelPrefix}/boxType`] || "agent";
      const phase = pod.status?.phase;
      const terminal = phase === "Succeeded" || phase === "Failed";
      const agentOf = pod.metadata?.labels?.[`${labelPrefix}/agent`];
      if (!capabilityTypes.has(boxType)) {
        if (!terminal) {
          keptPods.add(name); // live chat box — not ours to manage
          if (agentOf) liveAgents.add(agentOf); // …and its agent's Secret stays
          continue;
        }
        console.log(`[k8s-spawner] orphan sweep: removing terminal chat box ${name} (phase=${phase})`);
        try {
          await this.stop(name);
          removedPods.add(name);
        } catch (err: any) {
          console.warn(`[k8s-spawner] orphan sweep: stop ${name} failed:`, err?.message ?? err);
          keptPods.add(name);
          if (agentOf) liveAgents.add(agentOf); // still there → keep its Secret
        }
        continue;
      }
      // Hand the oracle the RAW run id from the pod's `agent` label (stamped at
      // spawn), not the pod name: podName() sanitizes/lowercases/truncates, so
      // reconstructing the id by prefix-strip is exact only for the minted
      // lowercase-UUID shape — an adopted/consumer-recovered id that doesn't
      // round-trip would miss both the memory and store lookups and reap a
      // LIVE box (review). Name stays the fallback for label-less debris.
      const runRef = pod.metadata?.labels?.[`${labelPrefix}/agent`] || name;
      const live = !terminal && (await isLive(runRef));
      if (live) {
        keptPods.add(name);
        if (agentOf) liveAgents.add(agentOf);
        continue;
      }
      console.log(`[k8s-spawner] orphan sweep: removing ${name} (phase=${phase ?? "?"}, live=${live})`);
      try {
        await this.stop(name);
        removedPods.add(name);
      } catch (err: any) {
        console.warn(`[k8s-spawner] orphan sweep: stop ${name} failed:`, err?.message ?? err);
        keptPods.add(name);
        if (agentOf) liveAgents.add(agentOf);
      }
    }
    // Cert Secrets whose pod is gone entirely (e.g. pod deleted out-of-band, or an
    // agent that no longer exists). Chat-box Secrets are now in scope too: nothing
    // else ever collected them, so they accumulated for as long as the deployment
    // had been running. Deleting one is recoverable by construction — the next
    // spawn mints a fresh certificate under the same name.
    //
    // An unlabelled boxType reads as "agent", matching the pod pass, so cert
    // Secrets predating the label are collected rather than pinned forever. The
    // list is already scoped to `app=agentbox`, so nothing outside this system is
    // reachable from here.
    //
    // 🔴 A Secret is matched to its owner by the `agent` LABEL, not by stripping "-cert"
    // off its name. The Secret is now per-agent while pods are per-replica, so the name of
    // `agentbox-foo-cert` corresponds to instance 0 alone: if instance 0 were gone while
    // instance 1 still ran, name-matching would delete the certificate instance 1 has
    // mounted. Name-stripping survives only as the fallback for label-less debris.
    //
    // The age guard closes the spawn TOCTOU: Secrets are created BEFORE their pod, so a
    // just-spawned box's cert must never be swept between the two creates. It is also what
    // makes it safe for `stop()` to leave Secret lifetime entirely to this sweep.
    const secrets = await this.coreApi.listNamespacedSecret({ namespace, labelSelector: selector });
    const minAgeMs = 10 * 60_000;
    const sweepableTypes = new Set([...capabilityTypes, "agent"]);
    for (const s of secrets.items ?? []) {
      const name = s.metadata?.name;
      if (!name || !name.endsWith("-cert")) continue;
      if (!sweepableTypes.has(s.metadata?.labels?.[`${labelPrefix}/boxType`] || "agent")) continue;
      // Missing/unparseable creationTimestamp must read as YOUNG, not ancient
      // (review: the `: 0` fallback made it look infinitely old, silently
      // bypassing the TOCTOU age guard). Skip it this round — a real orphan
      // will still be old next sweep.
      const createdMs = s.metadata?.creationTimestamp ? new Date(s.metadata.creationTimestamp).getTime() : NaN;
      if (!Number.isFinite(createdMs) || Date.now() - createdMs < minAgeMs) continue;
      const secretAgent = s.metadata?.labels?.[`${labelPrefix}/agent`];
      if (secretAgent) {
        if (liveAgents.has(secretAgent)) continue; // some box of this agent survives
      } else {
        if (keptPods.has(name.slice(0, -"-cert".length))) continue;
        const base = name.slice(0, -"-cert".length);
        if (!removedPods.has(base) && pods.items?.some((p: any) => p.metadata?.name === base)) continue;
      }
      console.log(`[k8s-spawner] orphan sweep: removing orphaned Secret ${name}`);
      try {
        await this.coreApi.deleteNamespacedSecret({ name, namespace });
      } catch (err: any) {
        if (err?.code !== 404 && err?.statusCode !== 404) {
          console.warn(`[k8s-spawner] orphan sweep: delete Secret ${name} failed:`, err?.message ?? err);
        }
      }
    }
  }

  /**
   * Get AgentBox information
   */
  /**
   * Fingerprint of the CA this spawner currently signs AgentBox certs with.
   * Undefined before setCertManager() runs. The manager compares it to a pod's
   * stamped `ca-fp` label to decide whether the pod is still reachable over mTLS.
   */
  /** True when session transcripts land on the shared PVC rather than a per-pod emptyDir. */
  hasSharedSessionStorage(): boolean {
    return !!this.config.persistence?.claimName;
  }

  caFingerprint(): string | undefined {
    return this.certManager?.caFingerprint();
  }

  async get(boxId: string): Promise<AgentBoxInfo | null> {
    const { namespace, labelPrefix } = this.config;

    try {
      const pod = await this.coreApi.readNamespacedPod({ name: boxId, namespace });

      // 🔴 THROUGH toBoxInfo, never hand-rolled. This function used to build the same shape
      // field by field, and the copy fell behind: it never carried `certExpiresAt`, so the
      // SINGLE-BOX acquisition path (getOrCreateK8s reads a box through get()) saw "expiry
      // unknown", read that as usable — correctly, that is the fail-open rule — and went on
      // returning an endpoint mTLS could no longer complete. The certificate fix was
      // therefore inert for exactly the agents that run one box.
      //
      // This is the SECOND time a second projection caused that class of bug; the first cost
      // a spawn loop when list() omitted the CA fingerprint, which is why toBoxInfo says
      // ONE mapper on purpose. `boxId` stays the argument rather than the pod's name so the
      // lookup answers about the name it was asked about.
      return { ...this.toBoxInfo(pod), boxId };
    } catch (err: any) {
      if (err.code === 404 || err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  /** Replica index + running image, read off a pod. Absent label ⇒ instance 0 (pre-replica). */
  private replicaFields(pod: any): { instance: number; image: string | undefined } {
    const { labelPrefix } = this.config;
    const raw = pod.metadata?.labels?.[`${labelPrefix}/instance`];
    const parsed = raw === undefined ? 0 : Number(raw);
    return {
      instance: Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0,
      image: pod.spec?.containers?.[0]?.image,
    };
  }

  /**
   * Every box currently existing for an agent.
   *
   * The pool is DISCOVERED, never remembered: the spawner holds no registry, so a Runtime
   * restart re-derives the same answer from the cluster instead of resuming from state
   * that may have gone stale while it was down.
   */
  async listForAgent(agentId: string): Promise<AgentBoxInfo[]> {
    const { namespace, labelPrefix } = this.config;
    const pods = await this.coreApi.listNamespacedPod({
      namespace,
      labelSelector: `${labelPrefix}/app=agentbox,${labelPrefix}/agent=${agentId}`,
    });
    return (pods.items ?? []).flatMap((pod: k8s.V1Pod) => {
      if (!pod.metadata?.name) return [];
      // agentId comes from the label like everywhere else; the selector already scoped
      // this query to one agent, so the two always agree.
      return [this.toBoxInfo(pod)];
    });
  }

  /**
   * The image a box for this profile WOULD be spawned with — the comparison target for
   * spotting a pod a deploy left behind. Same precedence as spawn().
   */
  expectedImage(profile?: string): string {
    return getBoxProfile(profile).image ?? this.config.image;
  }

  /**
   * List all AgentBoxes
   */
  async list(): Promise<AgentBoxInfo[]> {
    const { namespace, labelPrefix } = this.config;

    const podList = await this.coreApi.listNamespacedPod({
      namespace,
      labelSelector: `${labelPrefix}/app=agentbox`,
    });

    return podList.items.map((pod: k8s.V1Pod) => this.toBoxInfo(pod));
  }

  /**
   * Map Pod phase to AgentBoxStatus
   */
  /**
   * Whether this pod's process ended without being asked to.
   *
   * `Failed` is the kubelet's word for "the container exited non-zero and nothing asked
   * it to" — a crash, an OOM kill, an eviction. A clean exit (idle self-destruct) lands
   * in `Succeeded`, and a pod being deleted still reports its old phase, so this stays
   * false for the shutdowns the runtime itself started.
   */
  private exitedUnexpectedly(pod: k8s.V1Pod): boolean {
    if (pod.metadata?.deletionTimestamp) return false;
    return pod.status?.phase === "Failed";
  }

  /**
   * Pod → AgentBoxInfo, for every path that reports a box.
   *
   * ONE mapper on purpose. `list()` used to return a lighter projection without the CA
   * fingerprint or the image, which was harmless while only acquisition judged staleness —
   * and became a spawn loop the moment the reaper judged it too: a box with no fingerprint
   * reads as signed by a CA we no longer trust, so every freshly created box was drained
   * on sight and replaced by another that met the same fate.
   */
  private toBoxInfo(pod: k8s.V1Pod): AgentBoxInfo {
    const { labelPrefix } = this.config;
    const podIP = pod.status?.podIP;
    return {
      boxId: pod.metadata?.name || "",
      agentId: pod.metadata?.labels?.[`${labelPrefix}/agent`] || "",
      status: this.mapPodStatus(pod),
      exitedUnexpectedly: this.exitedUnexpectedly(pod),
      endpoint: podIP ? `https://${podIP}:3000` : "",
      createdAt: pod.metadata?.creationTimestamp ? new Date(pod.metadata.creationTimestamp) : new Date(),
      lastActiveAt: new Date(),
      caFingerprint: pod.metadata?.labels?.[`${labelPrefix}/ca-fp`],
      certExpiresAt: parseCertExpiryLabel(pod.metadata?.labels?.[`${labelPrefix}/cert-exp`]) ?? undefined,
      profile: pod.metadata?.labels?.[`${labelPrefix}/boxType`] || "agent",
      ...this.replicaFields(pod),
    };
  }

  private mapPodStatus(pod: k8s.V1Pod): AgentBoxStatus {
    // Terminating pods (deletionTimestamp set) may still report
    // phase=Running and Ready=True during the grace period, but their
    // podIP is on its way out — treat them as stopped so callers that
    // filter on status="running" (e.g. agent.reload) skip them.
    if (pod.metadata?.deletionTimestamp) return "stopped";

    const phase = pod.status?.phase;
    const ready = pod.status?.conditions?.find((c) => c.type === "Ready")?.status === "True";

    switch (phase) {
      case "Pending":
        return "starting";
      case "Running":
        return ready ? "running" : "starting";
      case "Succeeded":
      case "Failed":
        return "stopped";
      default:
        return "error";
    }
  }

  /**
   * Clean up all AgentBoxes
   */
  async cleanup(): Promise<void> {
    const { namespace, labelPrefix } = this.config;

    console.log(`[k8s-spawner] Cleaning up all agentbox pods in namespace: ${namespace}`);

    // Delete all AgentBox Pods
    await this.coreApi.deleteCollectionNamespacedPod({
      namespace,
      labelSelector: `${labelPrefix}/app=agentbox`,
    });

    // Delete all cert Secrets
    await this.coreApi.deleteCollectionNamespacedSecret({
      namespace,
      labelSelector: `${labelPrefix}/app=agentbox`,
    });
  }
}
