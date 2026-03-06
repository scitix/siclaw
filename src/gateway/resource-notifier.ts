/**
 * Gateway Resource Notifier
 *
 * Factory that creates a ResourceNotifier implementation.
 * Iterates over active AgentBoxes (via AgentBoxManager) and POSTs to
 * each box's reload endpoint, collecting success / failure counts.
 *
 * Modelled after the existing notifyMcpChange() and notifySkillReload()
 * in rpc-methods.ts — this is the generic, resource-agnostic replacement.
 */

import { AgentBoxClient, type AgentBoxTlsOptions } from "./agentbox/client.js";
import type { AgentBoxHandle, AgentBoxInfo } from "./agentbox/types.js";
import type {
  ResourceDescriptor,
  ResourceNotifier,
  NotifyResult,
  ResourceType,
} from "../shared/resource-sync.js";

/**
 * Minimal subset of AgentBoxManager that the notifier needs.
 * Uses list() for K8s compatibility (activeUserIds/getForUser return [] in K8s mode).
 */
export interface AgentBoxManagerLike {
  activeUserIds(): string[];
  getForUser(userId: string): AgentBoxHandle[];
  list(): Promise<AgentBoxInfo[]>;
}

/**
 * Optional callback for local-mode resource reload.
 * When provided, the notifier calls this instead of HTTP POST.
 */
export type LocalReloader = (type: ResourceType, userId?: string) => Promise<void>;

/**
 * Create a ResourceNotifier backed by a live AgentBoxManager.
 *
 * @param manager  Something that can list active users / boxes.
 * @param tlsOpts  Optional mTLS options forwarded to AgentBoxClient.
 * @param localReloader  Optional callback for local-mode in-process reload.
 *                       When set, bypasses HTTP and calls the spawner directly.
 */
export function createResourceNotifier(
  manager: AgentBoxManagerLike,
  tlsOpts?: AgentBoxTlsOptions,
  localReloader?: LocalReloader,
): ResourceNotifier {
  // ── helpers ────────────────────────────────────────────────────────

  /**
   * POST the reload endpoint on a single AgentBox via the generic
   * `reloadResource()` method — no per-type switch required.
   */
  async function reloadBox(
    handle: AgentBoxHandle,
    descriptor: ResourceDescriptor,
  ): Promise<{ userId: string; boxId: string; ok: boolean; detail?: unknown }> {
    const client = new AgentBoxClient(handle.endpoint, 30000, tlsOpts);
    try {
      const detail = await client.reloadResource(descriptor.type);
      return { userId: handle.userId, boxId: handle.boxId, ok: true, detail };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[resource-notify] Failed to notify ${descriptor.type} reload for ` +
          `userId=${handle.userId} box=${handle.boxId}: ${msg}`,
      );
      return { userId: handle.userId, boxId: handle.boxId, ok: false };
    }
  }

  /** Notify a set of handles and return aggregated result. */
  async function notifyHandles(
    descriptor: ResourceDescriptor,
    handles: AgentBoxHandle[],
  ): Promise<NotifyResult> {
    const promises = handles.map((h) => reloadBox(h, descriptor));
    const results = await Promise.all(promises);

    let success = 0;
    let failed = 0;
    for (const r of results) {
      if (r.ok) {
        success++;
        console.log(
          `[resource-notify] ${descriptor.type} reload OK for userId=${r.userId} box=${r.boxId}`,
        );
      } else {
        failed++;
      }
    }

    if (handles.length > 0) {
      console.log(
        `[resource-notify] ${descriptor.type} notification complete: ${success} succeeded, ${failed} failed`,
      );
    }

    return { resourceType: descriptor.type, success, failed };
  }

  // ── public API ─────────────────────────────────────────────────────

  return {
    async notifyAll(descriptor: ResourceDescriptor): Promise<NotifyResult> {
      // Local mode: in-process reload, no HTTP round-trip
      if (localReloader) {
        try {
          await localReloader(descriptor.type);
          const boxCount = Math.max(1, manager.activeUserIds().length);
          console.log(`[resource-notify] ${descriptor.type} local reload OK (${boxCount} boxes)`);
          return { resourceType: descriptor.type, success: boxCount, failed: 0 };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[resource-notify] ${descriptor.type} local reload failed: ${msg}`);
          return { resourceType: descriptor.type, success: 0, failed: 1 };
        }
      }

      // Remote mode: HTTP POST to each AgentBox
      // Try in-memory cache first (local dev), fall back to async list (K8s)
      let handles: AgentBoxHandle[] = [];
      const userIds = manager.activeUserIds();
      if (userIds.length > 0) {
        for (const userId of userIds) {
          handles.push(...manager.getForUser(userId));
        }
      } else {
        // K8s mode: activeUserIds() returns [], query pods via spawner
        const boxes = await manager.list();
        handles = boxes.map((b) => ({ boxId: b.boxId, userId: b.userId, endpoint: b.endpoint }));
      }
      return notifyHandles(descriptor, handles);
    },

    async notifyUser(descriptor: ResourceDescriptor, userId: string): Promise<NotifyResult> {
      // Local mode: in-process reload scoped to user
      if (localReloader) {
        try {
          await localReloader(descriptor.type, userId);
          console.log(`[resource-notify] ${descriptor.type} local reload OK for userId=${userId}`);
          return { resourceType: descriptor.type, success: 1, failed: 0 };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[resource-notify] ${descriptor.type} local reload failed for userId=${userId}: ${msg}`);
          return { resourceType: descriptor.type, success: 0, failed: 1 };
        }
      }

      // Remote mode: HTTP POST to user's AgentBoxes
      // Try in-memory cache first (local dev), fall back to async list (K8s)
      let handles = manager.getForUser(userId);
      if (handles.length === 0) {
        // K8s mode: getForUser() returns [], query pods via spawner
        const boxes = await manager.list();
        handles = boxes
          .filter((b) => b.userId === userId)
          .map((b) => ({ boxId: b.boxId, userId: b.userId, endpoint: b.endpoint }));
      }
      if (handles.length === 0) {
        return { resourceType: descriptor.type, success: 0, failed: 0 };
      }
      return notifyHandles(descriptor, handles);
    },
  };
}
