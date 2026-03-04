/**
 * Gateway Client — HTTP proxy for cron DB operations
 *
 * Replaces direct ConfigRepository access so the cron service
 * no longer needs its own database connection. All state flows
 * through Gateway's internal API.
 */

import type { CronJobRow } from "./cron-scheduler.js";

export class GatewayClient {
  private baseUrl: string;

  constructor(gatewayUrl: string) {
    this.baseUrl = gatewayUrl.replace(/\/$/, "");
  }

  // ─── Cron Instances ──────────────────────────────

  async registerCronInstance(instanceId: string, endpoint: string): Promise<void> {
    await this.post("/api/internal/cron/register", { instanceId, endpoint });
  }

  async updateHeartbeat(instanceId: string, jobCount: number): Promise<void> {
    await this.post("/api/internal/cron/heartbeat", { instanceId, jobCount });
  }

  async deleteInstance(instanceId: string): Promise<void> {
    await this.post("/api/internal/cron/delete-instance", { instanceId });
  }

  async releaseInstanceJobs(instanceId: string): Promise<void> {
    await this.post("/api/internal/cron/release-jobs", { instanceId });
  }

  async getDeadInstances(thresholdMs: number): Promise<Array<{ instanceId: string; heartbeatAt: Date }>> {
    const data = await this.get(`/api/internal/cron/dead-instances?thresholdMs=${thresholdMs}`) as {
      instances: Array<{ instanceId: string; heartbeatAt: string }>;
    };
    return data.instances.map((i) => ({
      instanceId: i.instanceId,
      heartbeatAt: new Date(i.heartbeatAt),
    }));
  }

  async getLeastLoadedInstance(thresholdMs: number): Promise<{ instanceId: string; jobCount: number } | null> {
    const data = await this.get(`/api/internal/cron/least-loaded?thresholdMs=${thresholdMs}`) as {
      instance: { instanceId: string; jobCount: number } | null;
    };
    return data.instance;
  }

  // ─── Cron Jobs ──────────────────────────────────

  async listCronJobsByInstance(instanceId: string): Promise<CronJobRow[]> {
    const data = await this.get(`/api/internal/cron/jobs?instanceId=${encodeURIComponent(instanceId)}`) as {
      jobs: CronJobRow[];
    };
    return data.jobs.map(parseJobDates);
  }

  async getCronJobById(id: string): Promise<CronJobRow | null> {
    const data = await this.get(`/api/internal/cron/jobs/${encodeURIComponent(id)}`) as {
      job: CronJobRow | null;
    };
    return data.job ? parseJobDates(data.job) : null;
  }

  async getUnassignedActiveJobs(): Promise<CronJobRow[]> {
    const data = await this.get("/api/internal/cron/jobs?unassigned=1") as {
      jobs: CronJobRow[];
    };
    return data.jobs.map(parseJobDates);
  }

  async claimUnassignedJob(jobId: string, instanceId: string): Promise<boolean> {
    const data = await this.post("/api/internal/cron/claim-job", { jobId, instanceId }) as {
      claimed: boolean;
    };
    return data.claimed;
  }

  async updateCronJobRun(jobId: string, result: "success" | "failure"): Promise<void> {
    await this.post("/api/internal/cron/job-run", { jobId, result });
  }

  async reassignOrphanedJobs(fromInstanceId: string, toInstanceId: string): Promise<void> {
    await this.post("/api/internal/cron/reassign-jobs", { fromInstanceId, toInstanceId });
  }

  // ─── HTTP helpers ────────────────────────────────

  private async get(path: string): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`Gateway GET ${path} returned ${resp.status}: ${await resp.text()}`);
    }
    return resp.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      throw new Error(`Gateway POST ${path} returned ${resp.status}: ${await resp.text()}`);
    }
    return resp.json();
  }
}

/** Convert JSON date strings back to Date objects */
function parseJobDates(job: any): CronJobRow {
  return {
    ...job,
    lastRunAt: job.lastRunAt ? new Date(job.lastRunAt) : null,
    lockedAt: job.lockedAt ? new Date(job.lockedAt) : null,
  };
}
