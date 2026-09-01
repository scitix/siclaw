/**
 * AgentBox Manager
 *
 * Manages the lifecycle of AgentBoxes keyed on `agentId`. One AgentBox pod
 * per agent serves every user who addresses that agent; per-user state is
 * threaded in request-scoped `sessionId`, not in the pod identity.
 *
 * - K8s: stateless, queries K8s API each time (no in-memory cache)
 * - Local dev: in-memory cache for fast lookups
 */

import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo } from "./types.js";
import { getBoxProfile } from "./box-profile.js";
import { BoxBindings } from "./box-bindings.js";
import { normalizeReplicas } from "../../core/config.js";

/** What a box reports about itself (see the agentbox `/api/internal/box-status` route). */
export interface BoxStatusReport {
  sessionIds: string[];
  turnsInFlight: number;
  drained: boolean;
}

/**
 * How long a placement sample stays usable. Placement wants a RECENT reading, not a fresh
 * one — and affinity means most turns never sample at all.
 */
const BOX_STATUS_TTL_MS = 2_000;

/** How long a draining box may keep work before it is removed anyway. */
const DRAIN_DEADLINE_MS = 5 * 60_000;

/**
 * How long before a box that crashed is replaced again.
 *
 * A box killed by the thing that will kill its replacement — an OOM on a prompt that
 * rebuilds the same context — would otherwise be respawned every reaper tick, turning one
 * bad session into a loop against the K8s API. Long enough that the loop is slow, short
 * enough that a one-off crash costs a fraction of a minute of capacity.
 */
const CRASH_RESPAWN_COOLDOWN_MS = 2 * 60_000;

/**
 * Drains one agent may start inside {@link DRAIN_BUDGET_WINDOW_MS} before the runtime
 * stops and says so.
 *
 * Not a policy — a fuse. Every reason to drain a box is followed by creating another, so
 * a judgement that is wrong about a FRESH box (it reads as stale, so it is replaced, and
 * the replacement reads the same way) spins until someone notices. A whole pool rolling,
 * or a CA rotation touching every box at once, stays well under this.
 */
const DRAIN_BUDGET = 8;
const DRAIN_BUDGET_WINDOW_MS = 10 * 60_000;

/** How long a slot must go without crashing before its history is forgotten. */
const CRASH_RESPAWN_FORGET_MS = 60 * 60_000;

/** Crashes of one instance before the runtime stops replacing it and says so. */
const CRASH_RESPAWN_LIMIT = 3;

/** How often drained boxes are collected. */
const DRAIN_REAP_INTERVAL_MS = 10_000;

/**
 * Consecutive failed status probes before a box is treated as gone rather than busy.
 *
 * A box whose event loop is permanently blocked stays pod-phase Running with a valid
 * endpoint forever, so nothing else ever removes it. Sessions that last ran there would be
 * pinned to it indefinitely — every turn dispatched to a box that cannot answer. Marking
 * it draining hands it to the reaper, which removes it at the drain deadline and frees
 * those sessions.
 */
const UNRESPONSIVE_PROBE_LIMIT = 3;

/**
 * How long a per-agent replica count stays usable.
 *
 * This is consulted on EVERY acquisition, which is once per turn from every entry point.
 * Against a local Portal that is free; against an upstream control plane it is a network
 * round trip added to the hot path of every conversation. Ten seconds keeps a change
 * taking effect promptly — a scale-up is not an interactive operation — while collapsing
 * the steady-state cost to nearly nothing.
 */
const REPLICAS_TTL_MS = 10_000;

export interface AgentBoxManagerConfig {
  /** Health check interval (ms) — local dev only */
  healthCheckIntervalMs?: number;
  /** Maximum number of retries */
  maxRetries?: number;
  /** K8s namespace */
  namespace?: string;
}

const DEFAULT_CONFIG: Required<AgentBoxManagerConfig> = {
  healthCheckIntervalMs: 60 * 1000,
  maxRetries: 3,
  namespace: "default",
};

interface ManagedBox {
  handle: AgentBoxHandle;
  lastActiveAt: Date;
  createdAt: Date;
}

export interface AgentBoxAcquisition {
  handle: AgentBoxHandle;
  /** True only when this call created/recreated the underlying box. */
  created: boolean;
}

export class AgentBoxManager {
  private spawner: BoxSpawner;
  private config: Required<AgentBoxManagerConfig>;
  private boxes = new Map<string, ManagedBox>();
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private orphanSweepInitialTimer?: ReturnType<typeof setTimeout>;
  private orphanSweepTimer?: ReturnType<typeof setInterval>;
  private readonly isK8s: boolean;
  private spawnEnvResolver?: (agentId: string) => Promise<Record<string, string> | undefined>;
  private persistenceResolver?: (agentId: string) => Promise<boolean | undefined>;
  private replicasResolver?: (agentId: string) => Promise<number | undefined>;
  private boxStatusProbe?: (endpoint: string) => Promise<BoxStatusReport>;
  private turnTerminator?: (sessionIds: string[], reason: "box_rolled") => void;
  /** Boxes whose held turns were already reported, so a failed stop cannot report twice. */
  private interruptReported = new Set<string>();
  /** Which box serves which session. Only consulted when an agent runs more than one. */
  private readonly bindings = new BoxBindings();
  /** boxId → when it was marked draining. In memory only; re-derived after a restart. */
  private draining = new Map<string, number>();
  private statusCache = new Map<string, { at: number; status: BoxStatusReport }>();
  private replicasCache = new Map<string, { at: number; value: number }>();
  /** Consecutive failed status probes per box — see UNRESPONSIVE_PROBE_LIMIT. */
  private probeFailures = new Map<string, number>();
  /** Crashes per box, so a box that keeps dying is not respawned forever. */
  private crashRespawns = new Map<string, { count: number; at: number }>();
  /** Recent drains per agent, so a wrong staleness judgement cannot spin forever. */
  private drainBudget = new Map<string, { count: number; since: number }>();
  /** Agents already warned about pooling without shared session storage. */
  private unsharedWarned = new Set<string>();
  private legacySessionLister?: (endpoint: string) => Promise<string[]>;
  private drainReaperTimer?: ReturnType<typeof setInterval>;

  constructor(spawner: BoxSpawner, config?: AgentBoxManagerConfig) {
    this.spawner = spawner;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.isK8s = spawner.name === "k8s";
    console.log(`[agentbox-manager] Initialized with spawner: ${spawner.name}${this.isK8s ? " (stateless, K8s API discovery)" : " (in-memory cache)"}`);
  }

  setCertManager(cm: unknown): void {
    if ('setCertManager' in this.spawner) {
      (this.spawner as any).setCertManager(cm);
    }
  }

  /**
   * Periodic orphan GC for spawned boxes (K8s spawner only; duck-typed like
   * setCertManager). `isLive(boxId)` is the caller's run-liveness oracle —
   * the manager/spawner have no knowledge of capability runs, and it is consulted
   * ONLY for capability boxes; a chat box's liveness is its pod phase. First pass
   * runs one minute after boot (post-recovery, so live runs are known), then every
   * `intervalMs`. Without it, terminal pods and their cert Secrets accumulate
   * forever (audit finding).
   */
  startOrphanSweep(isLive: (boxId: string) => boolean | Promise<boolean>, intervalMs = 10 * 60_000): void {
    const s: any = this.spawner;
    if (typeof s.sweepOrphans !== "function") return;
    const tick = () => {
      void s.sweepOrphans(isLive).catch((err: any) =>
        console.warn("[agentbox-manager] orphan sweep failed:", err?.message ?? err));
      // Certificate renewal rides the same tick because it needs the same thing the
      // sweep needs — the clock — and nothing the request path can offer. It is
      // deliberately NOT folded into getOrCreate: this manager warm-reuses a running
      // box without consulting the spawner (isCertFresh compares the CA fingerprint
      // and nothing else), so a resident pod can outlive its 30-day certificate
      // without any spawn-path code executing. Independent of the sweep's outcome:
      // one failing must not silently cancel the other.
      if (typeof (s as any).renewExpiringCertificates === "function") {
        void (s as any).renewExpiringCertificates().catch((err: any) =>
          console.warn("[agentbox-manager] certificate renewal failed:", err?.message ?? err));
      }
    };
    // unref'd + stored (review finding): the sweep must never pin the event
    // loop or outlive cleanup() — same discipline as the run watchdog.
    this.orphanSweepInitialTimer = setTimeout(tick, 60_000);
    (this.orphanSweepInitialTimer as any).unref?.();
    this.orphanSweepTimer = setInterval(tick, intervalMs);
    (this.orphanSweepTimer as any).unref?.();
  }

  /**
   * Inject a resolver for per-agent spawn env. Applied on EVERY cold spawn from
   * any entry point — chat RPCs, channel webhooks (Lark/DingTalk), cron tasks —
   * because they all share this single manager instance (bootstrap-runtime).
   * Without it, whichever entry point cold-spawns the (one-per-agent) pod first
   * would otherwise win the pod's env, silently ignoring the configured value.
   * Invoked lazily — only when a pod is actually created — so warm-pod reuse
   * pays nothing. Currently supplies SICLAW_AGENTBOX_IDLE_TIMEOUT.
   */
  setSpawnEnvResolver(fn: (agentId: string) => Promise<Record<string, string> | undefined>): void {
    this.spawnEnvResolver = fn;
  }

  /**
   * How many boxes an agent should run. Undefined / <1 means one, which routes through the
   * ORIGINAL single-box path — the property that lets every earlier phase ship before this
   * field exists anywhere.
   *
   * Consulted on every acquisition, not only on a cold spawn: unlike the volume mount, the
   * pool size is something a running agent can actually change.
   */
  setReplicasResolver(fn: (agentId: string) => Promise<number | undefined>): void {
    this.replicasResolver = fn;
  }

  /**
   * How to ask a box what it is holding. Injected rather than imported so the manager owns
   * no transport, and so the drain reaper can be exercised without mTLS in tests.
   */
  /**
   * Fallback for boxes predating `box-status`: list the sessions they hold.
   *
   * Only used when the status probe fails. It cannot report in-flight turns or background
   * work, so it reports neither — but it answers the one question that decides whether a
   * session may be moved, which is the one that matters during a rollout.
   */
  setLegacySessionLister(fn: (endpoint: string) => Promise<string[]>): void {
    this.legacySessionLister = fn;
  }

  /**
   * How to report turns that this manager is about to interrupt.
   *
   * Removing a box that still holds work does end those turns — their SSE streams break —
   * but as an anonymous transport failure, indistinguishable from a network blip. Told
   * first, the Runtime can name the cause, so a user sees "a rolling upgrade interrupted
   * this, retry" instead of a bare connection error.
   */
  setTurnTerminator(fn: (sessionIds: string[], reason: "box_rolled") => void): void {
    this.turnTerminator = fn;
  }

  setBoxStatusProbe(fn: (endpoint: string) => Promise<BoxStatusReport>): void {
    this.boxStatusProbe = fn;
    if (!this.drainReaperTimer && this.isK8s) {
      this.drainReaperTimer = setInterval(() => {
        void this.reapDrainedBoxes().catch((err) =>
          console.warn("[agentbox-manager] drain reaper failed:", err));
      }, DRAIN_REAP_INTERVAL_MS);
      this.drainReaperTimer.unref?.();
    }
  }

  private async resolveReplicas(agentId: string): Promise<number> {
    if (!this.replicasResolver) return 1;
    const cached = this.replicasCache.get(agentId);
    if (cached && Date.now() - cached.at < REPLICAS_TTL_MS) return cached.value;
    try {
      const value = normalizeReplicas(await this.replicasResolver(agentId));
      this.replicasCache.set(agentId, { at: Date.now(), value });
      return value;
    } catch (err) {
      // Fail to ONE, never to many: a config lookup blip must not scale an agent up.
      // Deliberately NOT cached — a blip should be retried on the next turn, not
      // remembered for the next ten seconds.
      console.warn(`[agentbox-manager] replicas lookup failed for agent=${agentId}; using 1:`, err);
      return 1;
    }
  }

  /**
   * Inject a resolver for the per-agent PVC persistence mode. Same contract as
   * setSpawnEnvResolver: consulted on EVERY cold spawn (from any entry point —
   * chat RPCs, channel webhooks, cron tasks, abort/steer) and NEVER on warm
   * reuse. This is what makes persistence a true agent-level property: the
   * value is resolved by agentId, independent of which entry point first
   * cold-spawns the (one-per-agent) pod. Without it, only entry points that
   * happened to pass `config.persistence` would honour it, so a pod cold-spawned
   * by e.g. a Lark message would silently fall to the global default and ignore
   * the agent's configured mode. Returns undefined to fall back to the global
   * config (the spawner gates the actual mount on a claimName regardless).
   */
  setPersistenceResolver(fn: (agentId: string) => Promise<boolean | undefined>): void {
    this.persistenceResolver = fn;
  }

  startHealthCheck(): void {
    if (this.isK8s || this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => { this.runHealthCheck(); }, this.config.healthCheckIntervalMs);
    console.log(`[agentbox-manager] Health check started (interval: ${this.config.healthCheckIntervalMs}ms)`);
  }

  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * Pod / box name for a profile (+ instance).
   *
   * Naming is one-way only: **profile → podNamePrefix → pod name**. Never invert
   * prefix → profile. Several profiles share one prefix (`kb-compile` and
   * `kb-compile-codex` both use `kbc-box`), so any inverse is ill-defined and
   * previously passed `"kbc-box"` into `getBoxProfile`, which throws
   * `unknown BoxProfile: kbc-box` and aborts compile-box spawn before the pod
   * is created (production v0.3.2 / PR #466).
   *
   * Prefer the spawner's `boxIdFor` so manager and K8sSpawner cannot drift on
   * sanitization/instance rules; local/process spawners fall back to the same
   * prefix derivation.
   */
  private podName(agentId: string, profile: string | undefined, instance = 0): string {
    const spawner = this.spawner as { boxIdFor?(agentId: string, profile?: string, instance?: number): string };
    if (typeof spawner.boxIdFor === "function") {
      // Pass the real profile — boxIdFor resolves podNamePrefix itself.
      return spawner.boxIdFor(agentId, profile, instance);
    }
    const prefix = this.prefixForProfile(profile);
    const sanitized = agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
    return `${prefix}-${sanitized}-${instance}`;
  }

  /** Pod-name prefix a profile spawns under (see K8sSpawner / BoxProfile.podNamePrefix). */
  private prefixForProfile(profile: string | undefined): string {
    return getBoxProfile(profile).podNamePrefix ?? "agentbox";
  }

  private async runHealthCheck(): Promise<void> {
    for (const [key, managed] of this.boxes.entries()) {
      const info = await this.spawner.get(managed.handle.boxId);
      if (!info || info.status === "stopped" || info.status === "error") {
        console.log(`[agentbox-manager] Box ${key} is gone, removing from cache`);
        this.boxes.delete(key);
      }
    }
  }

  /**
   * Get a running AgentBox for the agent, or spawn one.
   *
   * Per-agent config — the injected `spawnEnvResolver` (env, e.g. idle timeout)
   * and `persistenceResolver` (PVC mode) — is resolved ONLY on a cold spawn,
   * never on warm-pod reuse, so the chat hot path and channel/cron paths pay no
   * RPC when the pod already exists.
   *
   * Because a pod is keyed by agentId, the persistence/env mode is resolved on
   * each cold spawn (including a cert-stale recreate) from the agent-level
   * resolver — NOT from whichever entry point happens to call first. The volume
   * mount is fixed at pod creation (K8s cannot hot-change a running pod's
   * mounts), so a configuration change applies on the agent's next cold spawn
   * (after restart/idle-release), not immediately on a warm pod.
   */
  async getOrCreate(
    agentId: string,
    config?: Partial<AgentBoxConfig>,
    sessionId?: string,
  ): Promise<AgentBoxHandle> {
    return (await this.getOrCreateWithDisposition(agentId, config, sessionId)).handle;
  }

  /**
   * Get or create a box and report ownership of the resulting resource.
   *
   * Callers that perform multi-step setup need this distinction: a failed setup
   * may clean up a box it just created, but must never delete a live box reused
   * during Runtime adoption or a warm request.
   */
  async getOrCreateWithDisposition(
    agentId: string,
    config?: Partial<AgentBoxConfig>,
    sessionId?: string,
  ): Promise<AgentBoxAcquisition> {
    if (!agentId) throw new Error("AgentBoxManager.getOrCreate requires an agentId");
    if (this.isK8s) {
      // A capability box is a per-run job, not a long-lived agent, so it never pools.
      const wantProfile = config?.profile ?? "agent";
      const replicas = wantProfile === "agent" ? await this.resolveReplicas(agentId) : 1;
      // 🔴 `replicas <= 1` takes the ORIGINAL single-box path untouched. That is what makes
      // this safe to ship before anything sets the field: an agent that has not opted in
      // executes exactly the code it did before pooling existed.
      if (replicas > 1) {
        this.warnIfSessionsAreNotShared(agentId);
        return this.getOrCreatePooled(agentId, config, sessionId, replicas);
      }
      return this.getOrCreateK8s(agentId, config, sessionId);
    }
    return this.getOrCreateLocal(agentId, config);
  }

  private async getOrCreateK8s(
    agentId: string,
    config?: Partial<AgentBoxConfig>,
    sessionId?: string,
  ): Promise<AgentBoxAcquisition> {
    const wantProfile = config?.profile ?? "agent";
    const name = this.podName(agentId, wantProfile);

    const info = await this.spawner.get(name);

    // 🔴 A single-box agent must still pick up a new AgentBox image. Nothing else does it:
    // this path compares phase, profile and CA but never the image, and a box under
    // continuous traffic never idles out to be respawned — so a Runtime rollout would
    // leave it on the old image indefinitely, which is the defect this whole change set
    // exists to fix. It cannot drain in place (the replacement would collide on this same
    // pod name), so hand the agent to the pool path with a size of one: the stale box is
    // marked draining and keeps serving what it holds, the replacement comes up under the
    // next free instance index, and new sessions go there.
    //
    // The pool then sits at instance 1 while `replicas` is 1, so the next acquisition
    // creates instance 0 again and the size reconciler drains instance 1. That costs one
    // extra pod lifecycle per rollout and converges on its own — cheaper than teaching
    // this path to find a box by label instead of by name.
    if (info && info.status === "running" && this.isStaleImage(info, wantProfile)) {
      console.log(
        `[agentbox-manager] agent=${agentId} is on a stale AgentBox image; rolling it through the pool path`,
      );
      return this.getOrCreatePooled(agentId, config, sessionId, 1);
    }

    if (info && info.status === "running" && info.endpoint && this.isCertFresh(info)) {
      const hasProfile = info.profile ?? "agent";
      if (hasProfile === wantProfile) {
        // Warm reuse: return the running pod without spawning. Per-agent config
        // (env/persistence) is NOT re-resolved here — the pod's volume mount is
        // already fixed, so a changed mode applies on the next cold spawn.
        return { handle: { boxId: name, endpoint: info.endpoint, agentId }, created: false };
      }
      // Profile changed under the same identity — reusing the old-shaped pod would
      // silently run the wrong image/tools/volumes (the historic stale-box gap).
      // Stop it and respawn with the requested profile. Fail-closed on trust.
      console.log(
        `[agentbox-manager] Profile mismatch for ${name} (running=${hasProfile}, want=${wantProfile}); respawning`,
      );
      await this.spawner.stop(name);
    }
    if (info && info.status === "running" && !this.isCertFresh(info)) {
      console.log(`[agentbox-manager] Pod for agent=${agentId} has a stale CA cert; recreating to restore mTLS`);
    }

    console.log(`[agentbox-manager] Creating new AgentBox for agent=${agentId}`);

    const resolvedEnv = await this.resolveEnv(agentId, config?.env);
    const handle = await this.spawner.spawn({
      ...config,
      agentId,
      persistence: await this.resolvePersistence(agentId, config?.persistence),
      env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
    });

    handle.agentId = agentId;
    return { handle, created: true };
  }

  /**
   * Multi-box path: keep the agent's pool at `replicas`, then route this session to one
   * box and keep it there.
   *
   * Reads the pool fresh every call rather than remembering it. The Runtime is the sole
   * writer, so there is nothing to coordinate — and re-deriving means a restart cannot
   * act on state that went stale while it was down.
   */
  private async getOrCreatePooled(
    agentId: string,
    config: Partial<AgentBoxConfig> | undefined,
    sessionId: string | undefined,
    replicas: number,
  ): Promise<AgentBoxAcquisition> {
    const wantProfile = config?.profile ?? "agent";
    const pool = await this.listPool(agentId);
    this.markStaleBoxesDraining(agentId, pool, wantProfile);
    this.bindings.retainBoxes(agentId, new Set(pool.map((b) => b.boxId)));

    const reachable = pool.filter((b) => this.isReachable(b, wantProfile));

    // Ask the boxes what they are HOLDING before deciding anything. Residency is the
    // input every rule below turns on, and two separate bugs came from branches that
    // decided first and sampled afterwards: a rollout re-placed a session that was still
    // running, and a released session was pinned to a draining box forever.
    // Ask the boxes what they are holding. A session is held while its turn runs AND
    // while background sub-agents run under it (residency is deferred until they finish),
    // so one signal covers both reasons a session may not move.
    const statuses = sessionId ? await this.sampleBoxStatuses(reachable) : new Map<string, BoxStatusReport>();
    let holder = sessionId
      ? [...statuses].find(([, st]) => st.sessionIds.includes(sessionId))?.[0]
      : undefined;

    // A box that did not answer has NOT told us it is empty. Treating silence as "holds
    // nothing" is how a session gets handed to a second box while the first is still
    // writing its transcript — during a rollout the old boxes have no box-status endpoint
    // at all, so every one of them is silent. If this session last ran on a box we cannot
    // currently ask, assume it is still there.
    if (!holder && sessionId) {
      const last = this.bindings.get(agentId, sessionId);
      // …unless we have already given up on that box (see UNRESPONSIVE_PROBE_LIMIT), in
      // which case pinning the session there would just fail every turn forever.
      const givenUp = last ? (this.probeFailures.get(last) ?? 0) >= UNRESPONSIVE_PROBE_LIMIT : false;
      if (last && !givenUp && reachable.some((b) => b.boxId === last) && !statuses.has(last)) {
        console.log(`[agentbox-manager] ${last} did not answer; keeping session ${sessionId} on it rather than assuming it is free`);
        holder = last;
      }
    }


    // Held somewhere reachable: that box has the conversation in memory and is the one
    // appending to the transcript, so nothing else may take the turn — not even a spawn.
    if (holder) {
      const box = reachable.find((b) => b.boxId === holder);
      if (box) {
        this.bindings.remember(agentId, sessionId!, box.boxId);
        return { handle: { boxId: box.boxId, endpoint: box.endpoint, agentId }, created: false };
      }
    }

    // Growing the pool normally happens in the BACKGROUND: blocking this turn on a cold
    // start would make growing the pool feel slower than not having grown it.
    //
    // "Already up" means ACCEPTING, not merely reachable. When every box is draining — a
    // rollout replacing the whole pool, or a single-box agent rolling onto a new image —
    // there is nothing to serve from, so exactly one spawn is awaited and the rest are
    // still backgrounded. Splitting it this way is what stops the wait path and the
    // background fill from both targeting the same free index.
    const missing = this.missingInstances(pool, replicas, agentId);
    const accepting = reachable.filter((b) => !this.draining.has(b.boxId));

    if (accepting.length === 0) {
      const [first, ...rest] = missing.length > 0 ? missing : this.freeInstances(pool, 1);
      const [handle] = await this.spawnInstances(agentId, config, [first]);
      if (rest.length > 0) {
        void this.spawnInstances(agentId, config, rest).catch((err) =>
          console.warn(`[agentbox-manager] background pool fill failed for agent=${agentId}:`, err));
      }
      if (handle) {
        if (sessionId) this.bindings.remember(agentId, sessionId, handle.boxId);
        return { handle, created: true };
      }
      // The spawn failed. Serving from a draining box beats failing the turn; the reaper
      // leaves it alone while it holds work.
      if (reachable.length === 0) throw new Error(`Failed to spawn an AgentBox for agent ${agentId}`);
    } else if (missing.length > 0) {
      void this.spawnInstances(agentId, config, missing).catch((err) =>
        console.warn(`[agentbox-manager] background pool fill failed for agent=${agentId}:`, err));
    }

    if (!sessionId) {
      // No session to route (admin probe, capability-style call). Prefer a box that is
      // still accepting — a draining one works but is about to be deleted.
      const box = reachable.find((b) => !this.draining.has(b.boxId)) ?? reachable[0];
      return { handle: { boxId: box.boxId, endpoint: box.endpoint, agentId }, created: false };
    }

    const placed = this.bindings.place(agentId, sessionId, this.candidatesFrom(reachable, statuses), holder);
    const chosen = placed ? reachable.find((b) => b.boxId === placed.boxId) : undefined;
    if (chosen) {
      return { handle: { boxId: chosen.boxId, endpoint: chosen.endpoint, agentId }, created: false };
    }

    const fallback = reachable[0];
    this.bindings.remember(agentId, sessionId, fallback.boxId);
    return { handle: { boxId: fallback.boxId, endpoint: fallback.endpoint, agentId }, created: false };
  }

  /**
   * Placement candidates from what the boxes reported.
   *
   * A box that did not answer must NOT read as idle. Failing to answer is what a wedged
   * box does — blocked event loop, GC thrash, OOM churn — and scoring it 0 would make
   * least-loaded placement steer every new session straight onto it. Ranked last instead,
   * so it stays usable when nothing else is.
   */
  private candidatesFrom(reachable: AgentBoxInfo[], statuses: Map<string, BoxStatusReport>) {
    return reachable.map((b) => ({
      boxId: b.boxId,
      accepting: !this.draining.has(b.boxId),
      turnsInFlight: statuses.get(b.boxId)?.turnsInFlight ?? Number.MAX_SAFE_INTEGER,
    }));
  }

  /**
   * The box currently serving a session, WITHOUT spawning anything.
   *
   * Liveness and termination must not fall back to "the instance-0 pod name": a session
   * pinned to instance 1 would read as not-running (losing stream reattachment, and
   * making a live task look orphaned), and a terminate would delete instance 0 N times
   * while the rest kept serving.
   *
   * Returns undefined when the agent has no box or the session is not bound to one —
   * which is the honest answer, not a reason to guess at instance 0.
   */
  async getForSession(agentId: string, sessionId: string, profile?: string): Promise<AgentBoxHandle | undefined> {
    const bound = this.bindings.get(agentId, sessionId);
    if (bound) {
      const info = await this.spawner.get(bound).catch(() => null);
      if (info && info.status === "running" && info.endpoint) {
        return { boxId: bound, endpoint: info.endpoint, agentId };
      }
      // The bound box is gone; fall through to the agent's remaining boxes.
    }
    for (const box of await this.listPool(agentId)) {
      if (box.status === "running" && box.endpoint && (box.profile ?? "agent") === (profile ?? "agent")) {
        return { boxId: box.boxId, endpoint: box.endpoint, agentId };
      }
    }
    return undefined;
  }

  /**
   * Say so, once, when a pool has nowhere shared to keep its sessions.
   *
   * A pool works because any box can pick up a session another box wrote down. On per-pod
   * storage each box keeps its own copy, so a session that moves finds nothing and starts
   * over — the conversation loses its memory mid-way, with nothing in any log to explain
   * it. Not fatal (a pool serving one-shot traffic never continues a session), so this
   * warns rather than refusing, but it must be impossible to hit without being told.
   */
  private warnIfSessionsAreNotShared(agentId: string): void {
    const probe = (this.spawner as { hasSharedSessionStorage?(id: string): boolean }).hasSharedSessionStorage;
    if (typeof probe !== "function" || probe.call(this.spawner, agentId)) return;
    if (this.unsharedWarned.has(agentId)) return;
    this.unsharedWarned.add(agentId);
    console.warn(
      `[agentbox-manager] agent ${agentId} runs more than one box but its session transcripts are NOT on shared ` +
      `storage — a conversation that moves between boxes will lose its history. Configure a shared volume ` +
      `(SICLAW_PERSISTENCE_CLAIM_NAME) or set replicas back to 1.`,
    );
  }

  /**
   * The box that is actually HOLDING this session, or nothing.
   *
   * Distinct from placement, and deliberately not a fallback to "any box of this agent":
   * steer, abort and clearQueue act on a turn that is already running, so a box that never
   * saw the session is not an answer — it replies 404 and the user is shown a failure they
   * did not cause. Silence is treated the way placement treats it: a box we could not ask
   * may still hold it, so a hint pointing at an unreachable-but-live box counts.
   */
  async getHolder(agentId: string, sessionId: string, profile?: string): Promise<AgentBoxHandle | undefined> {
    const wantProfile = profile ?? "agent";
    const pool = (await this.listPool(agentId)).filter((b) => this.isReachable(b, wantProfile));
    if (pool.length === 0) return undefined;
    const statuses = await this.sampleBoxStatuses(pool);
    for (const [boxId, status] of statuses) {
      if (!status.sessionIds.includes(sessionId)) continue;
      const box = pool.find((b) => b.boxId === boxId);
      if (box?.endpoint) return { boxId, endpoint: box.endpoint, agentId };
    }
    const hint = this.bindings.get(agentId, sessionId);
    if (hint && !statuses.has(hint)) {
      const box = pool.find((b) => b.boxId === hint);
      if (box?.endpoint) return { boxId: hint, endpoint: box.endpoint, agentId };
    }
    return undefined;
  }

  /** Every box of an agent, for operations that must act on the whole pool. */
  async listForAgent(agentId: string): Promise<AgentBoxInfo[]> {
    return this.listPool(agentId);
  }

  /** Stop one specific box by its pod name (as opposed to `stop(agentId)`). */
  async stopBox(boxId: string): Promise<void> {
    await this.spawner.stop(boxId);
    this.draining.delete(boxId);
    this.statusCache.delete(boxId);
  }

  /** Pool listing, when the spawner supports it (K8s only; duck-typed like setCertManager). */
  private async listPool(agentId: string): Promise<AgentBoxInfo[]> {
    const s: any = this.spawner;
    if (typeof s.listForAgent !== "function") return [];
    return (await s.listForAgent(agentId)) as AgentBoxInfo[];
  }

  /**
   * Whether a box is running an image other than the one it would be spawned with now.
   *
   * Undefined on either side means "cannot tell" — an unlabelled legacy pod, or a spawner
   * that does not report an expected image — and MUST read as fresh. Guessing stale there
   * would recycle every box on every acquisition.
   */
  private isStaleImage(box: AgentBoxInfo, wantProfile: string): boolean {
    const s: any = this.spawner;
    if (typeof s.expectedImage !== "function") return false;
    const expected = s.expectedImage(wantProfile);
    return !!expected && !!box.image && box.image !== expected;
  }

  /** A box the Runtime can talk to right now. Says nothing about whether it accepts NEW
   *  sessions — a draining box is still reachable and still serves what it holds. */
  private isReachable(box: AgentBoxInfo, wantProfile: string): boolean {
    return box.status === "running" && !!box.endpoint && (box.profile ?? "agent") === wantProfile;
  }

  /**
   * Mark boxes a deploy left behind as draining: stale image, stale CA, or wrong profile.
   *
   * This is where the image finally gets compared. Pod reuse never did, which is why a new
   * AgentBox image only took effect when someone deleted pods by hand — and that delete was
   * a hard kill. Marking drains instead: the box keeps serving what it holds and takes no
   * new sessions, and the reaper removes it once it reports itself empty.
   *
   * Drain marks live in memory only. A Runtime restart re-derives them from exactly these
   * comparisons, so there is nothing to persist and nothing to go stale.
   */
  private markStaleBoxesDraining(agentId: string, pool: AgentBoxInfo[], wantProfile: string): void {
    // Whether a replacement is still in flight. A roll replaces ONE box at a time, and
    // "in flight" has to include the box that is still COMING UP: advancing as soon as the
    // previous corpse is gone means a replacement that never becomes ready (an image that
    // cannot be pulled) never blocks anything, and the roll walks the whole pool into the
    // ground one box at a time.
    let rolling = pool.some((b) => this.draining.has(b.boxId) || b.status === "starting");

    for (const box of pool) {
      if (box.status !== "running" || this.draining.has(box.boxId)) continue;
      // A box that cannot be talked to (its cert is signed by a CA we no longer trust) or
      // is the wrong shape entirely is not a candidate for an orderly roll — keeping it in
      // the pool serves nobody, so it goes immediately regardless of what else is draining.
      const urgent =
        !this.isCertFresh(box) ? "stale CA"
        : (box.profile ?? "agent") !== wantProfile ? `profile ${box.profile} != ${wantProfile}`
        : null;
      // A new image, or a pod still named the way instance 0 was named before every
      // instance carried its index. Both are working boxes: replace them one at a time so
      // the pool never drops to zero boxes able to take a new session.
      const rollable = urgent
        ? null
        : this.isStaleImage(box, wantProfile) ? `image ${box.image} != ${(this.spawner as any).expectedImage(wantProfile)}`
        : this.isLegacyName(agentId, box, wantProfile) ? "pod name predates instance indices"
        : null;

      if (!urgent && !rollable) continue;
      if (rollable) {
        if (rolling) continue;   // one at a time
        rolling = true;
      }
      if (!this.spendDrainBudget(agentId)) continue;
      console.log(`[agentbox-manager] Draining ${box.boxId} (agent=${agentId}): ${urgent ?? rollable}`);
      this.draining.set(box.boxId, Date.now());
    }
  }

  /**
   * Whether this agent may start another drain yet.
   *
   * Draining is always followed by creating, so a staleness judgement that is wrong about
   * a FRESH box replaces it with one that will be judged the same way — a loop that ends
   * only when someone reads the logs. This bounds it: past the budget the runtime stops
   * draining and says so, leaving the pool as it is, which is far cheaper than churning
   * pods against the API for hours.
   */
  private spendDrainBudget(agentId: string): boolean {
    const now = Date.now();
    const seen = this.drainBudget.get(agentId);
    if (!seen || now - seen.since > DRAIN_BUDGET_WINDOW_MS) {
      this.drainBudget.set(agentId, { count: 1, since: now });
      return true;
    }
    if (seen.count >= DRAIN_BUDGET) {
      if (seen.count === DRAIN_BUDGET) {
        seen.count++; // say it once
        console.error(
          `[agentbox-manager] agent=${agentId} has drained ${DRAIN_BUDGET} boxes in ` +
          `${Math.round(DRAIN_BUDGET_WINDOW_MS / 60_000)} minutes — that is a loop, not a deploy. ` +
          `Leaving the pool alone; something is judging healthy boxes stale.`,
        );
      }
      return false;
    }
    seen.count++;
    return true;
  }

  /**
   * Whether this pod still carries the name instance 0 had before every instance carried
   * its index.
   *
   * Such a pod works, and its cert and image may both be current — but nothing looks up
   * that name any more, so it would keep serving whatever it already holds and never be
   * counted, replaced or drained. Rolling it turns the rename into an ordinary deploy.
   */
  private isLegacyName(agentId: string, box: AgentBoxInfo, wantProfile: string): boolean {
    const spawner = this.spawner as { legacyPodName?(agentId: string, profile?: string): string };
    if (typeof spawner.legacyPodName !== "function") return false;
    return box.boxId === spawner.legacyPodName(agentId, wantProfile);
  }

  /**
   * Indices for the boxes that still have to be created to reach `replicas`.
   *
   * Two separate questions, and conflating them is a name collision: HOW MANY to add is
   * `replicas` minus the boxes still accepting work, but WHICH indices are free must
   * exclude every existing pod — **including the draining ones**. A draining box keeps its
   * name until it is actually deleted, so treating its index as free would build its
   * replacement under the identical pod name: the spawn would find the live pod and either
   * reuse it (the drain never rolls) or, on a CA-triggered drain, delete it outright — the
   * hard kill draining exists to avoid.
   *
   * A replacement therefore takes the next free index, which may sit above `replicas`.
   * Indices need not be contiguous; the pool converges as drained boxes are reaped.
   */
  private missingInstances(pool: AgentBoxInfo[], replicas: number, agentId: string): number[] {
    const live = pool.filter((b) => b.status !== "stopped");
    const occupied = new Set(live.map((b) => b.instance ?? 0));
    const accepting = live.filter((b) => !this.draining.has(b.boxId)).length;
    const need = replicas - accepting;
    if (need <= 0) return [];

    const missing: number[] = [];
    for (let i = 0; missing.length < need && i < replicas + occupied.size + 1; i++) {
      if (!occupied.has(i)) missing.push(i);
    }
    console.log(
      `[agentbox-manager] agent=${agentId} pool short by ${need} (accepting=${accepting}/${replicas}); ` +
      `spawning instances ${missing.join(",")}`,
    );
    return missing;
  }

  /** The `count` lowest instance indices no existing pod holds (draining ones included). */
  private freeInstances(pool: AgentBoxInfo[], count: number): number[] {
    const occupied = new Set(pool.filter((b) => b.status !== "stopped").map((b) => b.instance ?? 0));
    const free: number[] = [];
    for (let i = 0; free.length < count; i++) if (!occupied.has(i)) free.push(i);
    return free;
  }

  private async spawnInstances(
    agentId: string,
    config: Partial<AgentBoxConfig> | undefined,
    instances: number[],
    /**
     * Whether these boxes belong to a POOL. Only a pooled box is forced resident: the
     * agent's own idle window would otherwise let one box of the pool disappear while its
     * siblings stay, which the pool cannot express. A single-box agent keeps the window it
     * was configured with — the reaper replaces such a box too, and forcing residency
     * there would quietly turn every agent in the cluster into a permanent pod.
     */
    pooled = true,
  ): Promise<AgentBoxHandle[]> {
    const resolvedEnv = await this.resolveEnv(agentId, config?.env);
    const persistence = await this.resolvePersistence(agentId, config?.persistence);
    const results = await Promise.all(instances.map(async (instance) => {
      try {
        const handle = await this.spawner.spawn({
          ...config,
          agentId,
          instance,
          persistence,
          env: {
            ...resolvedEnv,
            // A pooled box must be RESIDENT. With a finite idle window the pool would
            // shrink itself the moment traffic dipped and pay a cold start on the next
            // turn — the opposite of why replicas were raised. Reuses the existing
            // non-positive-window contract rather than adding a second mechanism.
            ...(pooled ? { SICLAW_AGENTBOX_IDLE_TIMEOUT: "0" } : {}),
          },
        });
        handle.agentId = agentId;
        return handle;
      } catch (err) {
        console.warn(`[agentbox-manager] spawn of instance ${instance} for agent=${agentId} failed:`, err);
        return null;
      }
    }));
    return results.filter((h): h is AgentBoxHandle => h !== null);
  }

  /**
   * Ask each box what it is holding. Cached briefly: placement needs a recent sample, not
   * a fresh one, and affinity means most turns never reach this path at all.
   */
  private async sampleBoxStatuses(boxes: AgentBoxInfo[]): Promise<Map<string, BoxStatusReport>> {
    const out = new Map<string, BoxStatusReport>();
    if (!this.boxStatusProbe) return out;
    const now = Date.now();
    await Promise.all(boxes.map(async (box) => {
      const cached = this.statusCache.get(box.boxId);
      if (cached && now - cached.at < BOX_STATUS_TTL_MS) {
        out.set(box.boxId, cached.status);
        return;
      }
      try {
        const status = await this.boxStatusProbe!(box.endpoint);
        this.statusCache.set(box.boxId, { at: now, status });
        this.probeFailures.delete(box.boxId);
        out.set(box.boxId, status);
      } catch (err) {
        // A box running an image from before box-status existed 404s here — which is every
        // box during the rollout that introduces this. It still exposes the older session
        // list, and knowing WHICH sessions it holds is the whole point: without it the
        // Runtime would think they are free and hand them to a second box.
        if (this.legacySessionLister) {
          try {
            const ids = await this.legacySessionLister(box.endpoint);
            const status: BoxStatusReport = { sessionIds: ids, turnsInFlight: 0, drained: ids.length === 0 };
            this.statusCache.set(box.boxId, { at: now, status });
            this.probeFailures.delete(box.boxId);
            out.set(box.boxId, status);
            return;
          } catch { /* older endpoint unavailable too — fall through to the warning */ }
        }
        const fails = (this.probeFailures.get(box.boxId) ?? 0) + 1;
        this.probeFailures.set(box.boxId, fails);
        if (fails >= UNRESPONSIVE_PROBE_LIMIT && !this.draining.has(box.boxId)) {
          console.warn(`[agentbox-manager] ${box.boxId} failed ${fails} status probes; draining it so its sessions are not pinned to a box that cannot answer`);
          this.draining.set(box.boxId, Date.now());
        }
        // A box that cannot be asked is not evidence of anything; leave it out of the
        // sample rather than guessing it is idle and stacking new sessions onto it.
        console.warn(`[agentbox-manager] box-status probe failed for ${box.boxId}:`, err);
      }
    }));
    return out;
  }

  /**
   * Remove boxes that finished draining, or ran out of time.
   *
   * A box reports `drained` itself — the Runtime cannot see a background sub-agent still
   * running under a session with no in-flight turn. The deadline exists because that
   * sub-agent may run for ten minutes and a deploy cannot wait indefinitely; five minutes
   * covers ordinary conversations comfortably and only cuts long batches.
   */
  /**
   * Bring every agent's pod count down to its configured `replicas`.
   *
   * Runs from the reaper rather than from acquisition, because acquisition cannot see it:
   * an agent lowered from 3 to 1 takes the single-box path, which only ever looks up
   * instance 0 by name — instances 1 and 2 would never be listed, never drained, and, being
   * pooled and therefore resident, would never self-destruct either. The same blindness
   * applies after a Runtime restart, which is why the scan is driven by the CLUSTER's pod
   * list rather than by anything this process remembers.
   *
   * Victims are the highest instance indices: the least disruptive order available without
   * asking every box what it holds, since index 0 is the oldest and likeliest to be busy.
   */
  /**
   * Collect boxes whose process has ended, and put back the ones that did not choose to.
   *
   * A pool exists so that losing one box costs capacity rather than service. Until now
   * losing one cost capacity until the next request happened to arrive — the reaper only
   * ever shrank a pool, so a crashed box sat as a corpse and the pool ran short, silently,
   * for as long as the agent was quiet.
   *
   * Only an UNASKED-FOR exit is replaced. A box that exits cleanly is doing what it was
   * told — the idle self-destruct is a feature, and replacing its work would spawn a pod
   * that idles out and is spawned again, forever, for an agent nobody is using.
   *
   * The corpse is deleted either way: a terminal pod holds its name, and a reader looking
   * at the namespace should not have to work out which failures are still meaningful.
   */
  /**
   * Put back what a roll took away, without waiting for a request to notice.
   *
   * Only while a roll is actually in progress — a box of this agent is draining. Outside
   * that, a pool below its replica count is either an agent nobody is using (its boxes
   * idled out, and spawning them again would undo that) or a crash, which is handled
   * where crashes are handled.
   */
  private async advanceRoll(agentId: string, pool: AgentBoxInfo[]): Promise<void> {
    if (!pool.some((b) => this.draining.has(b.boxId))) return;
    const replicas = await this.resolveReplicas(agentId);
    const accepting = pool.filter((b) => b.status !== "stopped" && !this.draining.has(b.boxId));
    if (accepting.length >= replicas) return;
    const missing = this.missingInstances(pool, replicas, agentId)
      // A slot that just crashed is under the same cooldown here as it is in the crash
      // path; without this the roll happily respawns what crash healing declined to.
      .filter((instance) => this.respawnCooledDown(`${agentId}#${instance}`));
    if (missing.length === 0) return;
    console.log(`[agentbox-manager] agent=${agentId} roll in progress; bringing instance(s) ${missing.join(",")} back`);
    void this.spawnInstances(agentId, undefined, missing, replicas > 1).catch((err) =>
      console.warn(`[agentbox-manager] roll replacement failed for agent=${agentId}:`, err));
  }

  /** Whether this slot is outside its crash cooldown — a read, unlike {@link mayRespawn}. */
  private respawnCooledDown(key: string): boolean {
    const seen = this.crashRespawns.get(key);
    if (!seen) return true;
    if (seen.count >= CRASH_RESPAWN_LIMIT) return false;
    return Date.now() - seen.at >= CRASH_RESPAWN_COOLDOWN_MS;
  }

  private async healCrashedBoxes(agentId: string, pool: AgentBoxInfo[]): Promise<void> {
    const terminal = pool.filter((b) => b.status === "stopped" && !this.draining.has(b.boxId));
    if (terminal.length === 0) return;

    const crashed = terminal.filter((b) => b.exitedUnexpectedly);
    let stuck = false;
    for (const box of terminal) {
      if (box.exitedUnexpectedly) {
        console.warn(`[agentbox-manager] ${box.boxId} (agent=${agentId}) ended without being asked to; collecting it`);
      }
      try {
        await this.spawner.stop(box.boxId);
        this.statusCache.delete(box.boxId);
        this.probeFailures.delete(box.boxId);
      } catch (err) {
        // Keep collecting the others — one pod stuck behind a finalizer must not stop the
        // agent's remaining corpses from being cleared. Replacement is skipped this round
        // (the index is still occupied) and retried on the next.
        console.warn(`[agentbox-manager] failed to collect ${box.boxId}:`, err);
        stuck = true;
      }
    }
    if (crashed.length === 0 || stuck) return;

    // Replace only what crashed, and only up to what the agent is configured for.
    const replicas = await this.resolveReplicas(agentId);
    // The FULL pool decides which indices are free — a pod that is terminating still owns
    // its name, and spawning into it lands on the dying pod instead of a new one.
    const missing = this.missingInstances(pool, replicas, agentId);
    if (missing.length === 0) return;

    // Rate-limited per INSTANCE, not per pod name: the replacement takes the same index,
    // so "this slot keeps dying" is the thing worth counting.
    const allowed = missing.filter((instance) => this.mayRespawn(`${agentId}#${instance}`));
    if (allowed.length === 0) return;
    console.log(`[agentbox-manager] agent=${agentId} replacing ${allowed.length} crashed box(es); spawning instances ${allowed.join(",")}`);
    void this.spawnInstances(agentId, undefined, allowed, replicas > 1).catch((err) =>
      console.warn(`[agentbox-manager] failed to replace crashed box(es) for agent=${agentId}:`, err));
  }

  /**
   * Whether this box may be replaced again yet.
   *
   * A box killed by what will kill its replacement — an OOM on a prompt that rebuilds the
   * same context — must not be respawned every tick. After a few attempts the runtime
   * stops and says so, leaving the pool short rather than hammering the API forever.
   */
  private mayRespawn(key: string): boolean {
    const now = Date.now();
    const seen = this.crashRespawns.get(key);
    // Forget a slot that has been healthy for a while. Without this the count only ever
    // rises, so three crashes spread across months retire an instance permanently — and
    // silently, because the warning already fired the first time it hit the limit.
    if (seen && now - seen.at > CRASH_RESPAWN_FORGET_MS) this.crashRespawns.delete(key);
    const record = this.crashRespawns.get(key);
    if (!record) {
      this.crashRespawns.set(key, { count: 1, at: now });
      return true;
    }
    const seenNow = record;
    if (now - seenNow.at < CRASH_RESPAWN_COOLDOWN_MS) return false;
    if (seenNow.count >= CRASH_RESPAWN_LIMIT) {
      if (seenNow.count === CRASH_RESPAWN_LIMIT) {
        console.warn(`[agentbox-manager] ${key} has crashed ${seenNow.count} times; not replacing it again — the pool stays short until someone looks`);
        seenNow.count++; // report once
      }
      return false;
    }
    this.crashRespawns.set(key, { count: seenNow.count + 1, at: now });
    return true;
  }

  private async reconcilePoolSizes(): Promise<void> {
    const s: any = this.spawner;
    if (typeof s.list !== "function") return;
    let all: AgentBoxInfo[];
    try {
      all = await s.list();
    } catch (err) {
      console.warn("[agentbox-manager] pool size scan failed:", err);
      return;
    }

    const byAgent = new Map<string, AgentBoxInfo[]>();
    for (const box of all) {
      if ((box.profile ?? "agent") !== "agent" || !box.agentId) continue;
      const list = byAgent.get(box.agentId) ?? [];
      list.push(box);
      byAgent.set(box.agentId, list);
    }

    for (const [agentId, pool] of byAgent) {
      await this.healCrashedBoxes(agentId, pool);
      const boxes = pool.filter((b) => b.status !== "stopped");
      // Keep a roll moving without waiting for traffic: mark the next stale box once the
      // previous one has gone, and put back what the roll removed. A deploy on a quiet
      // agent would otherwise stop half-done until someone happened to send a message.
      this.markStaleBoxesDraining(agentId, boxes, "agent");
      await this.advanceRoll(agentId, boxes);
      const accepting = boxes.filter((b) => !this.draining.has(b.boxId));
      // One box is both "nothing to shrink" and the un-pooled shape — skip without
      // paying a replicas lookup for every agent in the cluster on every tick.
      if (accepting.length <= 1) continue;
      const replicas = await this.resolveReplicas(agentId);
      if (accepting.length <= replicas) continue;
      const excess = [...accepting]
        .sort((a, b) => (b.instance ?? 0) - (a.instance ?? 0))
        .slice(0, accepting.length - replicas);
      for (const box of excess) {
        console.log(`[agentbox-manager] Draining ${box.boxId} (agent=${agentId}): replicas lowered to ${replicas}`);
        this.draining.set(box.boxId, Date.now());
      }
    }
  }

  private async reapDrainedBoxes(): Promise<void> {
    await this.reconcilePoolSizes();
    if (this.draining.size === 0) return;
    for (const [boxId, markedAt] of [...this.draining]) {
      let info: AgentBoxInfo | null = null;
      try {
        info = await this.spawner.get(boxId);
      } catch { /* transient; retry next round */ continue; }
      if (!info || info.status === "stopped") {
        this.draining.delete(boxId);
        this.statusCache.delete(boxId);
        this.interruptReported.delete(boxId);
        this.probeFailures.delete(boxId);
        continue;
      }
      const overdue = Date.now() - markedAt >= DRAIN_DEADLINE_MS;
      let drained = false;
      let held: string[] = [];
      if (!overdue && this.boxStatusProbe && info.endpoint) {
        try {
          drained = (await this.boxStatusProbe(info.endpoint)).drained;
        } catch { continue; } // can't tell → keep waiting rather than cut a live box
      }
      if (!drained && !overdue) continue;
      if (overdue && !drained && this.boxStatusProbe && info.endpoint && !this.interruptReported.has(boxId)) {
        // Only on the path that cuts a box still holding work: ask what it holds, so those
        // turns can be reported as interrupted rather than dying as a broken stream. The
        // box is going away regardless — a probe that fails just costs the better message.
        try {
          const status = await this.boxStatusProbe(info.endpoint);
          // A box lists every session RESIDENT on it, including ones whose turns have since
          // been placed elsewhere — it never forgets. Reporting those would cut a live turn
          // on a healthy box and blame this removal for it, so keep only the sessions this
          // box is still the bound holder of.
          held = status.sessionIds.filter((id) => this.bindings.get(info!.agentId, id) === boxId);
        } catch { /* keep the removal going; the streams still break and end the turns */ }
      }
      console.log(`[agentbox-manager] Removing drained box ${boxId}${overdue ? " (deadline reached)" : ""}`);
      if (held.length) {
        // Marked before reporting: a stop that throws keeps the drain mark and retries next
        // tick, and the box still lists those sessions — reporting again would cut whatever
        // turn has since taken that session id.
        this.interruptReported.add(boxId);
        console.log(`[agentbox-manager] ${boxId} still held ${held.length} session(s); reporting them interrupted`);
        try {
          this.turnTerminator?.(held, "box_rolled");
        } catch (err) {
          console.warn(`[agentbox-manager] could not report interrupted turns for ${boxId}:`, err);
        }
      }
      try {
        await this.spawner.stop(boxId);
      } catch (err) {
        console.warn(`[agentbox-manager] failed to remove drained box ${boxId}:`, err);
        continue; // keep the mark; retry next round
      }
      this.draining.delete(boxId);
      this.statusCache.delete(boxId);
      this.interruptReported.delete(boxId);
      // Indices — and therefore names — are reused. A leftover failure count would make
      // the replacement's first transient probe failure look like its fourth.
      this.probeFailures.delete(boxId);
    }
  }

  private async getOrCreateLocal(
    agentId: string,
    config?: Partial<AgentBoxConfig>,
  ): Promise<AgentBoxAcquisition> {
    const existing = this.boxes.get(agentId);
    if (existing) {
      existing.lastActiveAt = new Date();
      const info = await this.spawner.get(existing.handle.boxId);
      if (info && info.status === "running") {
        // Warm reuse: cached running box returned without spawning. Per-agent
        // config (env/persistence) is NOT re-resolved — applies on next cold spawn.
        return { handle: existing.handle, created: false };
      }
      this.boxes.delete(agentId);
    }

    console.log(`[agentbox-manager] Creating new AgentBox for agent=${agentId}`);

    const resolvedEnv = await this.resolveEnv(agentId, config?.env);
    const handle = await this.spawner.spawn({
      ...config,
      agentId,
      persistence: await this.resolvePersistence(agentId, config?.persistence),
      env: Object.keys(resolvedEnv).length > 0 ? resolvedEnv : undefined,
    });

    this.boxes.set(agentId, { handle, lastActiveAt: new Date(), createdAt: new Date() });
    return { handle, created: true };
  }

  /**
   * Merge static config env with the lazily-resolved per-agent env from the
   * injected resolver. Only called on a cold spawn. Static `config.env` wins on
   * key collisions.
   */
  private async resolveEnv(agentId: string, configEnv?: Record<string, string>): Promise<Record<string, string>> {
    const lazy = this.spawnEnvResolver ? (await this.spawnEnvResolver(agentId)) ?? {} : {};
    return { ...lazy, ...(configEnv ?? {}) };
  }

  /**
   * Resolve the per-agent PVC persistence mode for a cold spawn. An explicit
   * `configValue` (e.g. task-coordinator passing `binding.persistence`) wins;
   * otherwise the injected `persistenceResolver` is consulted by agentId. Either
   * may be undefined → the spawner falls back to its global config. Only called
   * on a cold spawn, so warm-pod reuse pays no RPC.
   */
  private async resolvePersistence(agentId: string, configValue?: boolean): Promise<boolean | undefined> {
    if (configValue !== undefined) return configValue;
    return this.persistenceResolver ? await this.persistenceResolver(agentId) : undefined;
  }

  /**
   * Whether a running pod's mTLS cert still chains to the runtime's current CA.
   *
   * If the spawner can't report a CA fingerprint (non-mTLS spawner, or cert
   * manager not yet set), there's nothing to validate → treat as fresh. A
   * running pod whose stamped fingerprint differs (or is absent on a pod
   * spawned before this label existed) is stale: the runtime can no longer
   * complete mTLS with it, so getOrCreate falls through to spawn(), which
   * deletes and recreates it with a cert signed by the current CA.
   */
  private isCertFresh(info: AgentBoxInfo): boolean {
    const want = this.spawner.caFingerprint?.();
    if (!want) return true;
    return info.caFingerprint === want;
  }

  get(agentId: string): AgentBoxHandle | undefined {
    if (this.isK8s) return undefined;
    const managed = this.boxes.get(agentId);
    if (managed) {
      managed.lastActiveAt = new Date();
      return managed.handle;
    }
    return undefined;
  }

  async getAsync(agentId: string, profile?: string): Promise<AgentBoxHandle | undefined> {
    if (this.isK8s) {
      const name = this.podName(agentId, profile);
      const info = await this.spawner.get(name);
      if (info && info.status === "running" && info.endpoint) {
        return { boxId: name, endpoint: info.endpoint, agentId };
      }
      return undefined;
    }
    return this.get(agentId);
  }

  async stop(agentId: string, profile?: string): Promise<void> {
    if (this.isK8s) {
      const name = this.podName(agentId, profile);
      console.log(`[agentbox-manager] Stopping AgentBox ${name}`);
      await this.spawner.stop(name);
      return;
    }
    const managed = this.boxes.get(agentId);
    if (!managed) return;
    console.log(`[agentbox-manager] Stopping AgentBox for agent=${agentId}`);
    await this.spawner.stop(managed.handle.boxId);
    this.boxes.delete(agentId);
  }

  activeAgentIds(): string[] {
    if (this.isK8s) return [];
    return Array.from(this.boxes.keys());
  }

  async list(): Promise<AgentBoxInfo[]> {
    return this.spawner.list();
  }

  touch(agentId: string): void {
    if (this.isK8s) return;
    const managed = this.boxes.get(agentId);
    if (managed) managed.lastActiveAt = new Date();
  }

  stats(): { total: number; agentIds: string[] } {
    return { total: this.boxes.size, agentIds: Array.from(this.boxes.keys()) };
  }

  async cleanup(): Promise<void> {
    this.stopBackgroundLoops();
    for (const [, managed] of this.boxes) {
      await this.spawner.stop(managed.handle.boxId);
    }
    this.boxes.clear();
    await this.spawner.cleanup();
  }

  /**
   * Process shutdown is not cluster teardown. In K8s mode boxes and their
   * durable run rows outlive a Runtime pod and are adopted by the replacement;
   * deleting every labelled pod here destroys that hand-off window. Local and
   * child-process spawners still own their children, so they use full cleanup.
   */
  async shutdown(): Promise<void> {
    if (!this.isK8s) {
      await this.cleanup();
      return;
    }
    this.stopBackgroundLoops();
    this.boxes.clear();
  }

  private stopBackgroundLoops(): void {
    this.stopHealthCheck();
    // The orphan-sweep interval dies with the manager (review: the clear had
    // landed in setSpawnEnvResolver, which both left it running post-cleanup
    // and silently disabled GC if a resolver was ever re-set after boot).
    if (this.orphanSweepInitialTimer) {
      clearTimeout(this.orphanSweepInitialTimer);
      this.orphanSweepInitialTimer = undefined;
    }
    if (this.orphanSweepTimer) {
      clearInterval(this.orphanSweepTimer);
      this.orphanSweepTimer = undefined;
    }
    if (this.drainReaperTimer) {
      clearInterval(this.drainReaperTimer);
      this.drainReaperTimer = undefined;
    }
  }
}
