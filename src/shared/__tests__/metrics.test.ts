import { describe, it, expect, beforeEach } from "vitest";
import { emitDiagnostic } from "../diagnostic-events.js";
import { metricsRegistry } from "../metrics.js";

describe("metrics subscriber", () => {
  beforeEach(async () => {
    metricsRegistry.resetMetrics();
  });

  it("should increment token counters with correct delta on prompt_complete", async () => {
    emitDiagnostic({
      type: "prompt_complete",
      prev: { tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 }, cost: 0.01 },
      curr: { tokens: { input: 250, output: 120, cacheRead: 30, cacheWrite: 10, total: 410 }, cost: 0.05 },
      model: { id: "claude-sonnet-4-20250514", name: "Sonnet", provider: "anthropic", contextWindow: 200000, maxTokens: 16384, reasoning: false },
      durationMs: 3500,
      outcome: "completed",
      userId: "user-1",
    });

    const output = await metricsRegistry.metrics();

    // Token deltas: input=150, output=70, cache_read=30, cache_write=10
    expect(output).toContain('type="input"} 150');
    expect(output).toContain('type="output"} 70');
    expect(output).toContain('type="cache_read"} 30');
    expect(output).toContain('type="cache_write"} 10');

    // Cost delta: 0.04
    expect(output).toContain('siclaw_cost_usd_total{provider="anthropic"');
    expect(output).toContain("} 0.04");

    // Prompt duration histogram (3500ms falls in the 5000 bucket)
    expect(output).toContain("siclaw_prompt_duration_ms_sum");
    expect(output).toContain("3500");

    // Prompt count
    expect(output).toContain('siclaw_prompts_total{provider="anthropic"');
  });

  it("should handle zero-delta gracefully", async () => {
    const stats = { tokens: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 }, cost: 0.01 };
    emitDiagnostic({
      type: "prompt_complete",
      prev: stats,
      curr: stats, // same as prev — zero delta
      model: { id: "test-model", name: "Test", provider: "test", contextWindow: 100000, maxTokens: 4096, reasoning: false },
      durationMs: 1000,
      outcome: "completed",
    });

    const output = await metricsRegistry.metrics();
    // Prompt count should still be 1
    expect(output).toContain('siclaw_prompts_total{provider="test"');
    // Duration should still be recorded
    expect(output).toContain("siclaw_prompt_duration_ms_count");
  });

  it("should track session lifecycle", async () => {
    emitDiagnostic({ type: "session_created", sessionId: "s1" });
    emitDiagnostic({ type: "session_created", sessionId: "s2" });

    let output = await metricsRegistry.metrics();
    expect(output).toContain("siclaw_sessions_active 2");

    emitDiagnostic({ type: "session_released", sessionId: "s1" });

    output = await metricsRegistry.metrics();
    expect(output).toContain("siclaw_sessions_active 1");

    emitDiagnostic({ type: "session_released", sessionId: "s2" });

    output = await metricsRegistry.metrics();
    expect(output).toContain("siclaw_sessions_active 0");
  });

  it("should track tool calls by name and outcome", async () => {
    emitDiagnostic({ type: "tool_call", toolName: "restricted_bash", outcome: "success", durationMs: 1200, userId: "u1", agentId: "a1" });
    emitDiagnostic({ type: "tool_call", toolName: "restricted_bash", outcome: "error", durationMs: 500, userId: "u1", agentId: "a1" });
    emitDiagnostic({ type: "tool_call", toolName: "memory_search", outcome: "success", durationMs: 300, userId: "u1", agentId: "a1" });

    const output = await metricsRegistry.metrics();
    expect(output).toContain('siclaw_tool_calls_total{tool_name="restricted_bash",outcome="success"} 1');
    expect(output).toContain('siclaw_tool_calls_total{tool_name="restricted_bash",outcome="error"} 1');
    expect(output).toContain('siclaw_tool_calls_total{tool_name="memory_search",outcome="success"} 1');
  });

  it("should track WebSocket connections", async () => {
    emitDiagnostic({ type: "ws_connected" });
    emitDiagnostic({ type: "ws_connected" });

    let output = await metricsRegistry.metrics();
    expect(output).toContain("siclaw_ws_connections 2");

    emitDiagnostic({ type: "ws_disconnected" });

    output = await metricsRegistry.metrics();
    expect(output).toContain("siclaw_ws_connections 1");
  });

  it("should track skill calls by name, scope, and outcome", async () => {
    emitDiagnostic({
      type: "skill_call",
      skillName: "k8s-diagnostics",
      scriptName: "check-pods",
      scope: "builtin",
      outcome: "success",
      durationMs: 1200,
      userId: "u1",
      agentId: "a1",
    });
    emitDiagnostic({
      type: "skill_call",
      skillName: "k8s-diagnostics",
      scriptName: "check-pods",
      scope: "builtin",
      outcome: "error",
      durationMs: 500,
      userId: "u1",
      agentId: "a1",
    });
    emitDiagnostic({
      type: "skill_call",
      skillName: "custom-tool",
      scriptName: "run",
      scope: "global",
      outcome: "success",
      durationMs: 300,
      userId: "u1",
      agentId: "a1",
    });

    const output = await metricsRegistry.metrics();
    // Full-label counter
    expect(output).toContain('siclaw_skill_calls_total{skill_name="k8s-diagnostics",scope="builtin",outcome="success"} 1');
    expect(output).toContain('siclaw_skill_calls_total{skill_name="k8s-diagnostics",scope="builtin",outcome="error"} 1');
    expect(output).toContain('siclaw_skill_calls_total{skill_name="custom-tool",scope="global",outcome="success"} 1');

    // Low-cardinality scope counter
    expect(output).toContain('siclaw_skill_calls_by_scope_total{scope="builtin",outcome="success"} 1');
    expect(output).toContain('siclaw_skill_calls_by_scope_total{scope="builtin",outcome="error"} 1');
    expect(output).toContain('siclaw_skill_calls_by_scope_total{scope="global",outcome="success"} 1');
  });

  it("should track context usage (Phase 2)", async () => {
    emitDiagnostic({
      type: "context_usage",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      tokensUsed: 50000,
      tokensLimit: 200000,
    });

    const output = await metricsRegistry.metrics();
    expect(output).toContain("siclaw_context_tokens_used");
    expect(output).toContain("siclaw_context_tokens_limit");
  });

  it("should track stuck sessions (Phase 2)", async () => {
    emitDiagnostic({ type: "session_stuck", sessionId: "s1", idleMs: 150000 });

    const output = await metricsRegistry.metrics();
    expect(output).toContain("siclaw_session_stuck_total 1");
    expect(output).toContain("siclaw_session_stuck_age_ms");
  });
});
