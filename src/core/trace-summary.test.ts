import { describe, it, expect } from "vitest";
import { buildTraceSummary, type SummaryStepInput, type SummaryEvent } from "./trace-summary.js";

function user(text: string): SummaryStepInput {
  return { kind: "message", role: "user", text };
}
function ai(text: string): SummaryStepInput {
  return { kind: "message", role: "assistant", text };
}
function tool(name: string, args?: unknown, output = "", isError = false): SummaryStepInput {
  return { kind: "tool_call", name, args, output, isError };
}

describe("buildTraceSummary", () => {
  it("starts with a USER event derived from userMessage", () => {
    const r = buildTraceSummary({ userMessage: "hello", steps: [] });
    expect(r.events[0]).toEqual({ t: "user", text: "hello" });
  });

  it("emits USER even when userMessage is empty (timeline anchor)", () => {
    const r = buildTraceSummary({ userMessage: "", steps: [] });
    expect(r.events[0]).toEqual({ t: "user", text: "" });
  });

  it("preserves chronological order of steps", () => {
    const r = buildTraceSummary({
      userMessage: "go",
      steps: [
        tool("bash", { command: "ls" }, "file1\nfile2"),
        tool("read", { path: "/etc/hosts" }, "127.0.0.1 localhost"),
        ai("done"),
      ],
    });
    const projection = r.events.map((e) => e.t);
    expect(projection).toEqual(["user", "tool", "tool", "ai"]);
  });

  it("marks only the last assistant text as final", () => {
    const r = buildTraceSummary({
      userMessage: "go",
      steps: [ai("first"), tool("bash", { command: "x" }, "ok"), ai("middle"), ai("end")],
    });
    const aiEvents = r.events.filter((e) => e.t === "ai") as Array<Extract<SummaryEvent, { t: "ai" }>>;
    expect(aiEvents.map((e) => e.text)).toEqual(["first", "middle", "end"]);
    expect(aiEvents[0].final).toBeUndefined();
    expect(aiEvents[1].final).toBeUndefined();
    expect(aiEvents[2].final).toBe(true);
  });

  it("drops empty assistant messages (tool-call-only)", () => {
    const r = buildTraceSummary({
      userMessage: "go",
      steps: [ai(""), tool("bash", { command: "ls" }, "ok"), ai("answer")],
    });
    expect(r.events.map((e) => e.t)).toEqual(["user", "tool", "ai"]);
  });

  it("drops scaffolding steps: turn_start, turn_end, auto_*, model_error", () => {
    const r = buildTraceSummary({
      userMessage: "go",
      steps: [
        { kind: "turn_start" },
        tool("bash", { command: "ls" }, "ok"),
        { kind: "auto_compaction" },
        { kind: "auto_retry" },
        { kind: "model_error" },
        { kind: "turn_end" },
        ai("done"),
      ],
    });
    expect(r.events.map((e) => e.t)).toEqual(["user", "tool", "ai"]);
  });

  it("formats bash with $ command", () => {
    const r = buildTraceSummary({
      userMessage: "go",
      steps: [tool("restricted-bash", { command: "kubectl get pods" }, "NAME READY")],
    });
    const ev = r.events.find((e) => e.t === "tool") as Extract<SummaryEvent, { t: "tool" }>;
    expect(ev.input).toBe("kubectl get pods");
    expect(r.line).toContain("$ kubectl get pods");
    expect(r.line).toContain("> NAME READY");
  });

  it("formats read/edit/write with path object", () => {
    const r = buildTraceSummary({
      userMessage: "go",
      steps: [
        tool("read", { path: "/foo.txt" }, "contents"),
        tool("write", { path: "/bar.txt", content: "hello world" }, "ok"),
      ],
    });
    const evs = r.events.filter((e) => e.t === "tool") as Array<Extract<SummaryEvent, { t: "tool" }>>;
    expect(evs[0].input).toEqual({ path: "/foo.txt" });
    expect(evs[1].input).toEqual({ path: "/bar.txt", bytes: 11 });
  });

  it("marks isError on failed tools", () => {
    const r = buildTraceSummary({
      userMessage: "go",
      steps: [tool("restricted-bash", { command: "false" }, "[error] exitCode=1", true)],
    });
    const ev = r.events.find((e) => e.t === "tool") as Extract<SummaryEvent, { t: "tool" }>;
    expect(ev.isError).toBe(true);
    expect(r.line).toContain("TOOL restricted-bash !");
  });

  it("attaches skill name when present", () => {
    const r = buildTraceSummary({
      userMessage: "go",
      steps: [
        {
          kind: "tool_call",
          name: "restricted-bash",
          args: { command: "echo hi" },
          output: "hi",
          isError: false,
          skill: { skillName: "investigate-pod", scope: "core", via: "read" },
        },
      ],
    });
    const ev = r.events.find((e) => e.t === "tool") as Extract<SummaryEvent, { t: "tool" }>;
    expect(ev.skill).toBe("investigate-pod");
    expect(r.line).toContain("(skill:investigate-pod)");
  });

  it("preserves long user/ai text verbatim (no truncation)", () => {
    const long = "x".repeat(20000);
    const r = buildTraceSummary({ userMessage: long, steps: [ai(long)] });
    const u = r.events[0] as Extract<SummaryEvent, { t: "user" }>;
    const a = r.events.find((e) => e.t === "ai") as Extract<SummaryEvent, { t: "ai" }>;
    expect(u.text).toBe(long);
    expect(a.text).toBe(long);
  });

  it("preserves long tool output verbatim (no truncation)", () => {
    const long = "A".repeat(5000) + "MID" + "B".repeat(5000) + "TAIL";
    const r = buildTraceSummary({
      userMessage: "go",
      steps: [tool("restricted-bash", { command: "x" }, long)],
    });
    const ev = r.events.find((e) => e.t === "tool") as Extract<SummaryEvent, { t: "tool" }>;
    expect(ev.output).toBe(long);
  });

  it("keeps every event regardless of total summary size", () => {
    const steps: SummaryStepInput[] = [];
    for (let i = 0; i < 200; i++) {
      steps.push(tool("restricted-bash", { command: `cmd-${i}` }, "X".repeat(200)));
    }
    steps.push(ai("final"));
    const r = buildTraceSummary({ userMessage: "u", steps });
    expect(r.events[0]).toEqual({ t: "user", text: "u" });
    const last = r.events[r.events.length - 1] as Extract<SummaryEvent, { t: "ai" }>;
    expect(last.t).toBe("ai");
    expect(last.final).toBe(true);
    // 200 tools + 1 user + 1 ai = 202 events, all preserved.
    expect(r.events.length).toBe(202);
  });

  it("steps order is preserved property-style: projection equals input projection", () => {
    // Random-but-deterministic sequence of 30 events, then assert the
    // (kind, name) projection of the events output matches the projection
    // computed from the input.
    const rng = mulberry32(42);
    const steps: SummaryStepInput[] = [];
    const expected: Array<{ t: string; n?: string }> = [];
    for (let i = 0; i < 30; i++) {
      const r = rng();
      if (r < 0.4) {
        steps.push(tool(`tool${i % 5}`, { command: `c${i}` }, `out${i}`));
        expected.push({ t: "tool", n: `tool${i % 5}` });
      } else if (r < 0.7) {
        steps.push(ai(`msg${i}`));
        expected.push({ t: "ai" });
      } else {
        steps.push({ kind: "turn_start" }); // dropped
      }
    }
    const r = buildTraceSummary({ userMessage: "go", steps });
    const got = r.events
      .filter((e) => e.t === "tool" || e.t === "ai")
      .map((e) => e.t === "tool"
        ? { t: "tool", n: (e as Extract<SummaryEvent, { t: "tool" }>).name }
        : { t: "ai" });
    expect(got).toEqual(expected);
  });
});

// Tiny seeded PRNG so the property-style test is deterministic.
function mulberry32(a: number): () => number {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
