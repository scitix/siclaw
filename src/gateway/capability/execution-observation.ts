import { recordCapabilityUsage } from "./model-usage.js";
import type { UsageObservation } from "../../shared/model-usage.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";
import { CAPABILITY_PERSIST_EXECUTION_OBSERVATION } from "./contract.js";

/** Model/tool metadata only. Prompt text, tool arguments and credentials never
 * belong in this channel. Test conversation contents remain ephemeral. */
export interface ExecutionObservation {
  version: 1;
  id: string;
  session_id: string;
  turn_id: string;
  kind: string;
  observed_at: string;
  role: string;
  model_id: string;
  provider: string;
  data: Record<string, unknown>;
}

export async function persistExecutionObservation(
  frontend: FrontendWsClient, runId: string, observation: ExecutionObservation | undefined,
): Promise<boolean> {
  if (!observation || observation.version !== 1) throw new Error("Invalid execution observation");
  // Reuse the event identity on retry, including a lost commit response. A
  // diagnostic outage must not replay a model request or alter domain state.
  for (const delay of [0, 250, 1000]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      await frontend.request(CAPABILITY_PERSIST_EXECUTION_OBSERVATION, { run_id: runId, observation }, 2000);
      return true;
    } catch {
      // This channel is diagnostic evidence; artifact ACKs remain the authority
      // for compilation completion and recovery. Report the gap to the caller.
    }
  }
  console.error(`[capability] run=${runId} execution observation could not be persisted id=${observation.id}`);
  return false;
}

/** Independent of the SSE consumer: diagnostics must never delay artifact ACKs
 * or user replies. One in-flight request, at most 128 records / 8 MiB retained. */
export class ExecutionObservationRelay {
  private queue: ExecutionObservation[] = [];
  private pending: Promise<void> | undefined;
  private closing = false;
  private stopped = false;
  private gapReported = false;

  constructor(
    private frontend: FrontendWsClient,
    private runId: string,
    private onGap: () => void = () => {},
  ) {}

  private reportGap(): void {
    if (this.gapReported) return;
    this.gapReported = true;
    console.error(`[capability] run=${this.runId} execution diagnostics incomplete`);
    this.onGap();
  }

  enqueue(observation: ExecutionObservation | undefined): void {
    if (!this.closing && observation?.version === 1 && observation.kind === "model_usage") {
      const usage = observation.data?.observation as UsageObservation | undefined;
      if (!usage || usage.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(usage.callId) ||
          !["started", "finished"].includes(usage.phase) || typeof usage.sessionId !== "string") {
        this.reportGap(); return;
      }
      try { recordCapabilityUsage(this.frontend, this.runId, usage); }
      catch { this.reportGap(); }
      return;
    }
    if (this.closing || !observation || observation.version !== 1 ||
        this.queue.length + (this.pending ? 1 : 0) >= 128 ||
        Buffer.byteLength(JSON.stringify(observation)) > 64 * 1024) {
      this.reportGap();
      return;
    }
    this.queue.push(observation);
    this.startDrain();
  }

  private startDrain(): void {
    if (this.pending || this.stopped || !this.queue.length) return;
    this.pending = this.drain().finally(() => {
      this.pending = undefined;
      this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped && this.queue.length) {
      const observation = this.queue.shift()!;
      if (!await persistExecutionObservation(this.frontend, this.runId, observation)) this.reportGap();
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (!this.pending) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.pending,
        new Promise<void>(resolve => {
          timer = setTimeout(() => {
            this.stopped = true;
            this.queue = [];
            this.reportGap();
            resolve();
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
