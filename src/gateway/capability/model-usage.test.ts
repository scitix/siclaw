import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ExecutionObservationRelay } from "./execution-observation.js";
import type { UsageBatch, UsageObservation } from "../../shared/model-usage.js";

const configuration = vi.hoisted(() => ({ paths: { userDataDir: "" } }));
vi.mock("../../core/config.js", () => ({ loadConfig: () => configuration }));
beforeEach(() => { configuration.paths.userDataDir = mkdtempSync(path.join(tmpdir(), "compiler-usage-")); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); rmSync(configuration.paths.userDataDir, { recursive: true, force: true }); });

it("persists compiler usage independently of the diagnostic queue and retries after run completion", async () => {
  let attempts = 0;
  const request = vi.fn(async (_method: string, params: { run_id: string; batch: UsageBatch }) => {
    if (++attempts === 1) throw new Error("temporary control-plane outage");
    return { results: params.batch.observations.map(o => ({ callId: o.callId, phase: o.phase, status: "accepted" })) };
  });
  const relay = new ExecutionObservationRelay({ request } as any, "run-123");
  const observation: UsageObservation = { schemaVersion: 1, callId: randomUUID(), phase: "finished", sessionId: "compiler-session",
    requestId: "turn-1", executorRole: "judge", executionRole: "root", requestAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    kind: "agent", routingAttempt: 1, outcome: "success", model: { configId: "", name: "Example", sourceId: "", sourceName: "",
      sourceKind: "unknown", requestedId: "example", runtimeProvider: "gateway" },
    usageEvidence: { protocol: "openai_responses", finality: "terminal", providerUsagePresent: true, rawUsage: { input_tokens: 12, output_tokens: 3 } } };
  relay.enqueue({ version: 1, id: randomUUID(), kind: "model_usage", session_id: observation.sessionId, turn_id: "turn-1",
    observed_at: new Date().toISOString(), role: "judge", model_id: "example", provider: "gateway", data: { observation } });
  await relay.close();
  const directory = path.join(configuration.paths.userDataDir, "capability-usage-outbox", "run-123");
  expect(readdirSync(directory).some(name => name.endsWith(".event.json"))).toBe(true);
  await vi.advanceTimersByTimeAsync(1600);
  expect(request.mock.calls.every(([method]) => method === "capability.recordModelUsage")).toBe(true);
  expect(request.mock.calls[1][1].batch.observations[0]).toEqual(observation);
  expect(readdirSync(directory).some(name => name.endsWith(".event.json"))).toBe(false);
  await vi.runAllTimersAsync();
  expect(request.mock.calls.at(-1)?.[1].batch.health?.pending).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
