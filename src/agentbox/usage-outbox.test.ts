import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { UsageOutbox } from "./usage-outbox.js";
import type { UsageBatch, UsageObservation } from "../shared/model-usage.js";
const directories: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "usage-test-"));directories.push(d);return d; };
afterEach(() => { vi.useRealTimers(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
const event = (): UsageObservation => ({ schemaVersion: 1, callId: randomUUID(), phase: "started", sessionId: "session-1", requestAt: new Date().toISOString(), kind: "agent", executionRole: "root", routingAttempt: 1, model: { configId: "model-1", name: "Example", sourceKind: "api", sourceId: "model-1", sourceName: "Example", requestedId: "gpt-example", runtimeProvider: "example" } });
it("replays durable events after restart and removes only acknowledged records", async () => {
  const directory=dir();const a=event(),b=event();
  const failed=new UsageOutbox(directory,async()=>{throw new Error("offline");});
  failed.record(a);failed.record(b);await failed.close();
  const batches: UsageBatch[]=[];
  const replay=new UsageOutbox(directory,async batch=>{batches.push(batch);return {results:[{callId:a.callId,phase:a.phase,status:"accepted"}]};});
  await replay.close();
  expect(batches[0].observations).toHaveLength(2);
  expect(readdirSync(directory).filter(n=>n.endsWith(".event.json"))).toHaveLength(1);
});
it("reports capacity loss after recovery instead of claiming complete collection", async () => {
  const batches:UsageBatch[]=[];
  const outbox=new UsageOutbox(dir(),async batch=>{batches.push(batch);return{results:[]};},1);
  outbox.record(event());await outbox.close();
  expect(batches[0].health?.dropped).toBe(1);
  expect(batches[0].observations).toEqual([]);
});
it("flushes new observations promptly while an idle heartbeat is scheduled", async () => {
  vi.useFakeTimers();
  const batches: UsageBatch[] = [];
  const outbox = new UsageOutbox(dir(), async batch => {
    batches.push(batch);
    return { results: batch.observations.map(o => ({ callId: o.callId, phase: o.phase, status: "accepted" as const })) };
  });
  await vi.advanceTimersByTimeAsync(250);
  outbox.record(event());
  await vi.advanceTimersByTimeAsync(250);
  expect(batches).toHaveLength(1);
  expect(batches[0].observations).toHaveLength(1);
  await outbox.close();
});
