import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reloadConfig } from "../../core/config.js";
import { DiskTaskOutput } from "../cmd-exec/disk-output.js";
import { createTaskOutputTool } from "./task-output.js";
import type { ToolRefs, TaskOutputReader, TaskOutputSnapshot } from "../../core/tool-registry.js";

let tmp: string;
let prevEnv: string | undefined;

beforeAll(() => {
  prevEnv = process.env.SICLAW_USER_DATA_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-taskout-"));
  process.env.SICLAW_USER_DATA_DIR = tmp;
  reloadConfig();
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.SICLAW_USER_DATA_DIR;
  else process.env.SICLAW_USER_DATA_DIR = prevEnv;
  reloadConfig();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function seedOutput(jobId: string, content: string): Promise<void> {
  const disk = new DiskTaskOutput(jobId);
  await disk.ensureCreated();
  if (content) {
    disk.append(content);
    await disk.flush();
  }
}

async function run(reader: TaskOutputReader, params: Record<string, unknown>) {
  const tool = createTaskOutputTool({} as ToolRefs, reader);
  const r = await tool.execute("tc-1", params);
  return JSON.parse((r.content[0] as { text: string }).text);
}

const snap = (s: Partial<TaskOutputSnapshot>): TaskOutputReader => () => ({ found: true, ...s });

describe("task_output tool", () => {
  it("reports running + partial output + a 'still running' note, never an error", async () => {
    await seedOutput("job-run", "partial line 1\n");
    const out = await run(snap({ status: "running" }), { task_id: "job-run" });
    expect(out.status).toBe("running");
    expect(out.running).toBe(true);
    expect(out.output).toContain("partial line 1");
    expect(out.note).toMatch(/still running/i);
    expect(out.error).toBeUndefined();
  });

  it("returns empty (not 404/error) for a running job that has produced no output yet", async () => {
    await seedOutput("job-silent", ""); // ensureCreated only — the ib_write_bw-server case
    const out = await run(snap({ status: "running", outputFile: "x" }), { task_id: "job-silent" });
    expect(out.running).toBe(true);
    expect(out.output).toBe("");
    expect(out.error).toBeUndefined();
  });

  it("returns final output + exit_code when completed", async () => {
    await seedOutput("job-done", "BW result table\n");
    const out = await run(snap({ status: "completed", exitCode: 0 }), { task_id: "job-done" });
    expect(out.status).toBe("completed");
    expect(out.running).toBe(false);
    expect(out.exit_code).toBe(0);
    expect(out.output).toContain("BW result table");
    expect(out.note).toBeUndefined();
  });

  it("reflects failed / stopped terminal states", async () => {
    await seedOutput("job-fail", "boom\n");
    const failed = await run(snap({ status: "failed", exitCode: 1 }), { task_id: "job-fail" });
    expect(failed.status).toBe("failed");
    expect(failed.running).toBe(false);

    await seedOutput("job-stop", "");
    const stopped = await run(snap({ status: "stopped" }), { task_id: "job-stop" });
    expect(stopped.status).toBe("stopped");
    expect(stopped.running).toBe(false);
  });

  it("errors for an unknown task_id", async () => {
    const out = await run(() => ({ found: false }), { task_id: "nope" });
    expect(out.error).toBe(true);
    expect(out.message).toMatch(/no background job/i);
  });

  it("errors when no reader is wired", async () => {
    const tool = createTaskOutputTool({} as ToolRefs, undefined);
    const r = await tool.execute("tc", { task_id: "x" });
    expect(JSON.parse((r.content[0] as { text: string }).text).error).toBe(true);
  });
});
