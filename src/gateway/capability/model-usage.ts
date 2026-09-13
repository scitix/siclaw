import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { UsageOutbox } from "../../agentbox/usage-outbox.js";
import { loadConfig } from "../../core/config.js";
import type { UsageBatchResponse, UsageObservation } from "../../shared/model-usage.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";

const collectors = new WeakMap<FrontendWsClient, Map<string, UsageOutbox>>();
function root(): string { return path.resolve(loadConfig().paths.userDataDir, "capability-usage-outbox"); }

function collector(frontend: FrontendWsClient, runId: string): UsageOutbox {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(runId)) throw new Error("Invalid usage run identity");
  let runs = collectors.get(frontend);
  if (!runs) { runs = new Map(); collectors.set(frontend, runs); }
  const active = runs.get(runId);
  if (active) return active;
  const outbox = new UsageOutbox(path.join(root(), runId), async batch =>
    await frontend.request("capability.recordModelUsage", { run_id: runId, batch }) as UsageBatchResponse);
  runs.set(runId, outbox);
  // Final delivery keeps retrying after the compiler finishes. Once the empty
  // health report is acknowledged, release the collector's timer and memory.
  outbox.retireWhenDrained(() => { if (runs!.get(runId) === outbox) runs!.delete(runId); });
  return outbox;
}

export function recordCapabilityUsage(frontend: FrontendWsClient, runId: string, observation: UsageObservation): void {
  collector(frontend, runId).record(observation);
}

/** Replay pending records even when their originating run already completed. */
export function recoverCapabilityUsage(frontend: FrontendWsClient): void {
  const directory = root();
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.name)) continue;
    if (readdirSync(path.join(directory, entry.name)).some(name => name.endsWith(".event.json"))) collector(frontend, entry.name);
  }
}
