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

/** How often drained boxes are collected. */
const DRAIN_REAP_INTERVAL_MS = 10_000;

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
  /** Which box serves which session. Only consulted when an agent runs more than one. */
  private readonly bindings = new BoxBindings();
  /** boxId → when it was marked draining. In memory only; re-derived after a restart. */
  private draining = new Map<string, number>();
  private statusCache = new Map<string, { at: number; status: BoxStatusReport }>();
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
    const tick = () =>
      void s.sweepOrphans(isLive).catch((err: any) =>
        console.warn("[agentbox-manager] orphan sweep failed:", err?.message ?? err));
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
    try {
      return normalizeReplicas(await this.replicasResolver(agentId));
    } catch (err) {
      // Fail to ONE, never to many: a config lookup blip must not scale an agent up.
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
   * Pod / box name. Trims agentId to stay under the 63-char K8s name limit and only
   * sanitizes forbidden characters.
   *
   * The prefix is profile-derived and this MUST stay identical to K8sSpawner.podName
   * (compile boxes are "kbc-box-", everything else "agentbox-"): the manager looks a pod
   * up by this computed name for warm reuse, liveness and stop, so a mismatch would miss
   * the real pod (a leaked box on stop, a missed re-attach on adopt). That includes the
   * instance rule — 0 is unsuffixed, so an agent running one box is named exactly as it
   * always was.
   */
  private podName(agentId: string, prefix = "agentbox", instance = 0): string {
    const sanitized = agentId.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 50);
    const base = `${prefix}-${sanitized}`;
    return instance > 0 ? `${base}-${instance}` : base;
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
      if (replicas > 1) return this.getOrCreatePooled(agentId, config, sessionId, replicas);
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
    const name = this.podName(agentId, this.prefixForProfile(wantProfile));

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
    const statuses = sessionId ? await this.sampleBoxStatuses(reachable) : new Map<string, BoxStatusReport>();
    const resident = new Set<string>();
    for (const st of statuses.values()) for (const id of st.sessionIds) resident.add(id);

    // Adopt what the boxes report: after a Runtime restart the binding table is empty
    // while sessions are still live in boxes, and placing one fresh would send a running
    // conversation to a box holding none of its state.
    for (const [boxId, status] of statuses) {
      for (const id of status.sessionIds) {
        if (!this.bindings.get(agentId, id)) this.bindings.bind(agentId, id, boxId);
      }
    }

    // Affinity: this session already belongs to a box that is still up. It wins over
    // everything below — including a drain, which means "no NEW sessions", not "abandon
    // what you are holding".
    //
    // The ONE exception is the legal re-binding: a box that is draining AND no longer
    // holds this session has nothing left to lose by letting it move, and keeping it
    // pinned there would repeatedly reactivate an old-image box and push the drain to its
    // force-kill deadline.
    const bound = sessionId ? this.bindings.get(agentId, sessionId) : undefined;
    if (bound) {
      const box = reachable.find((b) => b.boxId === bound);
      const stillHolding = resident.has(sessionId!);
      if (box && (stillHolding || !this.draining.has(box.boxId))) {
        return { handle: { boxId: box.boxId, endpoint: box.endpoint, agentId }, created: false };
      }
      if (box && sessionId) {
        const moved = this.bindings.rebalanceOff(agentId, box.boxId, this.candidatesFrom(reachable, statuses), resident);
        if (moved.includes(sessionId)) {
          const target = reachable.find((b) => b.boxId === this.bindings.get(agentId, sessionId));
          if (target) {
            console.log(`[agentbox-manager] session ${sessionId} released; moving off draining ${box.boxId} to ${target.boxId}`);
            return { handle: { boxId: target.boxId, endpoint: target.endpoint, agentId }, created: false };
          }
        }
        // Nowhere to move it yet — stay put rather than fail the turn.
        return { handle: { boxId: box.boxId, endpoint: box.endpoint, agentId }, created: false };
      }
    }

    // Growing the pool normally happens in the BACKGROUND: blocking this turn on a cold
    // start would make growing the pool feel slower than not having grown it, and the
    // session in hand can be served by whatever is already up.
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
        // 🔴 Only bind a session the draining boxes are NOT still holding. During a
        // rollout a live turn keeps running on the old box; re-binding here would send
        // that conversation's next Stop/Steer/send to a box holding none of its state.
        if (sessionId && !resident.has(sessionId)) {
          this.bindings.bind(agentId, sessionId, handle.boxId);
          return { handle, created: true };
        }
        if (!sessionId) return { handle, created: true };
        const holder = reachable.find((b) => b.boxId === this.bindings.get(agentId, sessionId));
        if (holder) {
          console.log(`[agentbox-manager] session ${sessionId} is still resident on ${holder.boxId}; not moving it to ${handle.boxId}`);
          return { handle: { boxId: holder.boxId, endpoint: holder.endpoint, agentId }, created: false };
        }
        this.bindings.bind(agentId, sessionId, handle.boxId);
        return { handle, created: true };
      }
      // The spawn failed. Fall through: serving from a draining box beats failing the
      // turn outright, and the reaper will not remove it while it holds work.
      if (reachable.length === 0) throw new Error(`Failed to spawn an AgentBox for agent ${agentId}`);
    } else if (missing.length > 0) {
      void this.spawnInstances(agentId, config, missing).catch((err) =>
        console.warn(`[agentbox-manager] background pool fill failed for agent=${agentId}:`, err));
    }

    if (!sessionId) {
      // No session to route (admin probe, capability-style call). Prefer a box that is
      // still accepting — handing the caller a draining one works but is about to be
      // deleted, and there is no binding here to keep it alive.
      const box = reachable.find((b) => !this.draining.has(b.boxId)) ?? reachable[0];
      return { handle: { boxId: box.boxId, endpoint: box.endpoint, agentId }, created: false };
    }

    const candidates = this.candidatesFrom(reachable, statuses);

    const placed = this.bindings.place(agentId, sessionId, candidates, resident);
    const chosen = placed ? reachable.find((b) => b.boxId === placed.boxId) : undefined;
    if (chosen) {
      return { handle: { boxId: chosen.boxId, endpoint: chosen.endpoint, agentId }, created: false };
    }

    // Placement declined and the awaited-spawn branch above did not run or did not
    // produce a box. Serving from a draining box beats failing the turn: the reaper
    // leaves it alone while it holds work, and the binding moves on its next release.
    const fallback = reachable[0];
    this.bindings.bind(agentId, sessionId, fallback.boxId);
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
    for (const box of pool) {
      if (box.status !== "running" || this.draining.has(box.boxId)) continue;
      const reason =
        !this.isCertFresh(box) ? "stale CA"
        : (box.profile ?? "agent") !== wantProfile ? `profile ${box.profile} != ${wantProfile}`
        : this.isStaleImage(box, wantProfile) ? `image ${box.image} != ${(this.spawner as any).expectedImage(wantProfile)}`
        : null;
      if (!reason) continue;
      console.log(`[agentbox-manager] Draining ${box.boxId} (agent=${agentId}): ${reason}`);
      this.draining.set(box.boxId, Date.now());
    }
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
            SICLAW_AGENTBOX_IDLE_TIMEOUT: "0",
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
        out.set(box.boxId, status);
      } catch (err) {
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
      if ((box.profile ?? "agent") !== "agent" || box.status === "stopped" || !box.agentId) continue;
      const list = byAgent.get(box.agentId) ?? [];
      list.push(box);
      byAgent.set(box.agentId, list);
    }

    for (const [agentId, boxes] of byAgent) {
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
        continue;
      }
      const overdue = Date.now() - markedAt >= DRAIN_DEADLINE_MS;
      let drained = false;
      if (!overdue && this.boxStatusProbe && info.endpoint) {
        try {
          drained = (await this.boxStatusProbe(info.endpoint)).drained;
        } catch { continue; } // can't tell → keep waiting rather than cut a live box
      }
      if (!drained && !overdue) continue;
      console.log(`[agentbox-manager] Removing drained box ${boxId}${overdue ? " (deadline reached)" : ""}`);
      try {
        await this.spawner.stop(boxId);
      } catch (err) {
        console.warn(`[agentbox-manager] failed to remove drained box ${boxId}:`, err);
        continue; // keep the mark; retry next round
      }
      this.draining.delete(boxId);
      this.statusCache.delete(boxId);
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
      const name = this.podName(agentId, this.prefixForProfile(profile));
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
      const name = this.podName(agentId, this.prefixForProfile(profile));
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
