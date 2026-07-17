/**
 * Reverse delegation invalidation.
 *
 * When a MEMBER (sre / peer) agent's roster-visible state changes — its own
 * attributes (name / description / status / is_production), its cluster/host
 * bindings, a bound cluster/host being renamed or deleted, or the member agent
 * itself being deleted — every COORDINATOR that delegates to it holds a stale
 * routing manifest (`config.getDelegates` derives the member's name, coverage and
 * active status).
 *
 * The roster is part of the coordinator's TOOLSET (delegate_to_agent's
 * availability + its manifest text), so a `tools` reload invalidates the
 * coordinator's live sessions and the next turn re-fetches it
 * (getOrCreate → fetchDelegates). This gives the coordinator the SAME refresh
 * treatment the member (sre) agent already gets on the same change — the single
 * place that reverse-notify is expressed, so every mutation path stays aligned.
 *
 * Best-effort + fire-and-forget: a failure here must never fail the mutation that
 * triggered it. Callers `void` the promise.
 */

import { getDb } from "../gateway/db.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

/**
 * Notify the coordinators that delegate to any of `memberAgentIds` to reload their
 * toolset (→ roster re-fetch). De-dupes members and coordinators; no-op on empty.
 */
export async function notifyCoordinatorsForMembers(
  connectionMap: RuntimeConnectionMap,
  memberAgentIds: string[],
): Promise<void> {
  const coordinatorIds = await collectDependentCoordinators(memberAgentIds);
  notifyCoordinators(connectionMap, coordinatorIds);
}

/**
 * Resolve the coordinator ids that delegate to any of `memberAgentIds`. Split out
 * from the notify so a caller that DELETES a member can capture the ids BEFORE the
 * FK cascade removes the `agent_delegates` reverse rows, then notify AFTER the delete
 * (otherwise the coordinator re-fetches a roster that still lists the doomed member).
 * De-dupes; returns [] on empty input or a DB error (best-effort).
 */
export async function collectDependentCoordinators(memberAgentIds: string[]): Promise<string[]> {
  const members = [...new Set(memberAgentIds.filter(Boolean))];
  if (members.length === 0) return [];
  try {
    const db = getDb();
    const placeholders = members.map(() => "?").join(", ");
    const [rows] = await db.query(
      `SELECT DISTINCT coordinator_agent_id FROM agent_delegates WHERE member_agent_id IN (${placeholders})`,
      members,
    ) as [Array<{ coordinator_agent_id: string }>, unknown];
    return rows.map((r) => r.coordinator_agent_id).filter(Boolean);
  } catch (err) {
    console.warn("[coordinator-invalidation] failed to resolve dependent coordinators:", err);
    return [];
  }
}

/** Send each coordinator a `tools` reload (→ roster re-fetch on its next turn).
 *  Per-coordinator try/catch: a synchronous notify/ws.send failure on one bad
 *  connection must neither escape (callers `void` this — an escape would be an
 *  unhandled rejection) nor block the remaining coordinators' reloads. */
export function notifyCoordinators(connectionMap: RuntimeConnectionMap, coordinatorIds: string[]): void {
  for (const id of [...new Set(coordinatorIds.filter(Boolean))]) {
    try {
      connectionMap.notify(id, "agent.reload", { agentId: id, resources: ["tools"] });
    } catch (err) {
      console.warn(`[coordinator-invalidation] notify failed for coordinator ${id}:`, err);
    }
  }
}
