/**
 * Local AgentBox Spawner
 *
 * Spawner for local development; runs the AgentBox HTTP server within the
 * same process. One instance per agent, shared by all callers of that agent.
 * Uses the same mTLS cert architecture as K8s mode — gateway signs a client
 * cert for each AgentBox instance (CN = agentId).
 */

import http from "node:http";
import path from "node:path";
import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo } from "./types.js";
import { createHttpServer } from "../../agentbox/http-server.js";
import { AgentBoxSessionManager } from "../../agentbox/session.js";
import { GatewayClient } from "../../agentbox/gateway-client.js";
import { syncResource } from "../../agentbox/resource-sync.js";
import {
  createKnowledgeHandler,
  createMcpHandler,
  createSkillsHandler,
} from "../../agentbox/sync-handlers.js";
import type { CertificateManager } from "../security/cert-manager.js";
import { getDb } from "../db.js";
import { parseToolCapabilitiesAtBoundary, resolveCapabilities } from "../../core/tool-capabilities.js";
import { requireAgentType, effectiveCapabilityKeys } from "../../core/agent-types.js";
import { loadConfig } from "../../core/config.js";
import { resolveUnderDir } from "../../shared/path-utils.js";

interface LocalBox {
  agentId: string;
  port: number;
  httpServer: http.Server;
  sessionManager: AgentBoxSessionManager;
  createdAt: Date;
}

export class LocalSpawner implements BoxSpawner {
  readonly name = "local";

  private boxes = new Map<string, LocalBox>();
  private basePort: number;
  private nextPort: number;

  /** Certificate manager for signing agentbox client certs */
  private readonly certManager: CertificateManager;
  /** Gateway internal mTLS URL (e.g. https://127.0.0.1:3002) */
  private readonly gatewayInternalUrl: string;

  constructor(certManager: CertificateManager, gatewayInternalUrl: string, basePort = 4000) {
    this.certManager = certManager;
    this.gatewayInternalUrl = gatewayInternalUrl;
    this.basePort = basePort;
    this.nextPort = basePort;
  }

  async spawn(config: AgentBoxConfig): Promise<AgentBoxHandle> {
    const agentId = config.agentId;
    if (!agentId) {
      throw new Error(`LocalSpawner.spawn requires a non-empty agentId`);
    }
    const boxId = `local-${agentId}`;

    const existing = this.boxes.get(boxId);
    if (existing) {
      return {
        boxId,
        endpoint: `https://127.0.0.1:${existing.port}`,
        agentId,
      };
    }

    const port = this.nextPort++;

    const certBundle = this.certManager.issueAgentBoxCertificate(agentId, "default", boxId);

    // Use the K8s-convention filenames (tls.crt / tls.key / ca.crt) so that
    // GatewayClient and the agentbox http-server can pick them up via the
    // single SICLAW_CERT_PATH env var — the same code path as K8s mode.
    const certDir = path.resolve(process.cwd(), ".siclaw/certs", boxId);
    const fs = await import("node:fs");
    fs.mkdirSync(certDir, { recursive: true });
    fs.writeFileSync(path.join(certDir, "tls.crt"), certBundle.cert);
    fs.writeFileSync(path.join(certDir, "tls.key"), certBundle.key);
    fs.writeFileSync(path.join(certDir, "ca.crt"), certBundle.ca);

    process.env.SICLAW_GATEWAY_URL = this.gatewayInternalUrl;
    process.env.SICLAW_CERT_PATH = certDir;

    const sessionManager = new AgentBoxSessionManager();
    sessionManager.agentId = agentId;
    sessionManager.gatewayClient = new GatewayClient({
      gatewayUrl: this.gatewayInternalUrl,
      certPath: certDir,
    });
    sessionManager.harnessResolvedState = false;
    sessionManager.allowedToolsState = [];
    // Agent-scoped credentials directory — shared across callers of this agent.
    sessionManager.credentialsDir = path.resolve(
      process.cwd(),
      ".siclaw/credentials",
      agentId,
    );
    const knowledgeRoot = path.resolve(process.cwd(), loadConfig().paths.knowledgeDir);
    sessionManager.knowledgeDir = resolveUnderDir(knowledgeRoot, agentId);
    const skillsRoot = path.resolve(
      process.cwd(),
      loadConfig().paths.skillsDir ?? ".siclaw/skills",
      "agents",
    );
    sessionManager.skillsDir = resolveUnderDir(skillsRoot, agentId);
    // Empty is authoritative until the per-Agent Gateway response lands. This
    // prevents Local mode from falling back to process-global settings.json.
    sessionManager.mcpServersState = {};
    const boxClient = sessionManager.gatewayClient.toClientLike();
    const knowledgeHandler = createKnowledgeHandler({
      knowledgeDir: sessionManager.knowledgeDir,
      afterMaterialize: () => sessionManager.syncKnowledgeIndex?.(),
      boxClient,
    });
    const skillsHandler = createSkillsHandler({
      skillsDir: sessionManager.skillsDir,
      preserveExistingOnEmpty: false,
      boxClient,
    });
    const mcpHandler = createMcpHandler(sessionManager, boxClient);

    // Inject the resolved tool whitelist AND the locked agent-type policy at spawn
    // time. The tools sync type is initialSync:false, so the framework's
    // syncAllResources never pulls it (and isn't even run in Local mode).
    // LocalSpawner lives inside the Gateway process with direct DB access, so it
    // resolves both here — before createHttpServer + the first session — so a
    // restricted agent is restricted from its very first turn. This mirrors
    // the K8s path
    // (internal-api.ts handleToolCapabilities): a built-in type
    // LOCKS its capability set via effectiveCapabilityKeys and drives the locked
    // persona via agentTypeState — without this, a Coordinator with an empty raw
    // tool_capabilities would resolve to null (unrestricted) and keep the default
    // custom persona in Local mode. Custom with null/empty selection keeps that
    // legacy compatibility only after this lookup resolves successfully.
    try {
      const db = getDb();
      const [rows] = await db.query(
        "SELECT tool_capabilities, agent_type FROM agents WHERE id = ?",
        [agentId],
      ) as [Array<{ tool_capabilities?: unknown; agent_type?: unknown }>, unknown];
      if (rows.length !== 1) {
        throw new Error(`Expected exactly one agent row, got ${rows.length}`);
      }
      const groupKeys = parseToolCapabilitiesAtBoundary(rows[0].tool_capabilities);
      const agentType = requireAgentType(rows[0].agent_type);
      sessionManager.allowedToolsState = resolveCapabilities(effectiveCapabilityKeys(agentType, groupKeys));
      sessionManager.agentTypeState = agentType;
      sessionManager.harnessResolvedState = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Fail closed: without a proven type policy, do not expose built-in or
      // MCP tools. The next successful reload can correct it.
      console.warn(`[local-spawner] tool-capabilities resolve failed for agent=${agentId} (starting with no tools): ${msg}`);
      sessionManager.allowedToolsState = [];
      sessionManager.harnessResolvedState = false;
    }

    // Resolve all bound knowledge/skills/MCP before accepting the first prompt.
    // These independent pulls run concurrently; each keeps syncResource's own
    // bounded retry policy. A failed axis stays empty/fail-safe and can recover
    // through its normal reload endpoint later.
    const initialSyncs = await Promise.allSettled([
      syncResource("knowledge", boxClient, knowledgeHandler),
      syncResource("skills", boxClient, skillsHandler),
      syncResource("mcp", boxClient, mcpHandler),
    ]);
    for (const [index, result] of initialSyncs.entries()) {
      if (result.status === "rejected") {
        const type = ["knowledge", "skills", "mcp"][index];
        const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.warn(`[local-spawner] Initial ${type} sync failed for agent=${agentId}: ${msg}`);
      }
    }

    // disableIdleShutdown: LocalSpawner runs AgentBox in the same process as
    // the Portal — the 5-min idle timer's `process.exit(0)` would take the
    // whole `siclaw local` down and strand the web UI.
    const httpServer = createHttpServer(sessionManager, {
      disableIdleShutdown: true,
      knowledgeHandler,
      skillsHandler,
      mcpHandler,
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.listen(port, "127.0.0.1", () => {
        console.log(`[local-spawner] AgentBox for agent=${agentId} started on port ${port}`);
        resolve();
      });
      httpServer.on("error", reject);
    });

    const box: LocalBox = {
      agentId,
      port,
      httpServer,
      sessionManager,
      createdAt: new Date(),
    };

    this.boxes.set(boxId, box);

    return {
      boxId,
      // The AgentBox http-server detects TLS certs via SICLAW_CERT_PATH and
      // upgrades to HTTPS. LocalSpawner always provides certs, so endpoint
      // must be https for the Runtime's AgentBoxClient to handshake correctly.
      endpoint: `https://127.0.0.1:${port}`,
      agentId,
    };
  }

  async stop(boxId: string): Promise<void> {
    const box = this.boxes.get(boxId);
    if (!box) return;

    console.log(`[local-spawner] Stopping AgentBox: ${boxId}`);

    await box.sessionManager.closeAll();
    box.sessionManager.credentialBroker?.dispose();
    box.httpServer.close();
    this.boxes.delete(boxId);
  }

  async get(boxId: string): Promise<AgentBoxInfo | null> {
    const box = this.boxes.get(boxId);
    if (!box) return null;

    return {
      boxId,
      agentId: box.agentId,
      status: "running",
      endpoint: `https://127.0.0.1:${box.port}`,
      createdAt: box.createdAt,
      lastActiveAt: box.createdAt,
    };
  }

  async list(): Promise<AgentBoxInfo[]> {
    const result: AgentBoxInfo[] = [];
    for (const [boxId, box] of this.boxes) {
      result.push({
        boxId,
        agentId: box.agentId,
        status: "running",
        endpoint: `https://127.0.0.1:${box.port}`,
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
}
