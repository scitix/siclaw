/**
 * AgentBox Resource Sync
 *
 * Generic resource synchronisation with exponential-backoff retry.
 * Replaces the ad-hoc retry loops in agentbox-main.ts with a
 * resource-type-agnostic implementation.
 */

import type { GatewaySyncClientLike, GatewaySyncType } from "../shared/gateway-sync.js";
import { GATEWAY_SYNC_DESCRIPTORS } from "../shared/gateway-sync.js";
import { getSyncHandler } from "./sync-handlers.js";

/**
 * Synchronise a single resource type from the Gateway to local disk.
 *
 * Uses exponential backoff as configured in the resource descriptor:
 *   delay = baseDelayMs * 2^attempt  (0-indexed)
 *
 * @returns The count returned by the handler's materialize() (e.g. server count).
 * @throws  If all retry attempts are exhausted.
 */
export async function syncResource(
  type: GatewaySyncType,
  client: GatewaySyncClientLike,
): Promise<number> {
  const descriptor = GATEWAY_SYNC_DESCRIPTORS[type];
  const handler = getSyncHandler(type);
  if (!handler) {
    throw new Error(`[gateway-sync] No handler registered for sync type "${type}"`);
  }

  const { maxRetries, baseDelayMs } = descriptor.retry;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const payload = await handler.fetch(client);
      const count = await handler.materialize(payload);

      // Run optional post-reload hook (no sessions during initial sync)
      if (handler.postReload) {
        await handler.postReload({});
      }

      console.log(`[resource-sync] ${type} synced successfully: ${count} items`);
      return count;
    } catch (err: unknown) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[resource-sync] Failed to sync ${type} (attempt ${attempt + 1}/${maxRetries}): ${msg}`,
      );

      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * 2 ** attempt;
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

/**
 * Synchronise all registered resource types sequentially.
 *
 * Errors in one resource do NOT prevent others from being attempted.
 * A summary is logged at the end.
 */
export async function syncAllResources(
  client: GatewaySyncClientLike,
): Promise<{ succeeded: GatewaySyncType[]; failed: GatewaySyncType[] }> {
  // Only types flagged initialSync=true pull at startup. Types whose handlers
  // depend on a later-constructed singleton (e.g. broker) opt out via
  // initialSync=false and rely on lazy-fill by their consumer.
  const types = (Object.keys(GATEWAY_SYNC_DESCRIPTORS) as GatewaySyncType[])
    .filter((t) => GATEWAY_SYNC_DESCRIPTORS[t].initialSync);
  const succeeded: GatewaySyncType[] = [];
  const failed: GatewaySyncType[] = [];

  for (const type of types) {
    try {
      await syncResource(type, client);
      succeeded.push(type);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[resource-sync] ${type} sync failed after all retries: ${msg}`);
      failed.push(type);
    }
  }

  console.log(
    `[resource-sync] syncAllResources complete: succeeded=[${succeeded.join(", ")}] failed=[${failed.join(", ")}]`,
  );

  return { succeeded, failed };
}
