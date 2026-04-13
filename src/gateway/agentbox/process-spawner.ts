/**
 * Process AgentBox Spawner
 *
 * Spawner for single-VM deployments; runs an independent AgentBox process via child_process.fork().
 * Each user gets an independent child process and port.
 */

import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BoxSpawner } from "./spawner.js";
import type { AgentBoxConfig, AgentBoxInfo, AgentBoxHandle } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ProcessBox {
  userId: string;
  port: number;
  process: ChildProcess;
  createdAt: Date;
}

export class ProcessSpawner implements BoxSpawner {
  readonly name = "process";

  private boxes = new Map<string, ProcessBox>();
  private basePort: number;
  private nextPort: number;

  constructor(basePort = 4000) {
    this.basePort = basePort;
    this.nextPort = basePort;
  }

  async spawn(config: AgentBoxConfig): Promise<AgentBoxHandle> {
    const { userId } = config;
    const agentId = config.agentId || "default";
    const boxId = `proc-${userId}-${agentId}`;

    const existing = this.boxes.get(boxId);
    if (existing) {
      return {
        boxId,
        endpoint: `http://127.0.0.1:${existing.port}`,
        userId,
      };
    }

    const port = this.nextPort++;

    // Resolve entry script relative to __dirname (2 levels up to dist/ or src/ root).
    // In compiled mode: __dirname = dist/gateway/agentbox → dist/agentbox-main.js
    // In dev mode (tsx): __dirname = src/gateway/agentbox → src/agentbox-main.ts
    // fork() inherits process.execArgv (including tsx loader), so .ts files work in dev.
    const base = path.resolve(__dirname, "..", "..");
    const { existsSync } = await import("node:fs");
    const entryScript = existsSync(path.join(base, "agentbox-main.js"))
      ? path.join(base, "agentbox-main.js")
      : path.join(base, "agentbox-main.ts");

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SICLAW_AGENTBOX_PORT: String(port),
      USER_ID: userId,
    };

    // Forward agent-specific env vars
    if (config.env) {
      Object.assign(env, config.env);
    }

    // Set user data dir if not already set
    if (!env.SICLAW_USER_DATA_DIR) {
      const dataDir = process.env.SICLAW_DATA_DIR || process.cwd();
      env.SICLAW_USER_DATA_DIR = path.join(dataDir, "user-data", userId);
    }

    const child = fork(entryScript, [], {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    // Forward stdout/stderr with prefix
    const prefix = `[agentbox:${boxId}]`;
    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (line.trim()) console.log(`${prefix} ${line}`);
      }
    });
    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (line.trim()) console.error(`${prefix} ${line}`);
      }
    });

    child.on("exit", (code, signal) => {
      console.log(`${prefix} exited (code=${code}, signal=${signal})`);
      this.boxes.delete(boxId);
    });

    const box: ProcessBox = {
      userId,
      port,
      process: child,
      createdAt: new Date(),
    };
    this.boxes.set(boxId, box);

    // Wait for the agentbox to become ready
    await this.waitForReady(port, boxId);

    console.log(`[process-spawner] AgentBox for ${userId} started on port ${port} (pid=${child.pid})`);

    return {
      boxId,
      endpoint: `http://127.0.0.1:${port}`,
      userId,
    };
  }

  async stop(boxId: string): Promise<void> {
    const box = this.boxes.get(boxId);
    if (!box) return;

    console.log(`[process-spawner] Stopping AgentBox: ${boxId} (pid=${box.process.pid})`);

    const child = box.process;
    this.boxes.delete(boxId);

    // SIGTERM first, then SIGKILL after 5s
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        if (!child.killed) {
          console.warn(`[process-spawner] Force killing ${boxId}`);
          child.kill("SIGKILL");
        }
        resolve();
      }, 5000);

      child.on("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
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
    console.log(`[process-spawner] Cleaning up ${this.boxes.size} boxes...`);
    const stops = [...this.boxes.keys()].map((id) => this.stop(id));
    await Promise.all(stops);
  }

  private async waitForReady(port: number, boxId: string, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    const interval = 300;

    while (Date.now() - start < timeoutMs) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (resp.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`[process-spawner] AgentBox ${boxId} did not become ready within ${timeoutMs}ms`);
  }
}
