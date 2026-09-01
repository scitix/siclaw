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
import type { CertificateBundle } from "../security/cert-manager.js";

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

/**
 * Renew an AgentBox certificate once it has less than this left to live.
 *
 * AgentBox certs are issued for 30 days (cert-manager.ts), so 7 days means the
 * swap happens on roughly day 23 — one controlled recycle a week BEFORE the
 * cliff, instead of every box of the agent failing mTLS the moment the cert
 * lapses. The margin has to comfortably exceed how long an agent can go without
 * any box being acquired, because the renewal rides on the spawn path.
 */
export const CERT_RENEW_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Certificates re-minted in one renewal tick. Each mint is a synchronous RSA-2048
 * keygen that blocks the event loop, so this bounds how long one tick can stall the
 * runtime. See renewExpiringCertificates for why spreading a backlog is free.
 */
const MAX_CERT_RENEWALS_PER_TICK = 20;

/**
 * What an existing cert Secret's labels say about the certificate inside it:
 * who signed it (caFp) and which version it is (notBefore) / how long it lasts
 * (notAfter), both as unix SECONDS.
 *
 * Labels rather than parsing tls.crt on purpose: the reuse checks run on every
 * spawn, and this keeps them a single metadata read — the same shape and cost
 * the ca-fp check already had.
 */
interface CertSecretStamp {
  caFp?: string;
  notBefore?: number;
  notAfter?: number;
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
   * The CA fingerprint AND the certificate version stamped on an existing cert
   * Secret, or undefined if unreadable.
   *
   * ⚠️ THE CA FINGERPRINT ALONE IS NOT "still usable". It answers WHO SIGNED,
   * never WHETHER IT IS STILL VALID — and an AgentBox cert lives 30 days
   * (cert-manager.ts). Both reuse checks below used to compare only the
   * fingerprint, so a Secret whose certificate had expired under the SAME CA was
   * reused forever: the freshly minted replacement was discarded on the 409 path,
   * every pod mounted the dead cert, and mTLS failed in both directions
   * (AgentBox → Gateway as `socket hang up`, Gateway → AgentBox as `certificate
   * has expired`) with no path back except a human deleting the Secret by hand.
   * Observed in production 2026-09-01.
   *
   * notBefore doubles as the certificate's VERSION: it is what a pod is stamped
   * with, so "does this running pod hold the certificate that is current now?" is
   * a label comparison rather than a guess.
   */
  private async certSecretStamp(name: string): Promise<CertSecretStamp | undefined> {
    const { namespace, labelPrefix } = this.config;
    try {
      const s = await this.coreApi.readNamespacedSecret({ name, namespace });
      const labels = s.metadata?.labels ?? {};
      const num = (v?: string) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      return {
        caFp: labels[`${labelPrefix}/ca-fp`],
        notBefore: num(labels[`${labelPrefix}/cert-nb`]),
        notAfter: num(labels[`${labelPrefix}/cert-na`]),
      };
    } catch {
      return undefined; // unreadable ⇒ treat as stale and take the replace path
    }
  }

  /**
   * Is this Secret's certificate the current CA's AND far enough from expiry to
   * keep handing out?
   *
   * A Secret predating the cert-nb/cert-na labels reads as NOT fresh, so existing
   * deployments converge on their next spawn instead of being grandfathered into
   * the bug forever — the same discipline the unlabeled-legacy-pod branch uses.
   */
  private certStampIsFresh(stamp: CertSecretStamp | undefined, caFp: string): boolean {
    if (!stamp || stamp.caFp !== caFp) return false;
    if (stamp.notBefore === undefined || stamp.notAfter === undefined) return false;
    return stamp.notAfter * 1000 - Date.now() > CERT_RENEW_THRESHOLD_MS;
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

    // Stamp the pod + its cert Secret with the CA fingerprint. The runtime uses
    // it to detect pods whose mTLS cert was signed by a rotated CA (those can no
    // longer complete mTLS in either direction) and recycle them — see the reuse
    // branch below and AgentBoxManager.getOrCreateK8s.
    if (!this.certManager) throw new Error("CertificateManager not initialized — call setCertManager() first");
    const caFp = this.certManager.caFingerprint();
    const caFpLabel = `${labelPrefix}/ca-fp`;
    const certNbLabel = `${labelPrefix}/cert-nb`;
    const certNaLabel = `${labelPrefix}/cert-na`;
    const certReloadLabel = `${labelPrefix}/cert-reload`;

    // The mint is LAZY: a cold spawn must not hand a new pod a certificate that is
    // about to lapse, but re-minting one that is still good would churn the Secret
    // every box acquisition and, before cert-reloader.ts existed, take every running
    // pod of the agent down with it.
    //
    // ⚠️ THIS IS A BACKSTOP, NOT THE RENEWAL MECHANISM. Renewal is time-driven and
    // lives in renewExpiringCertificates() below, because expiry is a function of the
    // clock and this path is a function of TRAFFIC — and the two are unrelated. The
    // pod that triggered this fix was resident: AgentBoxManager.getOrCreateK8s warm-
    // reuses a running box and never reaches spawn() at all, so an agent could go a
    // month without this code executing once while its certificate quietly lapsed.
    //
    // The serialNumber carries the agent's BASE pod name, not this instance's: it is
    // the identity every box of the agent presents, and the Gateway uses it as the
    // authorization root when a box reports which pod it actually is (see
    // handleMetricsFlush).
    const certBase = this.podBaseName(agentId, podPrefix);
    const certSecretName = this.certSecretName(agentId, podPrefix);
    const storedStamp = await this.certSecretStamp(certSecretName);
    const storedCertIsFresh = this.certStampIsFresh(storedStamp, caFp);
    // undefined ⇒ the stored Secret is current and is left exactly as it is.
    let certBundle: CertificateBundle | undefined;
    if (!storedCertIsFresh) {
      certBundle = this.certManager.issueAgentBoxCertificate(agentId, orgId, certBase);
      const why = storedStamp === undefined
        ? "no stored Secret"
        : storedStamp.caFp !== caFp
          ? `CA rotated (secret=${storedStamp.caFp ?? "none"}, current=${caFp})`
          : storedStamp.notAfter === undefined
            ? "unstamped legacy Secret"
            : `expires in ${Math.round((storedStamp.notAfter * 1000 - Date.now()) / 86_400_000)}d`;
      console.log(`[k8s-spawner] Minting a new certificate for agent ${agentId}: ${why}`);
    }

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
      if (phase === "Failed" || phase === "Succeeded" || phase === "Unknown" || profileMismatch || terminating) {
        console.log(
          `[k8s-spawner] Removing stale pod ${podName} (phase: ${phase}, profile: ${existingProfile}→${profile.name})`,
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
        // ⚠️ DELIBERATELY THE CA ONLY, not the certificate version. An earlier draft
        // of this fix also recycled a pod whose stamped certificate version had been
        // superseded, because a process that read /etc/siclaw/certs once at startup
        // could not see a renewal. cert-reloader.ts removes that premise: both mTLS
        // consumers now re-read the mounted files, so a running pod picks up a renewed
        // certificate on its own, within seconds and without dropping a turn. Adding a
        // version comparison here would destroy healthy pods that had ALREADY healed —
        // their label still records what they mounted at startup, which is no longer
        // what they are using.
        //
        // A rotated CA is different and still recycles: the pod's certificate can no
        // longer be verified at all, and no amount of re-reading fixes that, because
        // the Secret it re-reads is signed by the same dead CA until it is replaced.
        // ⚠️ A CAPABILITY, NOT A VERSION. Renewal only works because a running pod
        // re-reads its certificate (cert-reloader.ts), and a pod from a build BEFORE
        // that shipped cannot: it read /etc/siclaw/certs once at startup and will
        // present the superseded certificate until something destroys it. Nothing
        // else will — isStaleImage compares image STRINGS, and the default
        // deployment pins `tag: latest` with `pullPolicy: Always`, so a rebuilt image
        // is byte-identical and never rolls the pod. Left alone, such a pod survives
        // the upgrade, gets its Secret renewed out from under it, and goes dark seven
        // days later: the original outage, reproduced by this fix's own renewal.
        //
        // Deliberately a capability flag rather than the certificate version an
        // earlier draft stamped here. A version goes stale the moment a pod reloads,
        // so comparing against it destroys pods that already healed themselves. A
        // capability never expires — and once every pod carries it this branch stops
        // firing forever, which is what a migration guard should do.
        if (podFp === caFp && existing.metadata?.labels?.[certReloadLabel] === "1") {
          console.log(`[k8s-spawner] Pod ${podName} already exists (phase: ${phase}), reusing`);
          const endpoint = await this.waitForPodReady(podName, namespace);
          return { boxId: podName, agentId, endpoint };
        }
        // A rotated CA (no amount of re-reading fixes a certificate that cannot be
        // chained), or a pod that predates certificate reloading. Either way it cannot
        // be kept alive across a renewal, so recycle it rather than return a dead
        // endpoint later.
        console.log(
          `[k8s-spawner] Pod ${podName} cannot survive a certificate change ` +
          `(ca: pod=${podFp ?? "none"} current=${caFp}; reloads=${existing.metadata?.labels?.[certReloadLabel] ?? "no"}); recreating`,
        );
        await this.coreApi.deleteNamespacedPod({ name: podName, namespace });
        await this.waitForPodDeleted(podName, namespace);
      }
    } catch (err: any) {
      if (err.code !== 404 && err.statusCode !== 404) {
        throw err;
      }
      // Pod doesn't exist, proceed to create
    }

    // Write the certificate Secret, unless the stored one is already current.
    //
    // ⚠️ THE MINTED CERTIFICATE USED TO BE DISCARDED HERE. The 409 path compared CA
    // fingerprints alone and, finding a match, kept the stored Secret whatever its
    // expiry — so once a certificate lapsed there was no path back: the pod mounted
    // the dead cert, deleting the pod changed nothing (the replacement mounted the
    // same Secret), and recovery needed a human with delete rights on the namespace.
    // The staleness decision now happens once, above, and this block only carries it
    // out. Steady-state renewal is renewExpiringCertificates()'; this is the cold-start
    // guarantee that a NEW pod never starts life with a certificate about to lapse.
    const secretLabels = {
      [`${labelPrefix}/app`]: "agentbox",
      [`${labelPrefix}/agent`]: agentId,
      [caFpLabel]: caFp,
      // boxType scopes the orphan sweep: without it the Secret pass could not
      // tell a capability box's cert from a chat box's (review finding).
      [`${labelPrefix}/boxType`]: profile.name,
    };
    const secretBodyFor = (bundle: CertificateBundle): k8s.V1Secret => ({
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: certSecretName,
        labels: {
          ...secretLabels,
          // Unix SECONDS, so the reuse checks stay label reads. notBefore is also the
          // certificate's VERSION — the pod is stamped with it, which is how a pod
          // still holding a superseded certificate is recognised.
          [certNbLabel]: String(Math.floor(bundle.identity.issuedAt.getTime() / 1000)),
          [certNaLabel]: String(Math.floor(bundle.identity.expiresAt.getTime() / 1000)),
        },
      },
      type: "kubernetes.io/tls",
      data: {
        "tls.crt": Buffer.from(bundle.cert).toString("base64"),
        "tls.key": Buffer.from(bundle.key).toString("base64"),
        "ca.crt": Buffer.from(bundle.ca).toString("base64"),
      },
    });

    if (certBundle) {
      try {
        await this.coreApi.createNamespacedSecret({ namespace, body: secretBodyFor(certBundle) });
        console.log(`[k8s-spawner] Created certificate Secret ${certSecretName}`);
      } catch (err: any) {
        if (err.code === 409 || err.statusCode === 409) {
          // 🔴 The Secret is per-AGENT, so two replicas of one agent spawning at the same
          // time both land here — and blindly replacing it would delete a certificate a
          // sibling pod is already mounting, or race the sibling's own replace (observed as
          // a 404 on the second delete).
          //
          // Re-read rather than assume: between our decision above and this write a
          // sibling may have renewed it. If what is stored is now fresh, ADOPT it —
          // replacing would mint a second new certificate seconds after the first and
          // force another recycle of pods that are already correct. Our own bundle is
          // dropped, which is safe here precisely because the stored one is verified
          // fresh, not merely same-CA.
          const raced = await this.certSecretStamp(certSecretName);
          if (this.certStampIsFresh(raced, caFp)) {
            console.log(`[k8s-spawner] Adopting certificate Secret ${certSecretName} renewed concurrently`);
          } else {
            // Genuinely stale — rotated CA, expiring, or unstamped. Every pod of this
            // agent is being recreated for that same reason, so replacing is safe. The
            // delete is 404-tolerant because a sibling replica may have replaced it first.
            try {
              await this.coreApi.deleteNamespacedSecret({ name: certSecretName, namespace });
            } catch (delErr: any) {
              if (delErr?.code !== 404 && delErr?.statusCode !== 404) throw delErr;
            }
            try {
              await this.coreApi.createNamespacedSecret({ namespace, body: secretBodyFor(certBundle) });
              console.log(`[k8s-spawner] Replaced certificate Secret ${certSecretName}`);
            } catch (recreateErr: any) {
              // A sibling won the race and already recreated it under the current CA.
              if (recreateErr?.code !== 409 && recreateErr?.statusCode !== 409) throw recreateErr;
            }
          }
        } else {
          throw err;
        }
      }
    } else {
      console.log(
        `[k8s-spawner] Reusing certificate Secret ${certSecretName} ` +
        `(current CA, ${Math.round((storedStamp!.notAfter! * 1000 - Date.now()) / 86_400_000)}d before expiry)`,
      );
    }

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
        // Embedding endpoint for the memory indexer. The agentbox reads these via
        // loadConfig() env overrides (config.ts); set on the runtime deployment to
        // configure every normal AgentBox it spawns.
        "SICLAW_EMBEDDING_BASE_URL",
        "SICLAW_EMBEDDING_MODEL",
        "SICLAW_EMBEDDING_DIMENSIONS",
        "SICLAW_EMBEDDING_API_KEY",
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
          // This image re-reads its certificate, so a renewal reaches it without a
          // restart. Read by the reuse check above to recycle pods from builds that
          // cannot. Deliberately NOT the certificate version or expiry: those go out
          // of date the moment the pod reloads, and would then be believed.
          [certReloadLabel]: "1",
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
            startupProbe: { ...healthProbe, periodSeconds: 2, failureThreshold: 30 },
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
   * Wait for Pod to be Ready and obtain its IP
   */
  private async waitForPodReady(
    podName: string,
    namespace: string,
    timeoutMs = 60000,
  ): Promise<string> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const pod = await this.coreApi.readNamespacedPod({ name: podName, namespace });

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
   * Re-mint every AgentBox certificate that is inside the renewal window.
   *
   * ⚠️ THIS IS THE RENEWAL MECHANISM. spawn()'s check is only a backstop, and on its
   * own it does not fix the outage this exists for: AgentBoxManager.getOrCreateK8s
   * warm-reuses a running box (`isCertFresh`, which compares the CA fingerprint
   * alone) and never calls spawn(), so a pod kept alive by live sessions (idle
   * self-destruct defaults to 300s but is deferred for as long as work keeps arriving)
   * can run the whole 30-day life of its certificate without the spawn path executing
   * once. Certificate
   * expiry is a function of the CLOCK; hanging renewal off a traffic-driven path
   * meant the agents least likely to be recycled were exactly the ones that went
   * dark.
   *
   * NOTHING IS RECYCLED HERE, and that is the point of doing it early. At the moment
   * of renewal the old certificate is still valid for another CERT_RENEW_THRESHOLD_MS,
   * so every running pod keeps working while cert-reloader.ts picks the new material
   * off the mounted volume within seconds. The swap costs no restart, no dropped turn
   * and no cold start — as against the alternative of deleting pods, which is what a
   * renewal had to mean before the consumers could re-read.
   *
   * Runs on the same tick as sweepOrphans and reads the same Secret list; the cost is
   * one extra label comparison per Secret.
   */
  async renewExpiringCertificates(): Promise<void> {
    const { namespace, labelPrefix } = this.config;
    if (!this.certManager) return; // non-mTLS deployment; nothing to renew
    const caFp = this.certManager.caFingerprint();
    const selector = `${labelPrefix}/app=agentbox`;

    // ⚠️ ONLY AGENTS THAT STILL HAVE A POD. Renewing a certificate nothing mounts is
    // not merely wasted work — combined with the sweep now skipping anything still
    // valid, it would make the Secret IMMORTAL: renewal keeps pushing its expiry out,
    // so the sweep never sees an expired one to collect, and an orphan accumulates
    // forever. That is the exact leak the sweep exists to prevent.
    //
    // Nothing is lost by skipping them. A certificate matters only to a process
    // holding it; if the agent spawns again, spawn() mints a fresh one, and if it
    // never does, the certificate lapses and the sweep collects it as designed.
    const pods = await this.coreApi.listNamespacedPod({ namespace, labelSelector: selector });
    const agentsWithPods = new Set<string>();
    for (const pod of pods.items ?? []) {
      // Succeeded/Failed pods hold nothing open. Counting one would renew a
      // certificate about to be collected anyway and — through the still-valid skip
      // in sweepOrphans — postpone that collection by a whole certificate lifetime.
      const phase = pod.status?.phase;
      if (phase === "Succeeded" || phase === "Failed") continue;
      const owner = pod.metadata?.labels?.[`${labelPrefix}/agent`];
      if (owner) agentsWithPods.add(owner);
    }

    const secrets = await this.coreApi.listNamespacedSecret({ namespace, labelSelector: selector });

    // ⚠️ BOUNDED PER TICK. issueAgentBoxCertificate generates an RSA-2048 key with
    // generateKeyPairSync, which BLOCKS the event loop — the Gateway's included. In
    // steady state renewals are spread naturally across issue dates and this cap is
    // never reached, but the first tick after an upgrade sees every unstamped Secret
    // at once (see the dueNow branch), and a large deployment renewing all of them in
    // one pass would stall the runtime for seconds.
    //
    // Spreading costs nothing: the renewal window is CERT_RENEW_THRESHOLD_MS wide and
    // the tick is ten minutes, so roughly a thousand ticks are available to drain a
    // backlog before the earliest certificate is in any danger.
    let renewedThisTick = 0;

    for (const secret of secrets.items ?? []) {
      if (renewedThisTick >= MAX_CERT_RENEWALS_PER_TICK) {
        console.log(
          `[k8s-spawner] Certificate renewal cap (${MAX_CERT_RENEWALS_PER_TICK}) reached; continuing next tick`,
        );
        break;
      }
      const name = secret.metadata?.name;
      const agentId = secret.metadata?.labels?.[`${labelPrefix}/agent`];
      if (!name || !name.endsWith("-cert") || !agentId) continue;
      if (!agentsWithPods.has(agentId)) continue;

      const labels = secret.metadata?.labels ?? {};
      const num = (v?: string) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : undefined;
      };
      const stamp: CertSecretStamp = {
        caFp: labels[`${labelPrefix}/ca-fp`],
        notBefore: num(labels[`${labelPrefix}/cert-nb`]),
        notAfter: num(labels[`${labelPrefix}/cert-na`]),
      };

      // A rotated CA is NOT this pass's business: replacing that Secret here would
      // hand a live pod material signed by a CA it cannot chain, while the pods that
      // must be recreated for the rotation are recreated by spawn(). Renewal is only
      // ever "same CA, running out of time".
      if (stamp.caFp !== caFp) continue;
      // ⚠️ AN UNSTAMPED SECRET IS DUE NOW, not deferred to spawn().
      //
      // An earlier draft skipped these and said spawn() would replace them "on the
      // agent's next cold start" — which contradicts the very premise of this method:
      // a resident agent never cold-starts. Every Secret written before this build is
      // unstamped, including the one from the outage this fixes, so skipping them
      // meant the pods that actually went dark were precisely the ones renewal never
      // looked at. It would have shipped as a fix that could not fix the incident.
      //
      // Treating undefined as expired needs no tls.crt parsing and is self-clearing:
      // one renewal stamps the Secret and it never lands here again.
      const dueNow = stamp.notAfter === undefined
        || stamp.notAfter * 1000 - Date.now() <= CERT_RENEW_THRESHOLD_MS;
      if (!dueNow) continue;

      // Carry the SUBJECT forward from the certificate being replaced rather than
      // reconstructing it. The org is recorded nowhere on the Secret, and minting a
      // renewal with an empty one would silently rewrite the identity every box of
      // this agent presents. Read from the certificate itself, not verifyCertificate:
      // that one refuses to speak about a certificate outside its validity window,
      // which is precisely the certificate a renewal is for.
      const storedPem = secret.data?.["tls.crt"]
        ? Buffer.from(secret.data["tls.crt"], "base64").toString("utf-8")
        : undefined;
      const asserted = storedPem ? this.certManager.readAssertedIdentity(storedPem) : undefined;
      if (!asserted) {
        console.warn(`[k8s-spawner] Cannot read the subject of ${name}; leaving it for spawn() to replace`);
        continue;
      }
      // ⚠️ CROSS-CHECK THE SUBJECT AGAINST THE SECRET'S OWN LABEL BEFORE SIGNING IT.
      // readAssertedIdentity reads what the stored certificate CLAIMS — it verifies
      // neither signature nor validity, by design. Without this check, anyone able to
      // write this Secret's data (namespace Secret write, which does NOT require
      // reading the CA key) could plant a certificate claiming another agent's
      // identity and have the next renewal tick sign that identity with the real CA,
      // into a Secret they control. The label is set by the spawner and is the
      // independent witness. Free: agentId was already read above.
      const expectedBoxId = name.slice(0, -"-cert".length);
      if (asserted.agentId !== agentId || asserted.boxId !== expectedBoxId) {
        console.warn(
          `[k8s-spawner] Refusing to renew ${name}: stored certificate asserts ` +
          `agent=${asserted.agentId} box=${asserted.boxId}, Secret says agent=${agentId} box=${expectedBoxId}`,
        );
        continue;
      }
      // boxId is the certificate's serialNumber and must survive verbatim: the Gateway
      // authorizes a box's metrics flush against it (handleMetricsFlush).
      const bundle = this.certManager.issueAgentBoxCertificate(asserted.agentId, asserted.orgId, asserted.boxId);
      const why = stamp.notAfter === undefined
        ? "unstamped"
        : `${Math.round((stamp.notAfter * 1000 - Date.now()) / 86_400_000)}d from expiry`;
      try {
        // Replace in place: same name, same labels bar the new validity, so every pod
        // already mounting it sees new bytes at the same path with no rescheduling.
        await this.coreApi.replaceNamespacedSecret({
          name,
          namespace,
          body: {
            apiVersion: "v1",
            kind: "Secret",
            // ⚠️ SPREAD THE STORED METADATA, do not rebuild it. A replace whose
            // metadata carries no resourceVersion is an UNCONDITIONAL overwrite that
            // can never return 409, so a hand-built metadata block would make the
            // conflict handling below describe something that cannot happen — and
            // would silently clobber a concurrent writer (a spawn mid CA-rotation
            // being the case that actually matters). Carrying it forward also keeps
            // annotations and ownerReferences that other machinery may have set.
            metadata: {
              ...secret.metadata,
              name,
              labels: {
                ...labels,
                [`${labelPrefix}/cert-nb`]: String(Math.floor(bundle.identity.issuedAt.getTime() / 1000)),
                [`${labelPrefix}/cert-na`]: String(Math.floor(bundle.identity.expiresAt.getTime() / 1000)),
              },
            },
            type: "kubernetes.io/tls",
            data: {
              "tls.crt": Buffer.from(bundle.cert).toString("base64"),
              "tls.key": Buffer.from(bundle.key).toString("base64"),
              "ca.crt": Buffer.from(bundle.ca).toString("base64"),
            },
          },
        });
        renewedThisTick++;
        console.log(
          `[k8s-spawner] Renewed certificate Secret ${name} for agent ${agentId} (was ${why})`,
        );
      } catch (err: any) {
        // One Secret's failure must not abandon the rest of the pass. A 409 here is
        // real — the metadata spread above carries resourceVersion, so a concurrent
        // spawn replacing this Secret loses this write rather than being clobbered by
        // it — and retrying is free: the next tick is ten minutes away against a
        // renewal window measured in days.
        console.warn(`[k8s-spawner] Renewing certificate Secret ${name} failed:`, err?.message ?? err);
      }
    }
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
      // ⚠️ A STILL-VALID CERTIFICATE IS NOT DEBRIS. spawn() leaves a current Secret
      // untouched instead of rewriting it, so the age guard above — which assumes a
      // spawning box's Secret was just created — no longer covers it: an agent with
      // no pods yet (the state a cold spawn starts from) could have its perfectly good
      // Secret swept out from under the pod being created, leaving that pod stuck on a
      // missing volume forever, exactly as stop()'s comment warns.
      //
      // Skipping anything still valid closes that by construction rather than by
      // narrowing: spawn skips writing only when there is more than
      // CERT_RENEW_THRESHOLD_MS left, which implies what is tested here, so the two
      // sets cannot intersect. An unstamped or expired Secret stays sweepable — those
      // are the ones that really are debris.
      // ⚠️ ONLY FOR PER-AGENT SECRETS. A chat agent's Secret is REUSED across spawns
      // (spawn leaves a current one untouched), which is what stripped it of the age
      // guard's protection and made this skip necessary. A capability box's Secret is
      // per-RUN — `kbc-box-<runId>-cert`, freshly written on every spawn — so the age
      // guard always covered it and it never needed this. Applying the skip there
      // would pin every finished run's Secret for a full certificate lifetime and
      // rebuild the pile-up this sweep exists to prevent.
      if ((s.metadata?.labels?.[`${labelPrefix}/boxType`] || "agent") === "agent") {
        const secretNotAfter = Number(s.metadata?.labels?.[`${labelPrefix}/cert-na`]);
        if (Number.isFinite(secretNotAfter) && secretNotAfter * 1000 > Date.now()) continue;
      }
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

      const agentId = pod.metadata?.labels?.[`${labelPrefix}/agent`] || "";
      const status = this.mapPodStatus(pod);
      const podIP = pod.status?.podIP;

      return {
        boxId,
        agentId,
        status,
        exitedUnexpectedly: this.exitedUnexpectedly(pod),
        endpoint: podIP ? `https://${podIP}:3000` : "",
        createdAt: pod.metadata?.creationTimestamp
          ? new Date(pod.metadata.creationTimestamp)
          : new Date(),
        lastActiveAt: new Date(),
        caFingerprint: pod.metadata?.labels?.[`${labelPrefix}/ca-fp`],
        profile: pod.metadata?.labels?.[`${labelPrefix}/boxType`] || "agent",
        ...this.replicaFields(pod),
      };
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
