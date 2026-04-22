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
import type { MemoryIndexer } from "../../memory/index.js";
import type { CertificateManager } from "../security/cert-manager.js";

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

  /** Injected knowledge base indexer (set via setKnowledgeIndexer) */
  private knowledgeIndexer: MemoryIndexer | null = null;

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

  /** Inject knowledge base indexer for local knowledge_search */
  setKnowledgeIndexer(indexer: MemoryIndexer): void {
    this.knowledgeIndexer = indexer;
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
    if (this.knowledgeIndexer) {
      sessionManager.knowledgeIndexer = this.knowledgeIndexer;
    }
    // Agent-scoped credentials directory — shared across callers of this agent.
    sessionManager.credentialsDir = path.resolve(
      process.cwd(),
      ".siclaw/credentials",
      agentId,
    );
    const httpServer = createHttpServer(sessionManager);

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
        agentId: box.agentId,
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
}
