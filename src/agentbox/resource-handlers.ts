/**
 * AgentBox Resource Handlers
 *
 * Concrete AgentBoxResourceHandler implementations for each ResourceType.
 * Each handler knows how to fetch, materialize, and optionally post-reload
 * a specific resource.
 *
 * These handlers are consumed by the generic syncResource() function in
 * resource-sync.ts, as well as by the HTTP reload endpoints (Phase 2).
 */

import fs from "node:fs";
import path from "node:path";
import { loadConfig, reloadConfig, writeConfig } from "../core/config.js";
import type {
  ResourceType,
  AgentBoxResourceHandler,
  GatewayClientLike,
  ReloadContext,
} from "../shared/resource-sync.js";
import { RESOURCE_DESCRIPTORS } from "../shared/resource-sync.js";

// ── MCP handler ───────────────────────────────────────────────────────

/**
 * Payload shape returned by the Gateway's /api/internal/mcp-servers.
 */
interface McpPayload {
  mcpServers: Record<string, unknown>;
}

export const mcpHandler: AgentBoxResourceHandler<McpPayload> = {
  type: "mcp",

  async fetch(client: GatewayClientLike): Promise<McpPayload> {
    const descriptor = RESOURCE_DESCRIPTORS.mcp;
    const data = await client.request(descriptor.gatewayPath, "GET");
    return data as McpPayload;
  },

  async materialize(payload: McpPayload): Promise<number> {
    const config = loadConfig();
    const merged: Record<string, unknown> = {};
    // Preserve existing mcpServers from settings.json as base
    if (config.mcpServers) Object.assign(merged, config.mcpServers);
    // Gateway payload overwrites
    if (payload?.mcpServers) Object.assign(merged, payload.mcpServers);

    config.mcpServers = merged;
    writeConfig(config);
    return Object.keys(merged).length;
  },

  async postReload(): Promise<void> {
    // Reload the in-memory config so subsequent sessions see the new MCP servers.
    reloadConfig();
  },
};

// ── Skills handler ────────────────────────────────────────────────────

/**
 * Payload shape returned by the Gateway's /api/internal/skills/bundle.
 */
interface SkillBundlePayload {
  version: string;
  skills: Array<{
    dirName: string;
    scope: "team" | "personal";
    specs: string;
    scripts: Array<{ name: string; content: string }>;
  }>;
  disabledBuiltins?: string[];
}

export const skillsHandler: AgentBoxResourceHandler<SkillBundlePayload> = {
  type: "skills",

  async fetch(client: GatewayClientLike): Promise<SkillBundlePayload> {
    const descriptor = RESOURCE_DESCRIPTORS.skills;
    const data = await client.request(descriptor.gatewayPath, "GET");
    return data as SkillBundlePayload;
  },

  async materialize(payload: SkillBundlePayload): Promise<number> {
    const config = loadConfig();
    const skillsDir = path.resolve(process.cwd(), config.paths.skillsDir);

    // Clear only bundle-managed scope subdirectories (team/ and user/)
    // Never wipe the entire skillsDir — that would destroy core/ and other dirs
    if (fs.existsSync(skillsDir)) {
      for (const scopeDir of ["team", "user"]) {
        const scopePath = path.join(skillsDir, scopeDir);
        if (fs.existsSync(scopePath)) {
          fs.rmSync(scopePath, { recursive: true });
        }
      }
    } else {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    for (const skill of payload.skills) {
      // Write into scope subdirectory so getSkillScriptDirs() layer 2 matches naturally
      const scopeDir = skill.scope === "personal" ? "user" : "team";
      const skillDir = path.join(skillsDir, scopeDir, skill.dirName);
      fs.mkdirSync(skillDir, { recursive: true });

      if (skill.specs) {
        fs.writeFileSync(path.join(skillDir, "SKILL.md"), skill.specs);
      }

      if (skill.scripts.length > 0) {
        const scriptsDir = path.join(skillDir, "scripts");
        fs.mkdirSync(scriptsDir, { recursive: true });
        for (const script of skill.scripts) {
          fs.writeFileSync(path.join(scriptsDir, script.name), script.content, { mode: 0o755 });
        }
      }
    }

    // Write disabled builtins list for agent-factory to exclude
    const disabledFile = path.join(skillsDir, ".disabled-builtins.json");
    if (payload.disabledBuiltins?.length) {
      fs.writeFileSync(disabledFile, JSON.stringify(payload.disabledBuiltins));
    } else if (fs.existsSync(disabledFile)) {
      fs.unlinkSync(disabledFile);
    }

    return payload.skills.length;
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

// ── Registry ──────────────────────────────────────────────────────────

const handlers = new Map<ResourceType, AgentBoxResourceHandler<any>>([
  ["mcp", mcpHandler],
  ["skills", skillsHandler],
]);

/**
 * Look up the handler for a given resource type.
 * Returns undefined if the type is unknown.
 */
export function getResourceHandler(type: ResourceType): AgentBoxResourceHandler<any> | undefined {
  return handlers.get(type);
}
