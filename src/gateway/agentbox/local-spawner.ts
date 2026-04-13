/**
 * Local AgentBox Spawner
 *
 * Spawner for local development; runs the AgentBox HTTP server within the same process.
 * Each user gets an independent port.
 */

import http from "node:http";
import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxHandle, AgentBoxInfo } from "./types.js";
import { createHttpServer } from "../../agentbox/http-server.js";
import { AgentBoxSessionManager } from "../../agentbox/session.js";
import type { MemoryIndexer } from "../../memory/index.js";

interface LocalBox {
  userId: string;
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

  constructor(basePort = 4000) {
    this.basePort = basePort;
    this.nextPort = basePort;
  }

  /** Inject knowledge base indexer for local knowledge_search */
  setKnowledgeIndexer(indexer: MemoryIndexer): void {
    this.knowledgeIndexer = indexer;
  }

  async spawn(config: AgentBoxConfig): Promise<AgentBoxHandle> {
    const { userId } = config;
    const agentId = config.agentId || "default";
    const boxId = `local-${userId}-${agentId}`;

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

}
