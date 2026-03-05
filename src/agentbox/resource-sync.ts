/**
 * AgentBox Resource Sync
 *
 * Generic resource synchronisation with exponential-backoff retry.
 * Replaces the ad-hoc retry loops in agentbox-main.ts with a
 * resource-type-agnostic implementation.
 */

import type { GatewayClientLike, ResourceType } from "../shared/resource-sync.js";
import { RESOURCE_DESCRIPTORS } from "../shared/resource-sync.js";
import { getResourceHandler } from "./resource-handlers.js";

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
  type: ResourceType,
  client: GatewayClientLike,
): Promise<number> {
  const descriptor = RESOURCE_DESCRIPTORS[type];
  const handler = getResourceHandler(type);
  if (!handler) {
    throw new Error(`[resource-sync] No handler registered for resource type "${type}"`);
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
  client: GatewayClientLike,
): Promise<{ succeeded: ResourceType[]; failed: ResourceType[] }> {
  const types = Object.keys(RESOURCE_DESCRIPTORS) as ResourceType[];
  const succeeded: ResourceType[] = [];
  const failed: ResourceType[] = [];

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
