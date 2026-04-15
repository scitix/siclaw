import { describe, it, expect } from "vitest";
import { emitDiagnostic } from "../diagnostic-events.js";

// Import for side-effect — registers the collector on the event bus
import "../local-collector.js";
import { localCollector } from "../local-collector.js";

describe("LocalCollector", () => {
  it("should track session lifecycle via counter", () => {
    const before = localCollector.snapshot().activeSessions;
    emitDiagnostic({ type: "session_created", sessionId: "s-lc-1" });
    expect(localCollector.snapshot().activeSessions).toBe(before + 1);
    emitDiagnostic({ type: "session_released", sessionId: "s-lc-1" });
    expect(localCollector.snapshot().activeSessions).toBe(before);
  });

  it("should track tool calls", () => {
    emitDiagnostic({ type: "tool_call", toolName: "restricted_bash", outcome: "success", durationMs: 100, userId: "u1", agentId: "a1" });
    emitDiagnostic({ type: "tool_call", toolName: "restricted_bash", outcome: "error", durationMs: 200, userId: "u1", agentId: "a1" });

    const tools = localCollector.topTools(10);
    const bash = tools.find((t) => t.toolName === "restricted_bash" && t.userId === "u1");
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

  it("should track skill calls with scope and avg duration", () => {
    emitDiagnostic({ type: "skill_call", skillName: "k8s-diagnostics", scriptName: "check-pods", scope: "builtin", outcome: "success", durationMs: 1500, sessionId: "s-skill-1", userId: "u1", agentId: "a1" });
    emitDiagnostic({ type: "skill_call", skillName: "k8s-diagnostics", scriptName: "check-pods", scope: "builtin", outcome: "error", durationMs: 500, sessionId: "s-skill-1", userId: "u1", agentId: "a1" });
    emitDiagnostic({ type: "skill_call", skillName: "my-custom-skill", scriptName: "run", scope: "global", outcome: "success", durationMs: 300, userId: "u1", agentId: "a1" });

    const skills = localCollector.topSkills(10);
    const k8s = skills.find((s) => s.skillName === "k8s-diagnostics" && s.userId === "u1");
    expect(k8s).toBeDefined();
    expect(k8s!.success).toBeGreaterThanOrEqual(1);
    expect(k8s!.error).toBeGreaterThanOrEqual(1);
    expect(k8s!.scope).toBe("builtin");
    expect(k8s!.avgDurationMs).toBeGreaterThan(0);

    const custom = skills.find((s) => s.skillName === "my-custom-skill" && s.userId === "u1");
    expect(custom).toBeDefined();
    expect(custom!.scope).toBe("global");
    expect(custom!.total).toBeGreaterThanOrEqual(1);
  });

  it("should export snapshot with tool/skill deltas and clear maps after", () => {
    emitDiagnostic({ type: "skill_call", skillName: "export-once-skill", scriptName: "run", scope: "global", outcome: "success", durationMs: 250, userId: "u-export", agentId: "a-x" });
    emitDiagnostic({ type: "tool_call", toolName: "export-once-tool", outcome: "success", durationMs: 10, userId: "u-export", agentId: "a-x" });

    const snap1 = localCollector.exportSnapshot();
    expect(snap1.skillCallDeltas.find((s) => s.skillName === "export-once-skill")).toBeDefined();
    expect(snap1.toolCallDeltas.find((t) => t.toolName === "export-once-tool")).toBeDefined();

    // Second export must not see the same deltas (maps cleared)
    const snap2 = localCollector.exportSnapshot();
    expect(snap2.skillCallDeltas.find((s) => s.skillName === "export-once-skill")).toBeUndefined();
    expect(snap2.toolCallDeltas.find((t) => t.toolName === "export-once-tool")).toBeUndefined();
  });

  it("should filter top-N tools/skills by userId", () => {
    emitDiagnostic({ type: "tool_call", toolName: "tool-isolation", outcome: "success", durationMs: 10, userId: "alice", agentId: "a-prod" });
    emitDiagnostic({ type: "tool_call", toolName: "tool-isolation", outcome: "success", durationMs: 10, userId: "alice", agentId: "a-prod" });
    emitDiagnostic({ type: "tool_call", toolName: "tool-isolation", outcome: "success", durationMs: 10, userId: "bob", agentId: "a-dev" });

    const aliceTools = localCollector.topTools(10, "alice");
    const bobTools = localCollector.topTools(10, "bob");
    const aliceEntry = aliceTools.find((t) => t.toolName === "tool-isolation" && t.userId === "alice");
    const bobEntry = bobTools.find((t) => t.toolName === "tool-isolation" && t.userId === "bob");

    expect(aliceEntry).toBeDefined();
    expect(aliceEntry!.total).toBe(2);
    expect(aliceEntry!.agentId).toBe("a-prod");
    expect(bobEntry).toBeDefined();
    expect(bobEntry!.total).toBe(1);
    expect(bobEntry!.agentId).toBe("a-dev");

    expect(aliceTools.find((t) => t.userId === "bob")).toBeUndefined();
    expect(bobTools.find((t) => t.userId === "alice")).toBeUndefined();
  });
});
