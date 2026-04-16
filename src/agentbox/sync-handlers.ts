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
import {
  extractKnowledgePackageToDir,
  replaceDirectoryContentsFromStaging,
  sanitizeKnowledgeRepoDir,
} from "../shared/knowledge-package.js";
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

// ── Knowledge handler ─────────────────────────────────────────────────

interface KnowledgeBundlePayload {
  version: string;
  repos: Array<{
    id: string;
    name: string;
    version: number;
    message?: string | null;
    sha256?: string | null;
    sizeBytes: number;
    fileCount?: number | null;
    dataBase64: string;
  }>;
}

interface KnowledgeSyncStatus {
  syncedAt: string;
  targetDir: string;
  repoCount: number;
  repos: Array<{
    id: string; name: string; version: number; sha256: string;
    expectedSha256?: string | null; fileCount?: number | null; sizeBytes: number;
  }>;
}

let lastKnowledgeSyncStatus: KnowledgeSyncStatus | null = null;
export function getLastKnowledgeSyncStatus(): KnowledgeSyncStatus | null { return lastKnowledgeSyncStatus; }

export const knowledgeHandler: AgentBoxSyncHandler<KnowledgeBundlePayload> = {
  type: "knowledge",

  async fetch(client: GatewaySyncClientLike | null): Promise<KnowledgeBundlePayload> {
    if (!client) throw new Error("[knowledge] GatewaySyncClientLike required but missing");
    const descriptor = GATEWAY_SYNC_DESCRIPTORS.knowledge;
    const data = await client.request(descriptor.gatewayPath, "GET");
    return data as KnowledgeBundlePayload;
  },

  async materialize(payload: KnowledgeBundlePayload): Promise<number> {
    const repos = payload?.repos ?? [];
    const config = loadConfig();
    const knowledgeDir = path.resolve(process.cwd(), config.paths.knowledgeDir);
    const syncedAt = new Date().toISOString();

    if (repos.length === 0) {
      // Clear knowledge directory — agent has no bound repos
      if (fs.existsSync(knowledgeDir)) {
        for (const entry of fs.readdirSync(knowledgeDir)) {
          if (entry.startsWith(".sync-staging")) continue;
          fs.rmSync(path.join(knowledgeDir, entry), { recursive: true, force: true });
        }
      }
      lastKnowledgeSyncStatus = { syncedAt, targetDir: knowledgeDir, repoCount: 0, repos: [] };
      return 0;
    }

    fs.mkdirSync(knowledgeDir, { recursive: true });
    const stagingDir = path.join(knowledgeDir, `.sync-staging-${Date.now()}-${process.pid}`);
    fs.mkdirSync(stagingDir, { recursive: true });
    const syncedRepos: KnowledgeSyncStatus["repos"] = [];

    try {
      if (repos.length === 1) {
        const buf = Buffer.from(repos[0].dataBase64, "base64");
        const info = await extractKnowledgePackageToDir(buf, stagingDir);
        if (repos[0].sha256 && repos[0].sha256 !== info.sha256) {
          throw new Error(`Checksum mismatch for ${repos[0].name}: expected ${repos[0].sha256}, got ${info.sha256}`);
        }
        syncedRepos.push({ id: repos[0].id, name: repos[0].name, version: repos[0].version,
          sha256: info.sha256, expectedSha256: repos[0].sha256 ?? null, fileCount: info.fileCount, sizeBytes: repos[0].sizeBytes });
      } else {
        const repoRoot = path.join(stagingDir, "repos");
        fs.mkdirSync(repoRoot, { recursive: true });
        const indexLines = ["# Knowledge Index", "", "This index was generated from active knowledge repositories.", ""];
        for (const repo of repos) {
          const dirName = sanitizeKnowledgeRepoDir(repo.name);
          const target = path.join(repoRoot, dirName);
          const buf = Buffer.from(repo.dataBase64, "base64");
          const info = await extractKnowledgePackageToDir(buf, target);
          if (repo.sha256 && repo.sha256 !== info.sha256) {
            throw new Error(`Checksum mismatch for ${repo.name}: expected ${repo.sha256}, got ${info.sha256}`);
          }
          syncedRepos.push({ id: repo.id, name: repo.name, version: repo.version,
            sha256: info.sha256, expectedSha256: repo.sha256 ?? null, fileCount: info.fileCount, sizeBytes: repo.sizeBytes });
          indexLines.push(`- [[repos/${dirName}/index]] - ${repo.name} v${repo.version}`);
        }
        fs.writeFileSync(path.join(stagingDir, "index.md"), indexLines.join("\n") + "\n");
      }

      fs.writeFileSync(path.join(stagingDir, ".sync-manifest.json"),
        JSON.stringify({ syncedAt, version: payload.version ?? "1", repos: syncedRepos }, null, 2) + "\n");
      await replaceDirectoryContentsFromStaging(knowledgeDir, stagingDir);
      lastKnowledgeSyncStatus = { syncedAt, targetDir: knowledgeDir, repoCount: syncedRepos.length, repos: syncedRepos };
      return repos.length;
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    }
  },

  async postReload(context: ReloadContext): Promise<void> {
    if (!context.sessions?.length) return;
    for (const session of context.sessions) {
      try {
        await session.brain.reload();
        console.log(`[resource-sync] Knowledge reloaded for session ${session.id}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[resource-sync] Failed to reload knowledge for session ${session.id}: ${msg}`);
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
 * HttpTransport. The framework's generic HTTP client is the wrong tool here.
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
  ["knowledge", knowledgeHandler],
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
