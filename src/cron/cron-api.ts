/**
 * Cron Inner HTTP API
 *
 * Receives real-time notifications from Gateway when jobs are created/updated/deleted.
 * Also exposes a health endpoint.
 */

import http from "node:http";
import type { CronScheduler, CronJobRow } from "./cron-scheduler.js";

interface SyncPayload {
  action: "upsert" | "delete" | "pause";
  job?: CronJobRow;
  jobId?: string;
}

export function createCronApi(
  scheduler: CronScheduler,
  instanceId: string,
): http.Server {
  const startTime = Date.now();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // CORS / preflight
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health check
    if (url.pathname === "/cron/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          instanceId,
          jobCount: scheduler.jobCount,
          uptimeMs: Date.now() - startTime,
        }),
      );
      return;
    }

    // Sync endpoint — gateway notifies us of CRUD changes
    if (url.pathname === "/cron/sync" && req.method === "POST") {
      try {
        const body = await readBody(req);
        const payload = JSON.parse(body) as SyncPayload;

        const validActions = ["upsert", "delete", "pause"];
        if (!validActions.includes(payload.action)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Invalid action: ${payload.action}` }));
          return;
        }

        switch (payload.action) {
          case "upsert":
            if (payload.job) {
              // Always cancel old timer first (handles reassignment + schedule changes)
              scheduler.cancel(payload.job.id);
              // Only reschedule if assigned to this instance
              if (payload.job.assignedTo === instanceId) {
                scheduler.addOrUpdate(payload.job);
              }
            }
            break;
          case "delete":
          case "pause":
            if (payload.jobId) {
              scheduler.cancel(payload.jobId);
            }
            break;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      } catch (err) {
        console.error("[cron-api] Sync error:", err);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid request" }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return server;
}

const MAX_BODY_SIZE = 100 * 1024; // 100KB

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
