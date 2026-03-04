/**
 * Cron Executor — Runs cron jobs via Gateway's internal API
 *
 * Instead of managing AgentBox pods directly, delegates to Gateway
 * which is the single owner of all AgentBox lifecycles.
 */

import type { GatewayClient } from "./gateway-client.js";
import type { CronJobRow } from "./cron-scheduler.js";

const EXECUTION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class CronExecutor {
  private gatewayUrl: string;
  private client: GatewayClient;

  constructor(gatewayUrl: string, client: GatewayClient) {
    this.gatewayUrl = gatewayUrl.replace(/\/$/, "");
    this.client = client;
  }

  async execute(job: CronJobRow): Promise<void> {
    // Re-validate job from DB before executing (handles cross-instance delete/pause)
    const current = await this.client.getCronJobById(job.id);
    if (!current || current.status !== "active") {
      console.log(`[cron-executor] Job ${job.id} no longer active, skipping`);
      return;
    }

    // Use fresh DB record for execution (envId may have been updated since scheduler loaded)
    const envId = current.envId ?? undefined;
    console.log(`[cron-executor] Executing job ${job.id} (${job.name}) for user ${job.userId}${envId ? ` env=${envId}` : ""}`);

    try {
      const sessionId = `cron-${job.id}`;
      const prompt = buildCronPrompt(current);

      const resp = await fetch(`${this.gatewayUrl}/api/internal/agent-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: current.userId,
          sessionId,
          text: prompt,
          timeoutMs: EXECUTION_TIMEOUT_MS,
          caller: "cron",
          envId,
        }),
        signal: AbortSignal.timeout(EXECUTION_TIMEOUT_MS + 10_000), // HTTP timeout slightly longer
      });

      const data = await resp.json() as {
        status: string; resultText?: string; error?: string; durationMs?: number;
      };

      if (!resp.ok || data.status !== "success") {
        throw new Error(data.error || `Gateway returned status=${data.status} http=${resp.status}`);
      }

      const resultText = data.resultText || "";

      // Record success
      await this.client.updateCronJobRun(job.id, "success");
      console.log(`[cron-executor] Job ${job.id} completed in ${data.durationMs}ms, resultText length=${resultText.length}`);
      if (resultText) {
        console.log(`[cron-executor] Result preview: ${resultText.slice(0, 200)}`);
      }

      // Notify gateway (fire-and-forget)
      this.notifyGateway(job, "success", resultText);
    } catch (err) {
      console.error(`[cron-executor] Job ${job.id} failed:`, err);
      await this.client.updateCronJobRun(job.id, "failure");
      this.notifyGateway(job, "failure", "", err instanceof Error ? err.message : String(err));
    }
  }

  private notifyGateway(
    job: CronJobRow,
    result: "success" | "failure",
    resultText: string,
    error?: string,
  ): void {
    fetch(`${this.gatewayUrl}/api/internal/cron-notify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: job.userId,
        jobId: job.id,
        jobName: job.name,
        result,
        resultText,
        error,
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch((err) =>
      console.warn("[cron-executor] notify failed:", err instanceof Error ? err.message : err),
    );
  }
}

function buildCronPrompt(job: CronJobRow): string {
  const parts = [
    `[System: You are executing a scheduled task. Perform the action described below directly. Do NOT create, modify, delete, pause, or manage any schedules. Just do what the task description says and report the result.]`,
    `Task: ${job.name}`,
  ];
  if (job.description) {
    parts.push(`Instructions: ${job.description}`);
  }
  if (job.skillId) {
    parts.push(`Execute skill: ${job.skillId}`);
  }
  return parts.join("\n\n");
}
