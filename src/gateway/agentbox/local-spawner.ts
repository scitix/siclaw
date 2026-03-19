/**
 * Local AgentBox Spawner
 *
 * Spawner for local development; runs the AgentBox HTTP server within the same process.
 * Each user gets an independent port.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo } from "./types.js";
import { createHttpServer } from "../../agentbox/http-server.js";
import { AgentBoxSessionManager } from "../../agentbox/session.js";
// local-only shortcut: same process, import agentbox resource handlers directly
// to avoid HTTP + mTLS round-trip that is only needed for cross-process (K8s) mode.
import { mcpHandler, skillsHandler } from "../../agentbox/resource-handlers.js";
import { buildMergedMcpConfig } from "../mcp-config-builder.js";
import { loadConfig } from "../../core/config.js";
import type { McpServerRepository } from "../db/repositories/mcp-server-repo.js";
import type { ResourceType } from "../../shared/resource-sync.js";
import { resolveUnderDir } from "../../shared/path-utils.js";
import type { MemoryIndexer } from "../../memory/index.js";

interface LocalBox {
  userId: string;
  port: number;
  httpServer: http.Server;
  sessionManager: AgentBoxSessionManager;
  createdAt: Date;
}

/** Function type for fetching a skill bundle for a given user */
export type SkillBundleProvider = (userId: string, env: "prod" | "dev" | "test") => Promise<{
  version: string;
  skills: Array<{ dirName: string; specs: string; scripts: Array<{ name: string; content: string }> }>;
  disabledBuiltins: string[];
}>;

export class LocalSpawner implements BoxSpawner {
  readonly name = "local";

  private boxes = new Map<string, LocalBox>();
  private basePort: number;
  private nextPort: number;

  /** Injected DB-backed MCP repository (set via setMcpRepo) */
  private mcpRepo: McpServerRepository | null = null;
  /** Injected skill bundle provider (set via setSkillBundleProvider) */
  private skillBundleProvider: SkillBundleProvider | null = null;
  /** Injected knowledge base indexer (set via setKnowledgeIndexer) */
  private knowledgeIndexer: MemoryIndexer | null = null;

  constructor(basePort = 4000) {
    this.basePort = basePort;
    this.nextPort = basePort;
  }

  /** Inject McpServerRepository for local resource sync */
  setMcpRepo(repo: McpServerRepository | null): void {
    this.mcpRepo = repo;
  }

  /** Inject skill bundle provider for local resource sync */
  setSkillBundleProvider(provider: SkillBundleProvider): void {
    this.skillBundleProvider = provider;
  }

  /** Inject knowledge base indexer for local knowledge_search */
  setKnowledgeIndexer(indexer: MemoryIndexer): void {
    this.knowledgeIndexer = indexer;
  }

  async spawn(config: AgentBoxConfig): Promise<AgentBoxHandle> {
    const { userId } = config;
    const workspaceId = config.workspaceId || "default";
    const boxId = `local-${userId}-${workspaceId}`;

    // Check if already exists
    const existing = this.boxes.get(boxId);
    if (existing) {
      return {
        boxId,
        endpoint: `http://127.0.0.1:${existing.port}`,
        userId,
      };
    }

    // Allocate port
    const port = this.nextPort++;

    // Sync resources from DB before starting the AgentBox
    await this.syncResources(userId);

    // Create session manager and HTTP server
    const sessionManager = new AgentBoxSessionManager();
    // Set userId so sessions created in this box use per-user skill directories
    sessionManager.userId = userId;
    // Pass knowledge indexer for knowledge_search tool
    if (this.knowledgeIndexer) {
      sessionManager.knowledgeIndexer = this.knowledgeIndexer;
    }
    const httpServer = createHttpServer(sessionManager);

    // Start server
    await new Promise<void>((resolve, reject) => {
      httpServer.listen(port, "127.0.0.1", () => {
        console.log(`[local-spawner] AgentBox for ${userId} started on port ${port}`);
        resolve();
      });
      httpServer.on("error", reject);
    });

    const box: LocalBox = {
      userId,
      port,
      httpServer,
      sessionManager,
      createdAt: new Date(),
    };

    this.boxes.set(boxId, box);

    return {
      boxId,
      endpoint: `http://127.0.0.1:${port}`,
      userId,
    };
  }

  async stop(boxId: string): Promise<void> {
    const box = this.boxes.get(boxId);
    if (!box) return;

    console.log(`[local-spawner] Stopping AgentBox: ${boxId}`);

    await box.sessionManager.closeAll();
    box.httpServer.close();
    this.boxes.delete(boxId);
  }

  async get(boxId: string): Promise<AgentBoxInfo | null> {
    const box = this.boxes.get(boxId);
    if (!box) return null;

    return {
      boxId,
      userId: box.userId,
      status: "running",
      endpoint: `http://127.0.0.1:${box.port}`,
      createdAt: box.createdAt,
      lastActiveAt: box.createdAt,
    };
  }

  async list(): Promise<AgentBoxInfo[]> {
    const result: AgentBoxInfo[] = [];
    for (const [boxId, box] of this.boxes) {
      result.push({
        boxId,
        userId: box.userId,
        status: "running",
        endpoint: `http://127.0.0.1:${box.port}`,
        createdAt: box.createdAt,
        lastActiveAt: box.createdAt,
      });
    }
    return result;
  }

  async cleanup(): Promise<void> {
    console.log(`[local-spawner] Cleaning up ${this.boxes.size} boxes...`);
    for (const boxId of this.boxes.keys()) {
      await this.stop(boxId);
    }
  }

  // ── Local resource sync (bypasses HTTP + mTLS) ─────────────────────

  /**
   * Sync MCP + Skills from DB directly into the AgentBox filesystem.
   * Called on spawn (initial sync) and on reload (hot update).
   */
  private async syncResources(userId: string): Promise<void> {
    await this.syncMcp();
    await this.syncSkills(userId);
  }

  /** Sync MCP servers: read DB-only config, let materialize merge with local seed */
  private async syncMcp(): Promise<void> {
    try {
      // Pass null as localConfig so buildMergedMcpConfig returns DB entries only.
      // mcpHandler.materialize() will merge local seed internally.
      const dbOnly = await buildMergedMcpConfig(null, this.mcpRepo);
      const count = await mcpHandler.materialize({ mcpServers: dbOnly });
      if (count > 0) {
        console.log(`[local-spawner] MCP sync: ${count} servers materialized`);
      }
    } catch (err: any) {
      console.warn(`[local-spawner] MCP sync failed: ${err.message}`);
    }
  }

  /**
   * Sync skills for a user into a per-user directory.
   *
   * Unlike skillsHandler.materialize() which clears the entire skillsDir,
   * this writes to {skillsBase}/user/{userId}/ so multiple users don't
   * overwrite each other's skills in local (shared-process) mode.
   */
  private async syncSkills(userId: string): Promise<void> {
    if (!this.skillBundleProvider) {
      console.warn(`[local-spawner] Skills sync skipped: no bundle provider configured`);
      return;
    }
    try {
      const bundle = await this.skillBundleProvider(userId, "prod");
      const config = loadConfig();
      const skillsBase = path.resolve(process.cwd(), config.paths.skillsDir);
      const userSkillsDir = path.join(skillsBase, "user", userId);

      // Clear only this user's directory (not other users or core/team)
      if (fs.existsSync(userSkillsDir)) {
        for (const entry of fs.readdirSync(userSkillsDir)) {
          if (entry.startsWith(".")) continue;
          fs.rmSync(path.join(userSkillsDir, entry), { recursive: true });
        }
      } else {
        fs.mkdirSync(userSkillsDir, { recursive: true });
      }

      // Write skills into per-user directory
      for (const skill of bundle.skills) {
        const skillDir = resolveUnderDir(userSkillsDir, skill.dirName);
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

      // Write disabled builtins list into per-user directory
      const disabledFile = path.join(userSkillsDir, ".disabled-builtins.json");
      if (bundle.disabledBuiltins?.length) {
        fs.writeFileSync(disabledFile, JSON.stringify(bundle.disabledBuiltins));
      } else if (fs.existsSync(disabledFile)) {
        fs.unlinkSync(disabledFile);
      }

      if (bundle.skills.length > 0) {
        console.log(`[local-spawner] Skills sync for ${userId}: ${bundle.skills.length} skills → ${userSkillsDir}`);
      }
    } catch (err: any) {
      console.warn(`[local-spawner] Skills sync failed for ${userId}: ${err.message}`);
    }
  }

  /**
   * Reload a resource type across all local boxes.
   * Called by the resource notifier's localReloader callback.
   */
  async reloadResource(type: ResourceType, userId?: string): Promise<void> {
    if (type === "mcp") {
      // MCP is a global resource (not user-scoped), so userId is intentionally ignored.
      await this.syncMcp();
      // postReload: reloadConfig so next session creation uses new MCP config
      await mcpHandler.postReload?.({});
    } else if (type === "skills") {
      // Skills are user-scoped: sync for specific user or all users
      const targetBoxes = userId
        ? [...this.boxes.values()].filter((b) => b.userId === userId)
        : [...this.boxes.values()];

      for (const box of targetBoxes) {
        await this.syncSkills(box.userId);
        // postReload: tell active sessions to brain.reload()
        const sessions = box.sessionManager.list().map((s) => ({
          id: s.id,
          brain: s.brain,
        }));
        await skillsHandler.postReload?.({ sessions });
      }
    }
  }

}
