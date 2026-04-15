/**
 * AgentBox Sync Handlers
 *
 * Concrete AgentBoxSyncHandler implementations for each GatewaySyncType.
 * Each handler knows how to fetch, materialize, and optionally post-reload
 * a specific syncable type.
 *
 * These handlers are consumed by the generic syncResource() function in
 * resource-sync.ts, as well as by the HTTP reload endpoints.
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig, reloadConfig, writeConfig } from "../core/config.js";
import type {
  GatewaySyncType,
  AgentBoxSyncHandler,
  GatewaySyncClientLike,
  ReloadContext,
} from "../shared/gateway-sync.js";
import { GATEWAY_SYNC_DESCRIPTORS } from "../shared/gateway-sync.js";
import { resolveUnderDir } from "../shared/path-utils.js";

// ── MCP handler ───────────────────────────────────────────────────────

/**
 * Payload shape returned by the Gateway's /api/internal/mcp-servers.
 */
interface McpPayload {
  mcpServers: Record<string, unknown>;
}

export const mcpHandler: AgentBoxSyncHandler<McpPayload> = {
  type: "mcp",

  async fetch(client: GatewaySyncClientLike | null): Promise<McpPayload> {
    if (!client) throw new Error("[mcp] GatewaySyncClientLike required but missing");
    const descriptor = GATEWAY_SYNC_DESCRIPTORS.mcp;
    const data = await client.request(descriptor.gatewayPath, "GET");
    return data as McpPayload;
  },

  async materialize(payload: McpPayload): Promise<number> {
    const config = loadConfig();
    // Gateway payload is the source of truth — replace, not merge.
    // Object.assign would keep stale keys when Gateway returns {} (all disabled).
    const mcpServers = payload?.mcpServers ?? {};
    writeConfig({ ...config, mcpServers });
    return Object.keys(mcpServers).length;
  },

  async postReload(): Promise<void> {
    // Reload the in-memory config so subsequent sessions see the new MCP servers.
    reloadConfig();
  },
};

// ── Skills helpers ────────────────────────────────────────────────────

/** Write a single skill (specs + scripts) into the resolved directory */
function writeSkillToDir(
  resolvedDir: string,
  skill: { dirName: string; specs: string; scripts: Array<{ name: string; content: string }> },
): void {
  const skillDir = resolveUnderDir(resolvedDir, skill.dirName);
  fs.mkdirSync(skillDir, { recursive: true });
  if (skill.specs) {
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), skill.specs);
  }
  if (skill.scripts.length > 0) {
    const scriptsDir = path.join(skillDir, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const script of skill.scripts) {
      const scriptPath = resolveUnderDir(scriptsDir, script.name);
      fs.writeFileSync(scriptPath, script.content, { mode: 0o755 });
    }
  }
}

// ── Skills handler ────────────────────────────────────────────────────

/**
 * Payload shape returned by the Gateway's /api/internal/skills/bundle.
 */
interface SkillBundlePayload {
  version: string;
  skills: Array<{
    dirName: string;
    scope: "builtin" | "global";
    specs: string;
    scripts: Array<{ name: string; content: string }>;
    skillSpaceId?: string;
  }>;
}

export const skillsHandler: AgentBoxSyncHandler<SkillBundlePayload> = {
  type: "skills",

  async fetch(client: GatewaySyncClientLike | null): Promise<SkillBundlePayload> {
    if (!client) throw new Error("[skills] GatewaySyncClientLike required but missing");
    const descriptor = GATEWAY_SYNC_DESCRIPTORS.skills;
    const data = await client.request(descriptor.gatewayPath, "GET");
    return data as SkillBundlePayload;
  },

  async materialize(payload: SkillBundlePayload): Promise<number> {
    const config = loadConfig();
    const skillsDir = path.resolve(process.cwd(), config.paths.skillsDir);

    // Build a flat unified "resolved/" directory with priority-based merging:
    //   global > builtin
    // First dirName written wins; later duplicates are skipped.
    // All scopes come from the bundle payload (including builtin, synced to DB at startup).
    const resolvedDir = path.join(skillsDir, "resolved");

    // Clear and recreate resolved/
    if (fs.existsSync(resolvedDir)) {
      fs.rmSync(resolvedDir, { recursive: true });
    }
    fs.mkdirSync(resolvedDir, { recursive: true });

    const seen = new Set<string>();

    // Write in priority order: global > builtin
    for (const scope of ["global", "builtin"] as const) {
      for (const skill of payload.skills.filter(s => s.scope === scope)) {
        if (seen.has(skill.dirName)) continue;
        seen.add(skill.dirName);
        writeSkillToDir(resolvedDir, skill);
      }
    }

    return seen.size;
  },

  async postReload(context: ReloadContext): Promise<void> {
    if (!context.sessions?.length) return;

    for (const session of context.sessions) {
      try {
        await session.brain.reload();
        console.log(`[resource-sync] Skills reloaded for session ${session.id}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[resource-sync] Failed to reload skills for session ${session.id}: ${msg}`);
      }
    }
  },
};

// ── Cluster / Host handlers (factory, broker-dependent) ───────────────

import type { CredentialBroker } from "./credential-broker.js";

/**
 * cluster handler — refresh cluster metadata Map on notify.
 *
 * Does NOT use GatewaySyncClientLike: the CredentialBroker carries its own
 * CredentialTransport that already abstracts HTTP-mTLS (K8s mode) and
 * in-process direct call (Local mode). The framework's generic HTTP client
 * is the wrong tool here — in Local mode it would be null.
 *
 * Consequence: fetch() drives the entire refresh; materialize() is a
 * no-op that just returns the count for the framework log line.
 */
export function createClusterHandler(broker: CredentialBroker): AgentBoxSyncHandler<number> {
  return {
    type: "cluster",
    async fetch(_client): Promise<number> {
      const metas = await broker.refreshClusters();
      return metas.length;
    },
    async materialize(count: number): Promise<number> {
      return count;
    },
  };
}

/** host handler — mirror of cluster handler. */
export function createHostHandler(broker: CredentialBroker): AgentBoxSyncHandler<number> {
  return {
    type: "host",
    async fetch(_client): Promise<number> {
      const metas = await broker.refreshHosts();
      return metas.length;
    },
    async materialize(count: number): Promise<number> {
      return count;
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────

const handlers = new Map<GatewaySyncType, AgentBoxSyncHandler<any>>([
  ["mcp", mcpHandler],
  ["skills", skillsHandler],
]);

/**
 * Look up the static handler for a given sync type. Only mcp and skills
 * are registered here — their handlers are process-global and carry no
 * per-session state.
 *
 * cluster/host handlers are NOT registered in this map: each AgentBox
 * httpServer constructs its own factory-bound instance (closing over
 * that server's broker) and wires it directly into the reload route.
 * Routing cluster/host through a module-level Map would let Local mode's
 * multi-spawn pattern silently pick the wrong broker on notify.
 */
export function getSyncHandler(type: GatewaySyncType): AgentBoxSyncHandler<any> | undefined {
  return handlers.get(type);
}
