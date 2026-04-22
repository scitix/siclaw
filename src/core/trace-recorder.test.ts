import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { TraceRecorder } from "./trace-recorder.js";
import { emitDiagnostic } from "../shared/diagnostic-events.js";

describe("TraceRecorder", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-rec-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRecorder(sessionId = "sess-1") {
    return new TraceRecorder({
      traceDir: tmpDir,
      sessionId,
      userId: "u1",
      mode: "cli",
      brainType: "pi-agent",
      getSessionStats: () => ({
        tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
        cost: 0.01,
      }),
      getModel: () => ({
        id: "test-model",
        name: "Test",
        provider: "fake",
        contextWindow: 8000,
        maxTokens: 2000,
        reasoning: false,
      }),
    });
  }

  function readTraces(): Array<Record<string, unknown>> {
    return fs
      .readdirSync(tmpDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(tmpDir, f), "utf-8")));
  }

  it("writes a JSON trace on agent_start → agent_end with tool calls", () => {
    const rec = makeRecorder();
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) {
        listeners.push(fn);
        return () => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    } as any;

    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

    emit({ type: "message_end", message: { role: "user", content: "check pods" } });
    emit({ type: "agent_start" });
    emit({ type: "turn_start" });
    emit({
      type: "tool_execution_start",
      toolName: "restricted_bash",
      toolCallId: "tc1",
      args: { command: "kubectl get pods" },
    });
    emit({
      type: "tool_execution_end",
      toolName: "restricted_bash",
      toolCallId: "tc1",
      result: { content: [{ type: "text", text: "pod1 Running" }] },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "end_turn",
        content: [{ type: "text", text: "All pods healthy." }],
      },
    });
    emit({ type: "turn_end" });
    emit({ type: "agent_end" });

    const traces = readTraces();
    expect(traces).toHaveLength(1);
    const t = traces[0] as any;
    expect(t.sessionId).toBe("sess-1");
    expect(t.userMessage).toBe("check pods");
    expect(t.outcome).toBe("completed");
    expect(t.mode).toBe("cli");
    expect(t.brainType).toBe("pi-agent");

    const toolCallSteps = t.steps.filter((s: any) => s.kind === "tool_call");
    expect(toolCallSteps).toHaveLength(1);
    expect(toolCallSteps[0].name).toBe("restricted_bash");
    expect(toolCallSteps[0].args).toEqual({ command: "kubectl get pods" });
    expect(toolCallSteps[0].output).toBe("pod1 Running");
    expect(toolCallSteps[0].isError).toBe(false);
    expect(typeof toolCallSteps[0].durationMs).toBe("number");
    // Beijing-time strings: "YYYY-MM-DD HH:mm:ss.SSS"
    expect(toolCallSteps[0].startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(toolCallSteps[0].endedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);

    const msgSteps = t.steps.filter((s: any) => s.kind === "message");
    expect(msgSteps[0].text).toBe("All pods healthy.");
    expect(msgSteps[0].role).toBe("assistant");
    expect(msgSteps[0].ts).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);

    expect(t.startedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(t.endedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);

    expect(t.stats.tokensDelta).toBeDefined();
    // schemaVersion has been bumped to "1.1" for the slimmed schema.
    expect(t.schemaVersion).toBe("1.1");
    // Redundant fields removed.
    expect(t.traceId).toBeUndefined();
    expect(t.eventCount).toBeUndefined();
    expect(t.stats.before).toBeUndefined();
    expect(t.stats.after).toBeUndefined();
  });

  it("records skill via local_script (Path B)", () => {
    const rec = makeRecorder();
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) { listeners.push(fn); return () => {}; },
    } as any;
    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

    emit({ type: "agent_start" });
    emit({
      type: "tool_execution_start",
      toolName: "local_script",
      toolCallId: "tc1",
      args: { skill: "pod-diagnosis", script: "check.sh" },
    });
    emit({
      type: "tool_execution_end",
      toolName: "local_script",
      toolCallId: "tc1",
      result: { content: [{ type: "text", text: "ok" }] },
    });
    emit({ type: "agent_end" });

    const t = readTraces()[0] as any;
    const toolCall = t.steps.find((s: any) => s.kind === "tool_call");
    expect(toolCall.skill).toEqual({ skillName: "pod-diagnosis", scriptName: "check.sh", via: "local_script" });
    expect(t.skillsUsed).toHaveLength(1);
    expect(t.skillsUsed[0]).toMatchObject({ skillName: "pod-diagnosis", via: "local_script" });
  });

  it("records skill via read(SKILL.md) (Path A)", () => {
    const rec = makeRecorder();
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) { listeners.push(fn); return () => {}; },
    } as any;
    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

    emit({ type: "agent_start" });
    emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "r1",
      args: { path: "/home/yye/siclaw/skills/core/cluster-events/SKILL.md" },
    });
    emit({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "r1",
      result: { content: [{ type: "text", text: "# Cluster Events\n..." }] },
    });
    emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "r2",
      args: { path: "/home/yye/siclaw/skills/user/yye/my-skill/SKILL.md" },
    });
    emit({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "r2",
      result: { content: [{ type: "text", text: "..." }] },
    });
    emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "r3",
      args: { path: "/home/yye/siclaw/src/core/agent-factory.ts" },  // non-skill, should be ignored
    });
    emit({
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "r3",
      result: { content: [{ type: "text", text: "..." }] },
    });
    emit({ type: "agent_end" });

    const t = readTraces()[0] as any;
    expect(t.skillsUsed).toHaveLength(2);
    expect(t.skillsUsed[0]).toEqual(expect.objectContaining({
      skillName: "cluster-events", scope: "core", via: "read",
    }));
    expect(t.skillsUsed[1]).toEqual(expect.objectContaining({
      skillName: "my-skill", scope: "user", via: "read",
    }));
    // Non-SKILL.md read should have no skill field.
    const tcs = t.steps.filter((s: any) => s.kind === "tool_call");
    expect(tcs[2].skill).toBeUndefined();
  });

  it("drops redundant toolResult and user role messages from steps", () => {
    const rec = makeRecorder();
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) { listeners.push(fn); return () => {}; },
    } as any;
    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

    emit({ type: "message_end", message: { role: "user", content: "hi" } });
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: { role: "toolResult", content: "duplicate of tool output" } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "reply" }] } });
    emit({ type: "agent_end" });

    const t = readTraces()[0] as any;
    const messages = t.steps.filter((s: any) => s.kind === "message");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("assistant");
  });

  it("enriches local_script scope when diagnostic event fires BEFORE tool_execution_end", () => {
    const rec = makeRecorder();
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) { listeners.push(fn); return () => {}; },
    } as any;
    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

    // Simulate the real order observed in local-script.ts:
    // diagnostic fires *inside* the tool's execute(), before the brain dispatches tool_execution_end.
    emit({ type: "agent_start" });
    emit({ type: "tool_execution_start", toolName: "local_script", toolCallId: "tc1",
           args: { skill: "volcano-diagnose-pod", script: "diagnose-pod.sh" } });
    emitDiagnostic({
      type: "skill_call",
      skillName: "volcano-diagnose-pod",
      scriptName: "diagnose-pod.sh",
      scope: "personal",
      outcome: "success",
      durationMs: 123,
      sessionId: "sess-1",
    });
    emit({ type: "tool_execution_end", toolName: "local_script", toolCallId: "tc1",
           result: { content: [{ type: "text", text: "done" }] } });
    emit({ type: "agent_end" });

    const t = readTraces()[0] as any;
    const toolCall = t.steps.find((s: any) => s.kind === "tool_call");
    expect(toolCall.skill.scope).toBe("personal");
  });

  it("marks outcome as error when assistant stopReason=error", () => {
    const rec = makeRecorder();
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) {
        listeners.push(fn);
        return () => {};
      },
    } as any;
    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

    emit({ type: "agent_start" });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "rate limit",
        content: [],
      },
    });
    emit({ type: "agent_end" });

    const t = readTraces()[0] as any;
    expect(t.outcome).toBe("error");
  });

  it("writes filename as trace-<date>-<time>-<user>.json", () => {
    const rec = makeRecorder("sess-abc");
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) { listeners.push(fn); return () => {}; },
    } as any;
    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));
    emit({ type: "agent_start" });
    emit({ type: "agent_end" });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    // trace-YYYYMMDD-HH-mm-ss-<user>.json
    expect(files[0]).toMatch(/^trace-\d{8}-\d{2}-\d{2}-\d{2}-u1\.json$/);
  });

  it("writes separate files for separate agent_start/agent_end cycles", () => {
    const rec = makeRecorder();
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) {
        listeners.push(fn);
        return () => {};
      },
    } as any;
    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

    emit({ type: "message_end", message: { role: "user", content: "first" } });
    emit({ type: "agent_start" });
    emit({ type: "agent_end" });

    emit({ type: "message_end", message: { role: "user", content: "second" } });
    emit({ type: "agent_start" });
    emit({ type: "agent_end" });

    const traces = readTraces();
    expect(traces).toHaveLength(2);
    const userMsgs = traces.map((t: any) => t.userMessage).sort();
    expect(userMsgs).toEqual(["first", "second"]);
  });

  it("setUserMessage() captures user input when message_end{role:user} is absent (web/agentbox path)", () => {
    const rec = makeRecorder();
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) { listeners.push(fn); return () => {}; },
    } as any;
    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

    // Web-mode flow: caller hands the raw prompt to the recorder, then the
    // brain emits agent_start directly (NO preceding user message_end event).
    rec.setUserMessage("当前的集群有多少pod");
    emit({ type: "agent_start" });
    emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: "753 pods" }] },
    });
    emit({ type: "agent_end" });

    const t = readTraces()[0] as any;
    expect(t.userMessage).toBe("当前的集群有多少pod");
  });

  it("explicit mode merges multiple internal agent_start/end cycles into ONE trace (retry/compaction case)", () => {
    // This is the real-world regression: ONE user prompt ("检查集群硬件问题...")
    // caused pi-agent to fire TWO agent_start/agent_end cycles internally (due
    // to empty-response retry or auto-compaction), which previously produced two
    // trace files. With explicit boundaries via beginPrompt/endPrompt, both
    // cycles must be merged into a single trace file.
    const rec = makeRecorder();
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) { listeners.push(fn); return () => {}; },
    } as any;
    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

    rec.beginPrompt("检查当前的这个集群里面有哪些硬件问题？");

    // Internal cycle #1 — initial run with tool calls
    emit({ type: "agent_start" });
    emit({ type: "turn_start" });
    emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "t1",
           args: { command: "kubectl get nodes -o wide" } });
    emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "t1",
           result: { content: [{ type: "text", text: "Ready nodes..." }] } });
    emit({ type: "turn_end" });
    emit({ type: "agent_end" });

    // Pi-agent re-emits the user message verbatim (with language prefix) when
    // it retries — this must NOT overwrite our authoritative userMessage.
    emit({
      type: "message_end",
      message: { role: "user", content: "[System: respond in Chinese]\n检查当前的这个集群里面有哪些硬件问题？" },
    });

    // Internal cycle #2 — retry / continuation with more tool calls
    emit({ type: "agent_start" });
    emit({ type: "turn_start" });
    emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "t2",
           args: { command: "kubectl top nodes" } });
    emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "t2",
           result: { content: [{ type: "text", text: "cpu/mem..." }] } });
    emit({
      type: "message_end",
      message: { role: "assistant", stopReason: "end_turn",
                 content: [{ type: "text", text: "报告完成" }] },
    });
    emit({ type: "turn_end" });
    emit({ type: "agent_end" });

    rec.endPrompt("completed");

    const traces = readTraces();
    expect(traces).toHaveLength(1);                                // ← 关键断言：只有 1 份文件
    const t = traces[0] as any;
    expect(t.userMessage).toBe("检查当前的这个集群里面有哪些硬件问题？"); // ← 不被 retry 时的 pi-agent 回放污染
    const toolCalls = t.steps.filter((s: any) => s.kind === "tool_call");
    expect(toolCalls).toHaveLength(2);                             // ← 两个周期的工具调用都在
    expect((toolCalls[0].args as any).command).toBe("kubectl get nodes -o wide");
    expect((toolCalls[1].args as any).command).toBe("kubectl top nodes");
    expect(t.outcome).toBe("completed");
  });

  it("auto mode (no beginPrompt) still works via agent_start/end as fallback", () => {
    // If external code never calls beginPrompt, we fall back to auto-detect.
    // This path must keep working for non-wrapped callers.
    const rec = makeRecorder();
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) { listeners.push(fn); return () => {}; },
    } as any;
    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

    emit({ type: "message_end", message: { role: "user", content: "hello" } });
    emit({ type: "agent_start" });
    emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "tc1", args: { command: "ls" } });
    emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "tc1",
           result: { content: [{ type: "text", text: "ok" }] } });
    emit({ type: "agent_end" });

    const t = readTraces()[0] as any;
    expect(t.userMessage).toBe("hello");
    expect(t.steps.filter((s: any) => s.kind === "tool_call")).toHaveLength(1);
  });

  it("close() flushes an in-flight trace", () => {
    const rec = makeRecorder();
    const listeners: Array<(e: unknown) => void> = [];
    const fakeBrain = {
      brainType: "pi-agent" as const,
      subscribe(fn: (e: unknown) => void) {
        listeners.push(fn);
        return () => {};
      },
    } as any;
    rec.attach(fakeBrain);
    const emit = (e: unknown) => listeners.forEach((fn) => fn(e));

    emit({ type: "agent_start" });
    emit({ type: "turn_start" });
    rec.close();

    expect(readTraces()).toHaveLength(1);
  });
});
