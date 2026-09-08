/**
 * Box acquisition for capability runs (kb-compile and friends).
 *
 * A capability run's box is SINGLE-USE and keyed by the runId: the pod's identity
 * is the run. That makes it fundamentally different from a chat agent's pool,
 * and the difference matters on one path — acquisition. `getOrCreate*` compares
 * a running box against the image the profile would spawn today and ROLLS a box
 * it judges stale (markStaleBoxesDraining / getOrCreateK8s rollReason): the old
 * pod is marked draining, a replacement comes up, and the caller is handed the
 * replacement. For a chat pool that is a rolling upgrade. For a kbc box it is
 * abandoning the run it is executing: the relay attaches to an empty replacement,
 * the old pod is deleted at the drain deadline, and whatever the compile still
 * had to emit — the candidate commit included — dies with it.
 *
 * 2026-09-07 incident: a siclaw release restarted the runtime; boot recovery
 * re-attached a live compile run through acquisition, the box was rolled for its
 * (unchanged) image, the run idled on the new pod and the watchdog closed it as
 * "done" two hours later. The knowledge base showed "ready to generate" with no
 * trace of the failure.
 *
 * Rule: a LIVE box for this run is reused as-is, regardless of image, cert
 * freshness or anything else acquisition would roll on. Only a missing/dead box
 * goes through spawn. Image changes reach kbc boxes the way they always did —
 * every run is a new pod.
 */

export interface CapabilityBoxHandleLike {
  endpoint: string;
}

export interface CapabilityBoxAcquirer {
  /** The run's live box, if one is running right now. Never spawns, never rolls. */
  getAsync(agentId: string, profile?: string): Promise<CapabilityBoxHandleLike | undefined>;
  getOrCreateWithDisposition?(
    agentId: string,
    config: { profile: string; orgId?: string },
  ): Promise<{ handle: CapabilityBoxHandleLike; created: boolean }>;
  getOrCreate(
    agentId: string,
    config: { profile: string; orgId?: string },
  ): Promise<CapabilityBoxHandleLike>;
}

export interface CapabilityBoxAcquisition {
  endpoint: string;
  /** true only when THIS call spawned the box (so failed setup may dispose of it). */
  created: boolean;
}

export async function acquireCapabilityBox(
  manager: CapabilityBoxAcquirer,
  runId: string,
  profile: string,
  orgId?: string,
): Promise<CapabilityBoxAcquisition> {
  const live = await manager.getAsync(runId, profile);
  if (live?.endpoint) {
    return { endpoint: live.endpoint, created: false };
  }
  // Compatibility for embedded managers/test doubles built before acquisition
  // disposition existed. The concrete manager always reports it; an older
  // implementation is conservatively treated as the creator so failed setup
  // retains the historical cleanup behavior.
  if (typeof manager.getOrCreateWithDisposition === "function") {
    const acquired = await manager.getOrCreateWithDisposition(runId, { profile, orgId });
    return { endpoint: acquired.handle.endpoint, created: acquired.created };
  }
  const handle = await manager.getOrCreate(runId, { profile, orgId });
  return { endpoint: handle.endpoint, created: true };
}
