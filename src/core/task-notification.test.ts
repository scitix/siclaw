import { describe, it, expect } from "vitest";
import { buildTaskNotificationText, buildNotificationBatch, escapeXml } from "./task-notification.js";

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
