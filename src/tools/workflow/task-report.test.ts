import { describe, it, expect } from "vitest";
import { createTaskReportTool } from "./task-report.js";

describe("createTaskReportTool", () => {
  const tool = createTaskReportTool();

  it("has correct name", () => {
    expect(tool.name).toBe("task_report");
  });

  it("has correct label", () => {
    expect(tool.label).toBe("Task Report");
  });

  it("echoes summary param as text content", async () => {
    const result = await tool.execute("tc-1", { summary: "All diagnostics passed." });
    expect((result.content[0] as any).text).toBe("All diagnostics passed.");
    expect(result.details).toEqual({});
  });

  it("handles empty summary", async () => {
    const result = await tool.execute("tc-2", { summary: "" });
    expect((result.content[0] as any).text).toBe("");
  });

  it("preserves markdown content", async () => {
    const md = "# Heading\n- item 1\n- item 2";
    const result = await tool.execute("tc-3", { summary: md });
    expect((result.content[0] as any).text).toBe(md);
  });
});
