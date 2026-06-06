import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reloadConfig } from "./config.js";
import { JobRegistry } from "./job-registry.js";
import { spawnBackgroundBash } from "./background-bash-runner.js";
import { DiskTaskOutput, getTaskOutputDir, getTaskOutputPath, SanitizingLineBuffer } from "../tools/cmd-exec/disk-output.js";
import type { BackgroundExecRequest } from "./tool-registry.js";
import type { OutputAction } from "../tools/infra/output-sanitizer.js";

let tmp: string;
let prevEnv: string | undefined;

beforeAll(() => {
  prevEnv = process.env.SICLAW_USER_DATA_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-bgbash-"));
  process.env.SICLAW_USER_DATA_DIR = tmp;
  reloadConfig();
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.SICLAW_USER_DATA_DIR;
  else process.env.SICLAW_USER_DATA_DIR = prevEnv;
  reloadConfig();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A line-safe sanitizer that deterministically redacts the token "SECRET".
const redactSecret: OutputAction = {
  type: "sanitize",
  sanitize: (s) => s.replace(/SECRET/g, "**REDACTED**"),
  lineSafe: true,
};

function req(overrides: Partial<BackgroundExecRequest>): BackgroundExecRequest {
  return {
    command: "true",
    env: process.env as Record<string, string>,
    cwd: process.cwd(),
    action: null,
    hasSensitiveKubectl: false,
    description: "test cmd",
    parentSessionId: "s1",
    jobId: `j-${Math.random().toString(36).slice(2)}`,
    isProd: false,
    ...overrides,
  };
}

function runToCompletion(r: BackgroundExecRequest, jobs: JobRegistry) {
  return new Promise<{ status: string; outputFile: string }>((resolve) => {
    const res = spawnBackgroundBash(r, jobs, (jobId, n) => {
      resolve({ status: n.status, outputFile: n.outputFile! });
    });
    void res;
  });
}

describe("spawnBackgroundBash", () => {
  it("streams sanitized output to disk and completes (exit 0)", async () => {
    const jobs = new JobRegistry();
    const r = req({
      command: `printf 'line1 SECRET\\nline2 ok\\n'`,
      action: redactSecret,
    });
    const { status, outputFile } = await runToCompletion(r, jobs);
    expect(status).toBe("completed");
    const content = fs.readFileSync(outputFile, "utf8");
    expect(content).toContain("line1 **REDACTED**");
    expect(content).toContain("line2 ok");
    expect(content).not.toContain("SECRET");
    expect(jobs.get(r.jobId)?.status).toBe("completed");
    expect(getTaskOutputPath(r.jobId)).toBe(outputFile);
  });

  it("flushes a trailing partial line (no newline) on exit", async () => {
    const jobs = new JobRegistry();
    const r = req({ command: `printf 'no-newline-tail'`, action: redactSecret });
    const { outputFile } = await runToCompletion(r, jobs);
    expect(fs.readFileSync(outputFile, "utf8")).toContain("no-newline-tail");
  });

  it("reports failed on non-zero exit", async () => {
    const jobs = new JobRegistry();
    const r = req({ command: `echo boom; exit 3` });
    const { status } = await runToCompletion(r, jobs);
    expect(status).toBe("failed");
    expect(jobs.get(r.jobId)?.exitCode).toBe(3);
  });

  it("kill via job-stop keeps status 'stopped' (matches the sub-agent path), process-group reaped", async () => {
    const jobs = new JobRegistry();
    const r = req({ command: `sleep 30` });
    const done = new Promise<string>((resolve) => {
      spawnBackgroundBash(r, jobs, (_id, n) => resolve(n.status));
    });
    // mimic stopJob: mark stopped, then abort (process-group SIGKILL)
    await new Promise((res) => setTimeout(res, 100));
    jobs.setStatus(r.jobId, "stopped");
    jobs.get(r.jobId)!.abort!();
    // close handler must NOT overwrite "stopped" with "killed" — same terminal state as a
    // stopped sub-agent, so the notification the model sees is consistent across paths.
    expect(await done).toBe("stopped");
  });
});

describe("spawnBackgroundBash — argv mode (node/pod)", () => {
  it("spawns file+args without a shell, streams output, sets jobType, fires onComplete once", async () => {
    const jobs = new JobRegistry();
    const jobId = `jn-${Math.random().toString(36).slice(2)}`;
    let onCompleteCalls = 0;
    const done = new Promise<{ status: string; outputFile: string }>((resolve) => {
      spawnBackgroundBash(
        {
          file: "/bin/sh",
          args: ["-c", "printf 'ARGV_MODE_OK\\n'"],
          env: process.env as Record<string, string>,
          action: null,
          hasSensitiveKubectl: false,
          description: "node x: printf",
          parentSessionId: "s1",
          jobId,
          isProd: false,
          jobType: "node",
          onComplete: () => { onCompleteCalls++; },
        },
        jobs,
        (_id, n) => resolve({ status: n.status, outputFile: n.outputFile! }),
      );
    });
    const { status, outputFile } = await done;
    expect(status).toBe("completed");
    expect(jobs.get(jobId)?.type).toBe("node");
    expect(fs.readFileSync(outputFile, "utf8")).toContain("ARGV_MODE_OK");
    // onComplete fires exactly once (settle is latched)
    await new Promise((r) => setTimeout(r, 20));
    expect(onCompleteCalls).toBe(1);
  });
});

describe("SanitizingLineBuffer", () => {
  it("refuses a non-line-safe action (fail closed)", () => {
    const jsonAction: OutputAction = { type: "sanitize", sanitize: (s) => s, lineSafe: false };
    expect(() => new SanitizingLineBuffer(new DiskTaskOutput("x"), jsonAction, false)).toThrow(/non-line-safe/);
  });
});

describe("getTaskOutputPath jobId sanitization", () => {
  it("sanitizes provider tool-call ids with dots/colons (e.g. functions.bash:0)", () => {
    expect(getTaskOutputPath("functions.bash:0")).toBe(path.join(getTaskOutputDir(), "functions_bash_0.output"));
  });
  it("is traversal-proof: result always stays inside the tasks dir", () => {
    const tasksDir = getTaskOutputDir();
    for (const id of ["../../etc/passwd", "a/b", "with space", "x/../../y"]) {
      const p = getTaskOutputPath(id);
      expect(p.startsWith(tasksDir + path.sep)).toBe(true);
      expect(p.includes("..")).toBe(false);
    }
  });
  it("preserves plain tool-call ids unchanged", () => {
    expect(getTaskOutputPath("toolu_01ABC-xyz_9")).toBe(path.join(getTaskOutputDir(), "toolu_01ABC-xyz_9.output"));
  });
  it("rejects a degenerate all-unsafe id", () => {
    expect(() => getTaskOutputPath("///")).toThrow(/Invalid job id/);
  });
});
