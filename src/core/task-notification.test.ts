import { describe, it, expect } from "vitest";
import {
  buildTaskNotificationText, buildNotificationBatch, escapeXml,
  summarizeItemStatuses, buildGroupNotificationSummary,
} from "./task-notification.js";
import type { SubagentGroupReport } from "./tool-registry.js";

describe("task-notification", () => {
  it("includes output_file for bash notifications", () => {
    const text = buildTaskNotificationText({
      taskId: "b123",
      outputFile: "/data/agent/tasks/b123.output",
      status: "completed",
      summary: 'Background command "kubectl get pods" completed (exit 0)',
    });
    expect(text).toContain("<task_notification>");
    expect(text).toContain("<task_id>b123</task_id>");
    expect(text).toContain("<output_file>/data/agent/tasks/b123.output</output_file>");
    expect(text).toContain("<status>completed</status>");
    expect(text).toContain("completed (exit 0)");
    expect(text).toContain("</task_notification>");
  });

  it("includes response guidance so multiple completions don't each re-summarize", () => {
    const text = buildTaskNotificationText({
      taskId: "b1", outputFile: "/o", status: "completed", summary: "done",
    });
    expect(text).toContain("<instructions>");
    expect(text).toMatch(/do NOT repeat any summary|not a new user request/i);
  });

  it("omits output_file for sub-agent notifications", () => {
    const text = buildTaskNotificationText({
      taskId: "a9",
      status: "done",
      summary: "Sub-agent finished",
    });
    expect(text).not.toContain("<output_file>");
    expect(text).toContain("<task_id>a9</task_id>");
  });

  it("escapes XML special chars in summary", () => {
    const text = buildTaskNotificationText({
      taskId: "x",
      status: "failed",
      summary: 'oops <tag> & "quote"',
    });
    expect(text).toContain("&lt;tag&gt; &amp; &quot;quote&quot;");
    expect(text).not.toContain("<tag>");
  });

  it("batches multiple jobs into N blocks + ONE shared instructions", () => {
    const text = buildNotificationBatch([
      { taskId: "a", status: "completed", summary: "first" },
      { taskId: "b", status: "failed", summary: "second" },
    ]);
    expect((text.match(/<task_notification>/g) || []).length).toBe(2);
    expect((text.match(/<instructions>/g) || []).length).toBe(1); // shared, not per-block
    expect(text).toContain("2 background jobs finished");
  });

  it("batch of one is identical to the single form", () => {
    const n = { taskId: "a", status: "completed" as const, summary: "x" };
    expect(buildNotificationBatch([n])).toBe(buildTaskNotificationText(n));
  });

  it("escapeXml covers the five entities", () => {
    expect(escapeXml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&apos;");
  });
});

describe("spawn_subagent batch notification text", () => {
  it("summarizeItemStatuses counts each status in a fixed order", () => {
    const digest = summarizeItemStatuses([
      { status: "done" }, { status: "done" }, { status: "failed" }, { status: "skipped" },
    ]);
    expect(digest).toBe("4 item(s): 2 done, 1 failed, 1 skipped");
  });

  it("buildGroupNotificationSummary inlines the reduce summary under a status digest", () => {
    const report: SubagentGroupReport = {
      status: "partial",
      durationMs: 1000,
      reduceSummary: "Causes: 2 network, 1 storage.",
      itemResults: [
        { item: "a", status: "done", summary: "", childSessionId: "c1" },
        { item: "b", status: "failed", summary: "", childSessionId: "c2" },
        { item: "c", status: "done", summary: "", childSessionId: "c3" },
      ],
    };
    const summary = buildGroupNotificationSummary("crash triage", report);
    expect(summary).toContain('Sub-agent group "crash triage" partial');
    expect(summary).toContain("3 item(s): 2 done, 1 failed");
    expect(summary).toContain("Causes: 2 network, 1 storage.");
  });

  it("buildGroupNotificationSummary omits the reduce block when there is no reduce", () => {
    const report: SubagentGroupReport = {
      status: "done",
      durationMs: 5,
      itemResults: [{ item: "a", status: "done", summary: "cap", childSessionId: "c1" }],
    };
    const summary = buildGroupNotificationSummary("g", report);
    expect(summary).toBe('Sub-agent group "g" done — 1 item(s): 1 done.');
  });
});
