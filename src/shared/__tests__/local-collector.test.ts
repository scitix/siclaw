import { describe, it, expect, beforeEach } from "vitest";
import { emitDiagnostic } from "../diagnostic-events.js";
import type { BrainSessionStats, BrainModelInfo } from "../../core/brain-session.js";

// Import for side-effect — registers the collector on the event bus
import "../local-collector.js";
import { localCollector } from "../local-collector.js";

const emptyStats: BrainSessionStats = {
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  cost: 0,
};

function makeStats(input: number, output: number, cost: number): BrainSessionStats {
  return {
    tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
    cost,
  };
}

const testModel: BrainModelInfo = {
  id: "claude-sonnet-4-20250514",
  name: "claude-sonnet-4-20250514",
  provider: "anthropic",
  contextWindow: 200000,
  maxTokens: 8192,
  reasoning: false,
};

describe("LocalCollector", () => {
  it("should accumulate prompt_complete events into buckets", () => {
    emitDiagnostic({
      type: "prompt_complete",
      sessionId: "s1",
      prev: emptyStats,
      curr: makeStats(100, 50, 0.01),
      model: testModel,
      durationMs: 5000,
      outcome: "completed",
      userId: "user1",
    });

    const buckets = localCollector.query("1h");
    expect(buckets.length).toBeGreaterThanOrEqual(1);
    const last = buckets[buckets.length - 1];
    expect(last.tokensInput).toBeGreaterThanOrEqual(100);
    expect(last.tokensOutput).toBeGreaterThanOrEqual(50);
    expect(last.promptCount).toBeGreaterThanOrEqual(1);
  });

  it("should track session lifecycle", () => {
    emitDiagnostic({ type: "session_created", sessionId: "s-test-1" });
    expect(localCollector.snapshot().activeSessions).toBeGreaterThanOrEqual(1);

    emitDiagnostic({
      type: "session_released",
      sessionId: "s-test-1",
      stats: makeStats(200, 100, 0.05),
      userId: "user1",
      model: testModel,
      createdAt: Date.now() - 60000,
    });

    // Session stats should be queued
    const records = localCollector.drainSessionStats();
    const record = records.find((r) => r.sessionId === "s-test-1");
    expect(record).toBeDefined();
    expect(record!.inputTokens).toBe(200);
    expect(record!.outputTokens).toBe(100);
  });

  it("should track tool calls", () => {
    emitDiagnostic({
      type: "tool_call",
      toolName: "restricted_bash",
      outcome: "success",
      durationMs: 100,
    });
    emitDiagnostic({
      type: "tool_call",
      toolName: "restricted_bash",
      outcome: "error",
      durationMs: 200,
    });

    const tools = localCollector.topTools(10);
    const bash = tools.find((t) => t.toolName === "restricted_bash");
    expect(bash).toBeDefined();
    expect(bash!.success).toBeGreaterThanOrEqual(1);
    expect(bash!.error).toBeGreaterThanOrEqual(1);
  });

  it("should track ws connections", () => {
    const before = localCollector.snapshot().wsConnections;
    emitDiagnostic({ type: "ws_connected" });
    expect(localCollector.snapshot().wsConnections).toBe(before + 1);
    emitDiagnostic({ type: "ws_disconnected" });
    expect(localCollector.snapshot().wsConnections).toBe(before);
  });

  it("should export snapshot with only completed minute buckets", () => {
    // Emit an event to ensure current minute has data
    emitDiagnostic({
      type: "prompt_complete",
      sessionId: "s2",
      prev: emptyStats,
      curr: makeStats(10, 5, 0.001),
      model: testModel,
      durationMs: 1000,
      outcome: "completed",
    });

    const snapshot = localCollector.exportSnapshot();
    // Current minute bucket should NOT be in exported snapshot
    const currentMin = Math.floor(Date.now() / 60000) * 60000;
    for (const bucket of snapshot.buckets) {
      expect(bucket.timestamp).toBeLessThan(currentMin);
    }
  });
});
