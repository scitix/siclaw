import { describe, it, expect } from "vitest";
import {
  validateAndRenderGroupPlan,
  buildReduceInput,
  GroupCircuitBreaker,
  truncateReduceSummary,
  type GroupItemOutcome,
} from "./subagent-group.js";

const MAX = 50;

describe("validateAndRenderGroupPlan — count bounds", () => {
  it("rejects an empty items array", () => {
    const r = validateAndRenderGroupPlan({ items: [], maxItems: MAX });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-empty/);
  });
  it("rejects over-limit with a batch hint", () => {
    const items = Array.from({ length: 51 }, (_, i) => `pod-${i}`);
    const r = validateAndRenderGroupPlan({ items, maxItems: MAX });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/batches of ≤50/);
  });
  it("accepts exactly at the limit", () => {
    const items = Array.from({ length: 50 }, (_, i) => `pod-${i}`);
    const r = validateAndRenderGroupPlan({ items, maxItems: MAX });
    expect(r.ok).toBe(true);
  });
});

describe("validateAndRenderGroupPlan — homogeneity", () => {
  it("rejects mixed string/object items", () => {
    const r = validateAndRenderGroupPlan({
      taskTemplate: "{{name}}",
      items: ["a", { name: "b" }] as any,
      maxItems: MAX,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/homogeneous/);
  });
  it("rejects non-string/non-object items", () => {
    const r = validateAndRenderGroupPlan({ items: [123 as any], maxItems: MAX });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/neither a string nor an object/);
  });
});

describe("validateAndRenderGroupPlan — string form", () => {
  it("renders with the implicit {{item}} template when task_template is omitted", () => {
    const r = validateAndRenderGroupPlan({ items: ["pod-a", "pod-b"], maxItems: MAX });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tasks.map((t) => t.prompt)).toEqual(["pod-a", "pod-b"]);
      expect(r.tasks[0].item).toBe("pod-a");
    }
  });
  it("renders an explicit template that references {{item}}", () => {
    const r = validateAndRenderGroupPlan({
      taskTemplate: "Diagnose pod {{item}} for crashes.",
      items: ["a", "b"],
      maxItems: MAX,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tasks[0].prompt).toBe("Diagnose pod a for crashes.");
  });
  it("rejects object task_template omitted (object needs a template)", () => {
    const r = validateAndRenderGroupPlan({ items: [{ name: "a" }], maxItems: MAX });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/task_template` is required/);
  });
  it("rejects a string-form template that references a non-item placeholder", () => {
    const r = validateAndRenderGroupPlan({
      taskTemplate: "Look at {{target}}",
      items: ["a"],
      maxItems: MAX,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/only valid placeholder is \{\{item\}\}/);
  });
  it("rejects a string-form template that never references {{item}}", () => {
    const r = validateAndRenderGroupPlan({
      taskTemplate: "Static prompt with no placeholder",
      items: ["a", "b"],
      maxItems: MAX,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/never references \{\{item\}\}/);
  });
  it("rejects an empty string item", () => {
    const r = validateAndRenderGroupPlan({ items: ["a", "   "], maxItems: MAX });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty string/);
  });
});

describe("validateAndRenderGroupPlan — object form", () => {
  it("renders when placeholders and keys strictly cover each other", () => {
    const r = validateAndRenderGroupPlan({
      taskTemplate: "Investigate {{pod}} in {{ns}}.",
      items: [
        { pod: "web-1", ns: "prod" },
        { pod: "web-2", ns: "prod" },
      ],
      maxItems: MAX,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tasks[0].prompt).toBe("Investigate web-1 in prod.");
      expect(r.tasks[1].prompt).toBe("Investigate web-2 in prod.");
    }
  });
  it("rejects a template referencing a key the item lacks", () => {
    const r = validateAndRenderGroupPlan({
      taskTemplate: "Investigate {{pod}} in {{ns}}.",
      items: [{ pod: "web-1" }],
      maxItems: MAX,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing key\(s\).*\{\{ns\}\}/);
  });
  it("rejects an item key the template never references (typo hint)", () => {
    const r = validateAndRenderGroupPlan({
      taskTemplate: "Investigate {{pod}}.",
      items: [{ pod: "web-1", nspace: "prod" }],
      maxItems: MAX,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/never references.*nspace/);
  });
  it("rejects a non-string object value", () => {
    const r = validateAndRenderGroupPlan({
      taskTemplate: "{{pod}}",
      items: [{ pod: 5 as any }],
      maxItems: MAX,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must be a string value/);
  });
});

describe("validateAndRenderGroupPlan — duplicates", () => {
  it("rejects duplicate string items", () => {
    const r = validateAndRenderGroupPlan({ items: ["a", "b", "a"], maxItems: MAX });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicates item 1/);
  });
  it("rejects duplicate object items regardless of key order", () => {
    const r = validateAndRenderGroupPlan({
      taskTemplate: "{{pod}} {{ns}}",
      items: [
        { pod: "a", ns: "x" },
        { ns: "x", pod: "a" },
      ],
      maxItems: MAX,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/duplicates item 1/);
  });
});

describe("buildReduceInput", () => {
  const results: GroupItemOutcome[] = [
    { item: "pod-a", status: "done", summary: "Root cause: OOMKilled." },
    { item: { pod: "pod-b", ns: "prod" }, status: "failed", summary: "Could not reach node." },
    { item: "pod-c", status: "skipped", summary: "Skipped (circuit breaker)." },
  ];

  it("includes the reduce prompt, per-item headers and bodies", () => {
    const out = buildReduceInput("Summarize the crash causes across all pods.", results);
    expect(out).toContain("Summarize the crash causes across all pods.");
    expect(out).toContain("── item 1: pod-a — status: done ──");
    expect(out).toContain("Root cause: OOMKilled.");
    expect(out).toContain("status: failed");
    expect(out).toContain("status: skipped");
    expect(out).toContain('{"pod":"pod-b","ns":"prod"}');
  });

  it("truncates bodies proportionally when over the cap and marks [truncated]", () => {
    const big: GroupItemOutcome[] = [
      { item: "a", status: "done", summary: "X".repeat(400) },
      { item: "b", status: "done", summary: "Y".repeat(400) },
    ];
    const out = buildReduceInput("reduce", big, 300);
    expect(out).toContain("[truncated]");
    // The whole thing stays roughly within budget (soft cap — allow marker slack).
    expect(out.length).toBeLessThanOrEqual(300 + 64);
  });

  it("does not truncate when under the cap", () => {
    const out = buildReduceInput("reduce", results, 100_000);
    expect(out).not.toContain("[truncated]");
  });
});

describe("GroupCircuitBreaker", () => {
  it("trips when the first 5 completions are all failures", () => {
    const b = new GroupCircuitBreaker();
    for (let i = 0; i < 4; i++) {
      b.record("failed");
      expect(b.tripped).toBe(false);
    }
    b.record("timed_out"); // 5th failure
    expect(b.tripped).toBe(true);
  });

  it("does not trip when a success arrives within the window (out-of-order completion)", () => {
    const b = new GroupCircuitBreaker();
    b.record("failed");
    b.record("failed");
    b.record("done"); // a success — never trip
    b.record("failed");
    b.record("failed");
    b.record("failed");
    expect(b.tripped).toBe(false);
  });

  it("does not trip when a partial breaks the all-failed window", () => {
    const b = new GroupCircuitBreaker();
    b.record("failed");
    b.record("failed");
    b.record("partial"); // ran + produced output ⇒ setup works
    b.record("failed");
    b.record("failed");
    expect(b.tripped).toBe(false);
  });

  it("skipped items are not counted as completions", () => {
    const b = new GroupCircuitBreaker();
    b.record("skipped");
    b.record("skipped");
    for (let i = 0; i < 5; i++) b.record("failed");
    expect(b.tripped).toBe(true);
  });

  it("a late success releases the breaker permanently", () => {
    const b = new GroupCircuitBreaker();
    for (let i = 0; i < 5; i++) b.record("failed");
    expect(b.tripped).toBe(true);
    b.record("done"); // an in-flight child succeeded after the trip
    expect(b.tripped).toBe(false);
  });

  it("never trips for groups smaller than the window", () => {
    const b = new GroupCircuitBreaker();
    b.record("failed");
    b.record("failed");
    b.record("failed");
    expect(b.tripped).toBe(false);
  });
});

describe("truncateReduceSummary", () => {
  it("passes short summaries through unchanged", () => {
    const { text, truncated } = truncateReduceSummary("short", 6000);
    expect(text).toBe("short");
    expect(truncated).toBe(false);
  });
  it("truncates and annotates over the cap", () => {
    const { text, truncated } = truncateReduceSummary("Z".repeat(7000), 6000);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toMatch(/\[reduce summary truncated to 6000 chars\]/);
  });
});
