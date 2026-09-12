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
import { certificateHasExpired, certificateNeedsRenewal } from "../../shared/cert-validity.js";
// The readiness deadline is the spawner's, and the manager's patience for a `starting` slot
// has to be the SAME number — a slot the spawner has given up waiting for is not one this
// path should keep waiting on. Importing it rather than restating it is what keeps the two
// from drifting; `startup-probe-window.test.ts` asserts the wider hierarchy it belongs to.
import { POD_READY_TIMEOUT_MS } from "./k8s-spawner.js";

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
 * How long a BACKGROUND pool fill leaves a slot alone after a failed spawn.
 *
 * Distinct from {@link CRASH_RESPAWN_COOLDOWN_MS}, which counts boxes that RAN and died.
 * This counts boxes that never started, and until it existed nothing rate-limited that at
 * all: the fill is triggered per session request, so a slot that could not be filled was
 * retried as fast as traffic arrived. Short, because the common cause is transient
 * contention that clears in well under a minute.
 */
const SPAWN_RETRY_COOLDOWN_MS = 30_000;

/** How long a spawn-failure record survives with nobody asking about it. */
const SPAWN_FAILURE_FORGET_MS = 60 * 60_000;

/** Key for the per-(agent, instance) spawn bookkeeping. One slot is one pod. */
function spawnSlotKey(agentId: string, instance: number): string {
  return `${agentId}#${instance}`;
}

/**
 * A spawn in flight for one slot, and WHAT IT WILL DO to the pod already there.
 *
 * 🔴 The intent has to be recorded, not just the promise, because de-duplication is only
 * sound between callers that want the same thing. A spawn started while a Pending pod was
 * still young reuses that pod; once it crosses the readiness deadline a later caller wants
 * it DELETED. Joining the older attempt then means the pod is never removed and every
 * joined caller fails with it, delaying recovery by another full readiness window.
 */
interface InflightSpawn {
  /**
   * What callers joining this slot receive. NOT the raw attempt: if this attempt is
   * superseded and then fails, its waiters are handed the successor's outcome instead.
   *
   * 🔴 Without that hand-off, superseding actively HARMED the callers already waiting. The
   * stronger attempt deletes the pod, which makes this attempt's readiness wait fail with
   * "disappeared while waiting" — so everyone holding this promise got null and reported
   * `Failed to spawn`, while the replacement pod came up fine moments later. The failure
   * they saw was caused by the recovery, not by the fault.
   */
  result: Promise<AgentBoxHandle | null>;
  /** Whether this attempt will replace the pod occupying the slot. */
  recreate: boolean;
  /** Called when a stronger intent takes over, so this attempt's waiters follow it. */
  adopt(successor: Promise<AgentBoxHandle | null>): void;
}

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

/**
 * How often an agent whose replica count this runtime cannot resolve may be reported.
 *
 * The reaper ticks every ten seconds over every agent with a pod in the namespace. An agent
 * the control plane will not answer for is usually a standing condition, so reported per tick
 * it drowns out everything else in the runtime log — including the drains that matter, which
 * is how the production incident stayed unnoticed. The lookup itself is NOT rate limited (see
 * lookupReplicas): retrying is what makes a genuine blip recover on the next tick.
 */
const REPLICAS_UNKNOWN_LOG_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How long the pool reconciler remembers that it could not establish an agent's replica count.
 *
 * Read by `reconcilePoolSizes` and NOTHING else, which is the whole point: the lookup itself
 * must keep failing fast and uncached so that a turn is never held at one box on the strength
 * of a remembered blip. Reconciliation has no such deadline — an agent the control plane will
 * not answer for is usually a standing condition, and re-asking at 0.1 Hz forever is waste.
 * The cost of deferring is a slower response to an agent that has just become answerable, and
 * nothing this loop does is urgent.
 */
const UNOWNED_MEMO_MS = 60_000;

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

/**
 * Why a box was marked draining — and therefore whether the mark survives being re-examined.
 *
 * `stale` and `unresponsive` are judged from what the box itself presents (its image, its CA,
 * its refusal to answer a probe), so re-judging them reaches the same verdict. `excess` is
 * judged against the agent's replica count, which arrives over RPC and can therefore be
 * WRONG — and a mark is acted on some ticks after it is made, which is long enough for the
 * number that produced it to have been a transient failure. Only that kind is withdrawn.
 */
type DrainReason = "excess" | "stale" | "unresponsive";

interface DrainMark {
  at: number;
  reason: DrainReason;
}

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
  /** boxId → when it was marked draining, and WHY. In memory only; re-derived after a
   *  restart. The reason is what makes a mark revocable: see `withdrawExcessDrains`. */
  private draining = new Map<string, DrainMark>();
  private statusCache = new Map<string, { at: number; status: BoxStatusReport }>();
  private replicasCache = new Map<string, { at: number; value: number }>();
  /** agentId → when we last said its replica count is unknown. Rate limit only; it never
   *  affects what the lookup answers. See lookupReplicas. */
  private replicasUnknownLoggedAt = new Map<string, number>();
  /** agentId → when the reconciler last failed to establish a replica count. Reconciler
   *  only — see UNOWNED_MEMO_MS for why the serving path must not consult it. */
  private unresolvedAgents = new Map<string, number>();
  /** Consecutive failed status probes per box — see UNRESPONSIVE_PROBE_LIMIT. */
  private probeFailures = new Map<string, number>();
  /** Crashes per box, so a box that keeps dying is not respawned forever. */
  private crashRespawns = new Map<string, { count: number; at: number }>();
  /** Recent drains per agent, so a wrong staleness judgement cannot spin forever. */
  private drainBudget = new Map<string, { count: number; since: number }>();
  /**
   * Spawns currently in flight, keyed by {@link spawnSlotKey}. Concurrent callers naming
   * the same slot join the running attempt instead of starting a rival one — see
   * {@link spawnInstances}.
   */
  private readonly inflightSpawns = new Map<string, InflightSpawn>();
  /** When a slot's spawn last failed, so background fills back off — see mayFillInstance. */
  private readonly spawnFailures = new Map<string, number>();
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
    return (await this.lookupReplicas(agentId)) ?? 1;
  }

  /**
   * The agent's replica count, or UNDEFINED when it cannot be established.
   *
   * 🔴 "One" and "unknown" are different answers and collapsing them destroys live pods. This
   * returned 1 on failure, so a single failed RPC shrank a multi-box pool to one box — the
   * count carries no information about the pool's correct size, and the two directions of a
   * wrong guess are not symmetric: high costs a pod, low costs a running pool.
   *
   * The failure is not one thing. `FrontendWsClient.request` rejects IMMEDIATELY when the WS
   * is down (it does not queue), the RPC can time out against a slow or restarting control
   * plane, and the control plane can refuse an agent whose record moved. The drain reaper
   * starts with setBoxStatusProbe and does not wait for the control plane, so a Runtime
   * restart puts its first tick ten seconds in — a deploy is the likeliest trigger, and it
   * needs no second Runtime in the namespace.
   *
   * Callers therefore have to choose. Serving a turn may fall back to one (see
   * resolveReplicas): a single box is the safe shape for work that has to happen, and the
   * request itself is evidence this runtime serves the agent. Anything that DESTROYS a box
   * must treat unknown as "no answer" and leave the pool alone.
   *
   * A failure is deliberately NOT cached, and that predates this change for a good reason: a
   * genuine blip must be retried on the next tick rather than remembered, because a cached
   * unknown would make resolveReplicas fall back to one box for the whole TTL — sending a
   * multi-replica agent's new sessions all to instance 0. The log noise came from the same
   * failure being REPORTED every tick, not from it being retried, so the rate limit belongs
   * on the log line, not on the lookup.
   */
  private async lookupReplicas(agentId: string): Promise<number | undefined> {
    if (!this.replicasResolver) return 1;
    const cached = this.replicasCache.get(agentId);
    if (cached && Date.now() - cached.at < REPLICAS_TTL_MS) return cached.value;
    try {
      const value = normalizeReplicas(await this.replicasResolver(agentId));
      this.replicasCache.set(agentId, { at: Date.now(), value });
      this.replicasUnknownLoggedAt.delete(agentId);
      return value;
    } catch (err) {
      // One line per agent per window, and the message rather than a stack: the causes are a
      // dropped WS, an RPC timeout, or a refused agent, and none of their stacks say anything
      // the message does not. Unrated, this was the bulk of the runtime log.
      const now = Date.now();
      const last = this.replicasUnknownLoggedAt.get(agentId);
      if (last === undefined || now - last >= REPLICAS_UNKNOWN_LOG_INTERVAL_MS) {
        this.replicasUnknownLoggedAt.set(agentId, now);
        // State the FACT, not a consequence: the two callers act differently on it, so a
        // message that names one of them is wrong at the other site.
        console.warn(
          `[agentbox-manager] replicas unknown for agent=${agentId} — not owned by this runtime,` +
          ` or its config is unreachable (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      return undefined;
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
    // 🔴 EVERY reason the reaper would roll this box has to be listed here, not just the
    // image. The reaper drains a box whose certificate is due for renewal and creates the
    // replacement — but this path then kept handing new sessions BACK to it, because "due
    // for renewal" still authenticates and the warm-reuse test below only asks whether mTLS
    // works. The replacement took no traffic, and the box being replaced was eventually
    // killed at the drain deadline mid-request: an interruption plus another cold start.
    //
    // The certificate reason is gated on the box ALREADY DRAINING, and that condition is
    // load-bearing rather than defensive. Draining is the reaper having decided to replace
    // it, so the successor either exists or is coming. Without the gate this would roll on
    // "due for renewal" alone — and since a certificate is due for a THIRD of its lifetime,
    // that means paying a synchronous cold start on a box which works and which nothing has
    // decided to replace yet.
    const rollReason = info && info.status === "running"
      ? this.isStaleImage(info, wantProfile) ? "a stale AgentBox image"
        : (!this.isCertFresh(info) && this.draining.has(name)) ? "a draining box with a certificate due for renewal"
        : null
      : null;
    if (rollReason) {
      console.log(
        `[agentbox-manager] agent=${agentId} is on ${rollReason}; rolling it through the pool path`,
      );
      return this.getOrCreatePooled(agentId, config, sessionId, 1);
    }

    // USABLE, not fresh: reached only when the box is NOT being rolled (see rollReason
    // above). A certificate that is neither dead nor due still authenticates, so serve from
    // it — rebuilding here would make a user's turn wait out a cold start for a working box.
    if (info && info.status === "running" && info.endpoint && this.isCertUsable(info)) {
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
    if (info && info.status === "running" && !this.isCertUsable(info)) {
      console.log(`[agentbox-manager] Pod for agent=${agentId} has an unusable mTLS cert (rotated CA, or already expired); recreating to restore mTLS`);
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

    // PLACEABLE, not merely reachable — see isPlaceable for why getHolder must not use the
    // same test.
    const reachable = pool.filter((b) => this.isPlaceable(b, wantProfile));

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
      // 🔴 "Nothing reachable" and "pool short" are DIFFERENT conditions, and the gap
      // between them is a second, independent way to grow the pool without bound. A box
      // that is still starting counts as live for `missingInstances` (so `missing` is
      // empty — the pool is at size) but is not reachable (so `accepting` is 0). Falling
      // through to `freeInstances` then allocates a NEW index every time, and since each
      // request picks a different one, de-duplication cannot merge them: index 1, 2, 3, …
      // while the pool was never actually short. This is the other half of the observed
      // index climb.
      //
      // So when the pool is at size, act on a slot it ALREADY OCCUPIES instead of adding
      // one. The set has to be "occupied but not placeable", NOT just `starting`: capacity
      // in missingInstances is every pod that is not `stopped`, which also covers `error`
      // (what a `Failed`/`Unknown` phase, or a pod with no phase yet, maps to), `stopping`,
      // and a `running` box whose certificate died. Matching only `starting` left every one
      // of those falling through to freeInstances — measured by review: five requests
      // pushed the highest index to 6.
      //
      // 🔴 WAITING and REBUILDING are different actions, and only one of them is free.
      //
      // A `starting` slot just needs time: handing its index to spawnInstances joins the
      // in-flight spawn, or finds the pod and waits for readiness. Nothing is destroyed.
      //
      // Every other unusable slot — `error` (a Failed/Unknown phase), `stopping`, or a
      // `running` box with the wrong CA / a dead certificate / the wrong profile — is one
      // that spawnInstances will DELETE AND RECREATE. That is the same act the drain budget
      // exists to bound, and routing it through here bypassed the fuse completely: once the
      // budget trips, markStaleBoxesDraining stops marking such boxes, so they stay
      // non-draining in the pool, get picked up here, and are rebuilt on every request.
      // Reproduced in review — three requests after the trip rebuilt instances 0 and 1
      // regardless. A fuse with a path around it is not a fuse.
      //
      // So rebuilds spend drain budget like any other replacement, and when the budget is
      // gone the answer is to create NOTHING: no rebuild, and no fresh index either, since
      // allocating one is the churn the fuse is trying to stop. The turn then falls through
      // to the reachable/draining check below and fails if there is truly nothing to serve
      // from — which is the fuse working, not a regression.
      const notPlaceable = pool.filter((b) => b.status !== "stopped"
        && !this.draining.has(b.boxId)
        && !this.isPlaceable(b, wantProfile));
      const slotsOf = (boxes: AgentBoxInfo[]) =>
        boxes.map((b) => b.instance ?? 0).sort((a, b) => a - b);

      // 🔴 `starting` is only worth WAITING on while it is plausibly still coming up. Past
      // the readiness deadline the spawner itself gives up on, a pod that is still `starting`
      // is not slow — it is stuck (unschedulable is the common case: the storm's own
      // signature). Treating it as awaitable forever means every request waits out
      // POD_READY_TIMEOUT_MS and then fails, in a loop, while the slot is never rebuilt:
      // nothing else will do it either, since healCrashedBoxes collects `stopped` boxes only.
      //
      // So patience is bounded by the same deadline the spawner uses, and past it the slot
      // joins the rebuild set — where it is fused like any other pod destruction.
      const isComingUp = (b: AgentBoxInfo) =>
        b.status === "starting"
        && Date.now() - b.createdAt.getTime() < POD_READY_TIMEOUT_MS;
      const awaitable = slotsOf(notPlaceable.filter(isComingUp));
      const rebuildable = slotsOf(notPlaceable.filter((b) => !isComingUp(b)));

      // 🔴 ONE POD ACTUALLY CREATED, ONE UNIT OF BUDGET — and both halves of that sentence
      // were wrong in turn. First the budget was spent once for a whole BATCH, making the
      // unit a request: at 7 of 8 used, one request rebuilt instances 0, 1 and 2 while the
      // counter moved only to 8. Charging per slot fixed the batch, but charging HERE still
      // counted requests, because this runs before spawnInstances de-duplicates: eight
      // concurrent requests naming one dead slot spent eight units between them and then all
      // waited on the single spawn that resulted — one pod creation exhausting the fuse and
      // blocking recovery for the rest of the window.
      //
      // So the fuse is handed to spawnInstances as an `admit` gate, which consults it only
      // for a slot it is actually creating. Nothing is charged here.
      // The fuse applies PER SLOT, judged by whether that slot is a rebuild — not per
      // branch. Deciding it by branch made the priority below silently change whether the
      // fuse existed at all, which is how the starvation right underneath went unnoticed.
      const rebuildSet = new Set(rebuildable);
      const admit = (instance: number): boolean =>
        !rebuildSet.has(instance) || this.spendDrainBudget(agentId);
      // 🔴 The classification is not self-enforcing. A slot in the rebuild set may hold a pod
      // the spawner would happily REUSE — a Pending pod with a valid certificate passes every
      // check it makes — so calling it "rebuildable" here achieved nothing on its own: the
      // budget was spent and the same stuck pod came back, once per request, forever. The
      // intent has to travel with the request.
      const recreate = (instance: number): boolean => rebuildSet.has(instance);

      // What this turn WAITS on: whichever set can produce a usable box soonest. A starting
      // slot beats a rebuild, because waiting out a pod that is already coming up is cheaper
      // than deleting and recreating one.
      const target = missing.length > 0 ? missing
        : awaitable.length > 0 ? awaitable
        : rebuildable.length > 0 ? rebuildable
        : this.freeInstances(pool, 1);

      // 🔴 …but priority must not mean ABANDONMENT. Whatever the turn waits on, every
      // rebuildable slot still needs dealing with, because nothing else will: the reaper
      // collects `stopped` boxes only, so an `error` slot (a Failed/Unknown phase, or a pod
      // with no phase yet) is invisible to it. With a `starting` slot present the priority
      // above sent every request to that one slot, and if it stayed Pending the `error` slot
      // was never touched again — measured by review: a pool of starting(0) + error(1) only
      // ever called instance 0.
      //
      // So the rebuilds the wait did not claim go to the background, still fused, still
      // subject to the retry cooldown.
      const awaited = new Set(target);
      const strandedRebuilds = rebuildable.filter((i) => !awaited.has(i));

      if (target.length > 0) {
        const [first, ...rest] = target;

        // 🔴 LAUNCHED BEFORE THE AWAIT, and the order is the whole point. `void` makes this
        // concurrent with the caller, not with the line above it — put after the await, the
        // "background" work does not begin until the awaited slot resolves, which on the real
        // K8s path is up to POD_READY_TIMEOUT_MS. So a stuck `starting` slot left the
        // stranded `error` slots idle for three minutes and then failed the turn anyway:
        // review measured spawnCalls holding only [0] until instance 0 was released, and [1]
        // appearing only afterwards. The recovery has to be in flight WHILE the turn waits.
        const fillable = [...rest, ...strandedRebuilds].filter((i) => this.mayFillInstance(agentId, i));
        if (fillable.length > 0) {
          void this.spawnInstances(agentId, config, fillable, true, admit, recreate).catch((err) =>
            console.warn(`[agentbox-manager] background pool fill failed for agent=${agentId}:`, err));
        }

        // No cooldown on THIS one: there is nothing to serve this turn from, so a slot that
        // failed a moment ago is still worth one more try. The background remainder above
        // does respect it. Distinct instance sets, so the two calls cannot contend — and
        // in-flight de-duplication would merge them even if they did.
        const [handle] = await this.spawnInstances(agentId, config, [first], true, admit, recreate);
        if (handle) {
          if (sessionId) this.bindings.remember(agentId, sessionId, handle.boxId);
          return { handle, created: true };
        }
      }
      // Nothing was created — the spawn failed, or the drain budget refused a rebuild.
      // Serving from a draining box beats failing the turn; the reaper leaves it alone while
      // it holds work.
      if (reachable.length === 0) throw new Error(`Failed to spawn an AgentBox for agent ${agentId}`);
    } else if (missing.length > 0) {
      // 🔴 This is the hot path of the storm: it runs on EVERY session request while the
      // pool is short. De-duplication merges the concurrent attempts and the cooldown keeps
      // a slot that just failed from being retried at the rate traffic happens to arrive.
      const fillable = missing.filter((i) => this.mayFillInstance(agentId, i));
      if (fillable.length > 0) {
        void this.spawnInstances(agentId, config, fillable).catch((err) =>
          console.warn(`[agentbox-manager] background pool fill failed for agent=${agentId}:`, err));
      }
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
   * Reachable AND able to complete mTLS — the test for PLACEMENT, i.e. "where should this
   * session go".
   *
   * 🔴 DELIBERATELY NOT folded into {@link isReachable}, because the two questions
   * placement and {@link getHolder} ask want OPPOSITE answers about a box whose
   * certificate died:
   *
   *  - Placement asks where a session SHOULD go. A dead box is not an answer: a session
   *    bound to it was being handed straight back to it, so every turn of that conversation
   *    failed, and marking the box draining did nothing (a draining box is deliberately
   *    still served from). Excluding it lets the session move to a box that can answer —
   *    the transcript is on shared storage, so moving costs nothing.
   *
   *  - getHolder asks where a turn ALREADY IS, for steer / abort / clearQueue. Hiding the
   *    box that holds it does not make the turn stop: the caller falls through to
   *    placement, which SPAWNS a pod to answer an abort, and that fresh box replies "session
   *    not found" — which reads as already-stopped. An abort the box never confirmed must
   *    FAIL rather than report success, so returning the unreachable holder (and failing the
   *    call honestly) is the correct answer there.
   *
   * Unknown expiry counts as usable, so pods predating the expiry label are unaffected, and
   * a certificate merely NEARING expiry still places — only the already-dead are excluded.
   */
  private isPlaceable(box: AgentBoxInfo, wantProfile: string): boolean {
    return this.isReachable(box, wantProfile) && this.isCertUsable(box);
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
      // A box that cannot be talked to (its cert is signed by a CA we no longer trust, or
      // has already expired) or is the wrong shape entirely is not a candidate for an
      // orderly roll — keeping it in the pool serves nobody, so it goes immediately
      // regardless of what else is draining.
      const urgent =
        !this.isCertUsable(box) ? "cert unusable (rotated CA or expired)"
        : (box.profile ?? "agent") !== wantProfile ? `profile ${box.profile} != ${wantProfile}`
        : null;
      // A new image, a certificate approaching expiry, or a pod still named the way
      // instance 0 was named before every instance carried its index. All are WORKING
      // boxes: replace them one at a time so the pool never drops to zero boxes able to
      // take a new session. Expiry belongs here rather than above precisely because every
      // box of the pool shares one Secret and so comes due at the same moment.
      const rollable = urgent
        ? null
        : !this.isCertFresh(box) ? "certificate nearing expiry"
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
      this.draining.set(box.boxId, { at: Date.now(), reason: "stale" });
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

  /**
   * Create the named boxes, joining any spawn already in flight for the same slot.
   *
   * 🔴 DE-DUPLICATION IS LOAD-BEARING, not an optimisation. Pool filling is triggered from
   * `getOrCreatePooled`, i.e. once per SESSION REQUEST, and the fill runs in the
   * background — so while a pool sits short, every arriving request used to start its own
   * spawn for the very same instance indices. Observed: `pool short by 4 … spawning
   * instances 1,2,3,4` four times within a second, four pods created under one name (409 →
   * "concurrent create"), four independent readiness waits on that one pod, and a raw 404
   * ApiException whenever one of them recycled a pod another was still waiting on. All of
   * that contends for exactly the resources the boxes need in order to start, which is what
   * turned a slow cold start into a pool that never converged.
   *
   * The joined caller gets the first caller's box, built with the first caller's config.
   * That is not a compromise: one (agent, instance) is one pod by definition, so a second
   * spawn could only ever have produced the same pod or destroyed the first one's.
   *
   * `admit` is consulted ONLY by the caller that actually starts a spawn — never by one that
   * joins an existing one. That placement is the whole point: a quota checked before
   * de-duplication counts REQUESTS, not pods. Eight concurrent requests naming one dead slot
   * spent eight units of drain budget between them and then all waited on the single spawn
   * that resulted, so one pod creation exhausted the fuse and blocked recovery for the rest
   * of the window.
   */
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
    /**
     * Consulted once per slot this call actually starts a spawn for, and never for a slot it
     * merely joins. Returning false skips that slot. See the note above on why a quota
     * placed before de-duplication counts the wrong thing.
     */
    admit?: (instance: number) => boolean,
    /**
     * Whether this slot's existing pod must be replaced rather than reused. Per slot, for
     * the same reason as `admit`: one call can cover slots that need opposite treatment.
     */
    recreate?: (instance: number) => boolean,
  ): Promise<AgentBoxHandle[]> {
    // Resolving env/persistence costs an RPC each, so pay it only if a slot turns out to be
    // ours to fill — and resolve it LAZILY rather than up front behind an `if`. Deciding
    // that no slot needs it, and then acting on that decision further down, would be
    // correct only as long as nothing awaits in between; that is invisible to anyone
    // editing this later, and getting it wrong means spawning a pod with an empty env and a
    // default persistence mode. Memoised, so concurrent slots share the one resolution.
    let context: Promise<{ env: Record<string, string>; persistence: boolean | undefined }> | undefined;
    const spawnContext = () => (context ??= (async () => ({
      env: await this.resolveEnv(agentId, config?.env),
      persistence: await this.resolvePersistence(agentId, config?.persistence),
    }))());

    const results = await Promise.all(instances.map((instance) => {
      const key = spawnSlotKey(agentId, instance);
      const wantRecreate = recreate?.(instance) === true;

      // 🔴 De-duplication is only sound between callers that want the SAME THING done to the
      // pod. An attempt started while a Pending pod was still young REUSES it; a caller
      // arriving after the readiness deadline wants it DELETED. Joining the older attempt
      // then left the pod in place and failed everyone with it, costing another full
      // readiness window before anything tried again.
      //
      // So a stronger intent does not join — it starts its own attempt. The two briefly
      // overlap, and that resolves itself: deleting the pod makes the older attempt's
      // readiness wait fail fast ("disappeared while waiting") rather than run to its
      // deadline. The weaker direction still joins, which is the common case.
      const inflight = this.inflightSpawns.get(key);
      if (inflight && (inflight.recreate || !wantRecreate)) return inflight.result;

      // Past the de-dup, so this call is the one creating the pod — the only one that may be
      // charged for it. Synchronous, and before the attempt is registered, so concurrent
      // callers either join the admitted attempt or are refused; none of them pays twice.
      if (admit && !admit(instance)) return Promise.resolve(null);

      const attempt = (async () => {
        try {
          const { env: resolvedEnv, persistence } = await spawnContext();
          const handle = await this.spawner.spawn({
            ...config,
            agentId,
            instance,
            ...(wantRecreate ? { recreate: true } : {}),
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
          this.spawnFailures.delete(key);
          return handle;
        } catch (err) {
          console.warn(`[agentbox-manager] spawn of instance ${instance} for agent=${agentId} failed:`, err);
          this.spawnFailures.set(key, Date.now());
          return null;
        }
      })();

      // A superseded attempt yields to whoever replaced it — REGARDLESS of its own outcome,
      // not merely when it failed.
      //
      // 🔴 The successor's existence means the pod this attempt is about is going to be
      // deleted. So a handle from here is not "a success worth returning", it is an endpoint
      // with a demolition order on it: a Pending pod that turns Ready while the replacement
      // is still resolving its config would otherwise be handed to the original waiters
      // moments before the replacement removes it. Yielding on failure alone covered the
      // common case and left this one, which is worse than the failure — the caller gets an
      // endpoint that looks fine and dies under its first request.
      let successor: Promise<AgentBoxHandle | null> | undefined;
      const result = attempt.then((handle) => successor ?? handle);
      const entry: InflightSpawn = {
        result,
        recreate: wantRecreate,
        adopt: (p) => { successor = p; },
      };
      this.inflightSpawns.set(key, entry);
      // The attempt this one displaced now routes its waiters here. Reached only when the
      // guard above declined to join, i.e. this intent is the stronger one.
      inflight?.adopt(result);
      // Compare before deleting: by the time this settles the entry may already belong to
      // a later attempt for the same slot — including a stronger-intent one that took over.
      void attempt.finally(() => {
        if (this.inflightSpawns.get(key) === entry) this.inflightSpawns.delete(key);
      });
      return result;
    }));
    return results.filter((h): h is AgentBoxHandle => h !== null);
  }

  /**
   * Whether a BACKGROUND fill may try this slot yet.
   *
   * De-duplication alone does not stop a storm: an attempt is removed from the in-flight
   * map the moment it settles, so a failing slot would be retried by the very next request
   * to arrive. Deliberately NOT consulted on the path that has nothing to serve from — a
   * user's turn waiting on the agent's only box must still be allowed to try.
   */
  private mayFillInstance(agentId: string, instance: number): boolean {
    const key = spawnSlotKey(agentId, instance);
    const failedAt = this.spawnFailures.get(key);
    if (failedAt === undefined) return true;
    if (Date.now() - failedAt < SPAWN_RETRY_COOLDOWN_MS) return false;
    this.spawnFailures.delete(key);
    return true;
  }

  /**
   * Drop spawn-failure records nobody will ask about again.
   *
   * `mayFillInstance` clears a slot's record when it is next consulted, which covers every
   * slot still in use — but a slot stops being consulted the moment `replicas` drops below
   * its index, and its record would then outlive the pool shape that produced it. Same
   * reasoning as CRASH_RESPAWN_FORGET_MS; bounded rather than strictly necessary, since the
   * key space is (agents × instances).
   */
  private forgetStaleSpawnFailures(): void {
    const now = Date.now();
    for (const [key, at] of this.spawnFailures) {
      if (now - at > SPAWN_FAILURE_FORGET_MS) this.spawnFailures.delete(key);
    }
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
          this.draining.set(box.boxId, { at: Date.now(), reason: "unresponsive" });
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
      .filter((instance) => this.respawnCooledDown(spawnSlotKey(agentId, instance)))
      // Same for a slot whose last spawn never got off the ground: a roll must not become
      // the path that retries it every tick.
      .filter((instance) => this.mayFillInstance(agentId, instance));
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
    //
    // ORDER: the REPORTING check before the one that SPENDS. A slot can be under both
    // cooldowns — it crashed, and the replacement then failed to start — and the two count
    // different things, so both have to agree. But `mayRespawn` consumes one of three crash
    // attempts when it says yes, while `mayFillInstance` only reports; a slot filtered out
    // after mayRespawn already said yes has paid for a replacement that never happened.
    //
    // With today's constants that cannot actually bite: CRASH_RESPAWN_COOLDOWN_MS (2 min)
    // exceeds SPAWN_RETRY_COOLDOWN_MS (30 s), so mayRespawn's own cooldown — which returns
    // false WITHOUT spending — always blocks first, and the windows never overlap. This
    // order removes the dependency on that coincidence rather than fixing a live defect:
    // tightening the crash cooldown, or lengthening the spawn one, would otherwise make it
    // real, and nothing in either constant's own definition hints at the coupling.
    const allowed = missing
      .filter((instance) => this.mayFillInstance(agentId, instance))
      .filter((instance) => this.mayRespawn(spawnSlotKey(agentId, instance)));
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

    this.forgetStaleSpawnFailures();

    for (const [agentId, pool] of byAgent) {
      // 🔴 GET AN ANSWER FIRST, before anything below can drain, delete or replace a box.
      //
      // Every judgement in this loop body is made against this runtime's own view — the
      // agent's replica count, the expected image, the CA — and the replica count arrives
      // over RPC. With no answer there is nothing to judge against, so skip the agent
      // entirely: no crash healing, no staleness marking, no roll, no shrink. Serving a turn
      // still falls back to one box (resolveReplicas); only destruction needs an answer.
      //
      // Placing this after any of those means the destruction has already happened. It was
      // after the shrink's own `accepting.length <= 1` short-circuit, which skipped the
      // lookup for single-box agents — that saving is what put the question in the wrong
      // place, so it is not a saving worth having.
      //
      // The memo bounds the cost of asking every tick about an agent nobody can answer for.
      // It is scoped to this loop; the serving path must keep asking (see UNOWNED_MEMO_MS).
      const unresolvedAt = this.unresolvedAgents.get(agentId);
      if (unresolvedAt !== undefined && Date.now() - unresolvedAt < UNOWNED_MEMO_MS) continue;
      const replicas = await this.lookupReplicas(agentId);
      if (replicas === undefined) {
        this.unresolvedAgents.set(agentId, Date.now());
        continue;
      }
      this.unresolvedAgents.delete(agentId);

      await this.healCrashedBoxes(agentId, pool);
      const boxes = pool.filter((b) => b.status !== "stopped");
      // Keep a roll moving without waiting for traffic: mark the next stale box once the
      // previous one has gone, and put back what the roll removed. A deploy on a quiet
      // agent would otherwise stop half-done until someone happened to send a message.
      this.markStaleBoxesDraining(agentId, boxes, "agent");
      await this.advanceRoll(agentId, boxes);
      // 🔴 Withdraw a shrink this runtime decided on a replica count it now knows better.
      //
      // `boxes.length`, NOT `accepting.length`: the question is whether the pool would be
      // over-provisioned had nothing been marked, and `accepting` has already had the marks
      // subtracted — asking it can only ever answer "no". A mark is acted on ticks after it
      // is made, and the number that produced it came over RPC, so a single failed lookup
      // (a control-plane restart during a deploy, a dropped WS) used to shrink a live pool
      // permanently: the fallback of 1 marked every box above instance 0, and nothing ever
      // revisited that once the lookup started working again.
      if (boxes.length <= replicas) this.withdrawExcessDrains(agentId, boxes);
      const accepting = boxes.filter((b) => !this.draining.has(b.boxId));
      // One box is both "nothing to shrink" and the un-pooled shape.
      if (accepting.length <= 1) continue;
      if (accepting.length <= replicas) continue;
      const excess = [...accepting]
        .sort((a, b) => (b.instance ?? 0) - (a.instance ?? 0))
        .slice(0, accepting.length - replicas);
      for (const box of excess) {
        console.log(`[agentbox-manager] Draining ${box.boxId} (agent=${agentId}): replicas lowered to ${replicas}`);
        this.draining.set(box.boxId, { at: Date.now(), reason: "excess" });
      }
    }
  }

  /**
   * Un-mark boxes this runtime drained as surplus, now that the pool is not surplus.
   *
   * Only `excess` marks are withdrawn — a `stale` or `unresponsive` verdict is re-reached on
   * re-examination, so withdrawing it would just be re-decided next tick. This also covers
   * the ordinary case of an operator putting `replicas` back up before the shrink completes.
   */
  private withdrawExcessDrains(agentId: string, boxes: AgentBoxInfo[]): void {
    for (const box of boxes) {
      if (this.draining.get(box.boxId)?.reason !== "excess") continue;
      console.log(
        `[agentbox-manager] Keeping ${box.boxId} (agent=${agentId}): the pool is not over its` +
        ` replica count after all, so the shrink that marked it is withdrawn`,
      );
      this.draining.delete(box.boxId);
    }
  }

  private async reapDrainedBoxes(): Promise<void> {
    await this.reconcilePoolSizes();
    if (this.draining.size === 0) return;
    for (const [boxId, mark] of [...this.draining]) {
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
      // 🔴 Re-confirm AT THE POINT OF DESTRUCTION, not only where the mark is made.
      // A drain mark is a decision taken on an earlier tick, and `reconcilePoolSizes` skipping
      // an agent stops NEW marks — it cannot recall one already queued here. If the agent has
      // since become unanswerable, the premise of the decision is gone.
      //
      // The mark is DROPPED rather than held: a held mark keeps the box out of its own pool's
      // `accepting` set forever, since every later tick answers unknown too and never removes
      // it either — a dead entry that degrades the pool. If the reason to drain still holds
      // once the agent is answerable again, the next tick marks it and spends one drain-budget
      // slot doing so, which is exactly the fuse doing its job.
      if (info.agentId && (await this.lookupReplicas(info.agentId)) === undefined) {
        console.warn(
          `[agentbox-manager] dropping the drain mark on ${boxId}: agent=${info.agentId} can no` +
          ` longer be resolved, so the judgement that produced the mark no longer holds`,
        );
        this.draining.delete(boxId);
        continue;
      }

      const overdue = Date.now() - mark.at >= DRAIN_DEADLINE_MS;
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
   * Whether a running pod's mTLS certificate is still usable.
   *
   * TWO independent questions, and for a long time only the first was asked:
   *
   *  1. Does it chain to the runtime's CURRENT CA? A rotated CA invalidates every
   *     certificate signed by the old one.
   *  2. Has it got life left? The leaf is valid for AGENTBOX_CERT_VALIDITY_DAYS, and a
   *     RESIDENT pool box outlives that easily. Expiry is invisible to a fingerprint
   *     comparison, so a box could sit here reading "fresh" while every call in both
   *     directions failed mTLS.
   *
   * Returning false is what gets the box drained and replaced, and replacement is the only
   * repair available: the box reads its certificate off disk once at startup, so re-issuing
   * the Secret underneath a running pod does nothing for it. That is why this looks a
   * renewal window ahead (see AGENTBOX_CERT_RENEW_BEFORE_MS) rather than waiting for actual
   * expiry — the drain, the respawn and the drain budget all have to fit inside it.
   *
   * Fail-open on missing information, in BOTH questions: a spawner that reports no
   * fingerprint (non-mTLS, or cert manager not yet set) and a pod with no expiry label
   * (created before the label existed) are both "no answer", never "stale". Reading a
   * missing label as stale is precisely how a previous version of this drained every
   * freshly created box on sight.
   */
  private isCertFresh(info: AgentBoxInfo): boolean {
    if (!this.isCertUsable(info)) return false;
    return !certificateNeedsRenewal(info.certExpiresAt ?? null);
  }

  /**
   * Whether mTLS with this box can succeed RIGHT NOW — a weaker question than
   * {@link isCertFresh}, and the difference matters for how urgently a box is replaced.
   *
   * A rotated CA or an already-expired leaf means every call in both directions fails, so
   * such a box is worthless and goes immediately. A box merely APPROACHING expiry still
   * works, and must be rolled one at a time like any other stale box: every box of a pool
   * mounts the SAME per-agent Secret and therefore expires at the same moment, so treating
   * "nearing expiry" as urgent would drain the whole pool at once — the very stampede the
   * renewal window exists to avoid.
   */
  private isCertUsable(info: AgentBoxInfo): boolean {
    const want = this.spawner.caFingerprint?.();
    if (!want) return true;
    if (info.caFingerprint !== want) return false;
    return !certificateHasExpired(info.certExpiresAt ?? null);
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
