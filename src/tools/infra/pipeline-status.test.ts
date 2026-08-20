import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hasPipeline, instrumentPipeline, extractPipelineStatus, pipelineStages } from "./pipeline-status.js";
import { classifyExit } from "./exit-classification.js";

const sh = promisify(execFile);

/**
 * The largest group in the review backlog — 13 findings, most of them high — is one fact: a pipeline's
 * exit code is the LAST stage's, and the last stage is often not the one that matters.
 *
 * These run REAL bash rather than mocking PIPESTATUS, because the whole fix rests on what bash actually
 * reports, and the two cases that matter are easy to get backwards.
 */
async function run(command: string) {
  let out = "", code: number | string = 0;
  try { out = (await sh("/bin/bash", ["-c", instrumentPipeline(command)])).stdout; }
  catch (e: any) { out = e.stdout ?? ""; code = e.code; }
  const { stdout, statuses } = extractPipelineStatus(out);
  return { stdout, statuses, code,
    judgment: classifyExit({ command, exitCode: code, stdout, stderr: "", context: "local", pipeStatuses: statuses }) };
}

describe("an upstream failure is not a successful empty result", () => {
  it("reports which stage failed when the last one exited 0", async () => {
    // `kubectl get x | jq .` with kubectl exiting 1: seven high-severity findings are this shape. The
    // agent reads an empty result as "nothing found" instead of "the query failed".
    const r = await run("false | true");
    expect(r.code, "the shell still says success").toBe(0);
    expect(r.statuses).toEqual([1, 0]);
    expect(r.judgment.exitClass).toBe("pipeline_upstream_failed");
    expect(r.judgment.isError).toBe(true);
    expect(r.judgment.annotation).toMatch(/stage 1\/2/);
    expect(r.judgment.annotation, "must say an empty result is not evidence").toMatch(/not.*complete|EARLIER/i);
  });

  it("does not blame an upstream stage when the last one is the one that failed", async () => {
    const r = await run("true | false");
    expect(r.statuses).toEqual([0, 1]);
    expect(r.judgment.exitClass).toBe("target_reported_failure");
  });
});

describe("SIGPIPE into a consumer that stops on purpose", () => {
  it("is not a failure, with or without pipefail", async () => {
    // ~18 retro asks. `seq … | head -3` is correct; under pipefail it exits 141 and was reported failed,
    // retried, failed again.
    for (const command of ["seq 1 200000 | head -3", "set -o pipefail; seq 1 200000 | head -3"]) {
      const r = await run(command);
      expect(r.statuses[0], command).toBe(141);
      expect(r.judgment.exitClass, command).toBe("success");
      expect(r.judgment.isError, command).toBe(false);
      expect(r.judgment.annotation, command).toMatch(/SIGPIPE/);
      expect(r.stdout.trim().split("\n"), command).toEqual(["1", "2", "3"]);
    }
  });

  it("preserves the exit code the caller's own shell options produced", async () => {
    // The wrapper reports the fact; it does not quietly override a shell option the caller chose.
    expect((await run("seq 1 200000 | head -3")).code).toBe(0);
    expect((await run("set -o pipefail; seq 1 200000 | head -3")).code).toBe(141);
  });

  it("does NOT call a 141 on the last stage benign — read from a real trace", () => {
    // My first version of this rule said `last === 141 && stages.length > 1` → success. Trace ce1bd949
    // shows why that is wrong, and it is worth spelling out because the shape looks benign:
    //
    //   kubectl logs -n ingress-nginx -l … --tail=-1 | grep -c '…'   exit 141, (no output), 83s
    //   kubectl logs … | grep … | grep -oE … | sort | uniq -c        exit 141, (no output), 61s
    //   kubectl logs … | grep … | grep -cE …                         exit 1,   "0",         11s
    //
    // The last stage is `grep -c` / `uniq -c`, which read to the END — not consumers that stop early.
    // Nothing is downstream of the last stage, so no consumer could have closed the pipe: it was killed.
    // And `grep -c` that finishes ALWAYS prints a number, as the third line shows — no output means it
    // never got there. Calling that success would have handed the agent an empty result as the answer.
    for (const statuses of [[0, 141], [0, 0, 0, 0, 141]]) {
      const j = classifyExit({
        command: "kubectl logs -n ingress-nginx -l app=x --tail=-1 | grep -c 'q'",
        exitCode: 141, stdout: "", stderr: "", context: "local", pipeStatuses: statuses,
      });
      expect(j.exitClass, String(statuses)).toBe("output_truncated");
      expect(j.isError, String(statuses)).toBe(true);
      expect(j.annotation).toMatch(/not evidence of absence|incomplete/);
      expect(j.annotation, "must not tell the agent this is what it asked for").not.toMatch(/what was asked for/);
    }
  });

  it("keeps a completed grep -c zero count as no_match, from the same trace", () => {
    // The same finding asked for both. This is the line that DID complete: exit 1 with "0" on stdout.
    const j = classifyExit({
      command: "kubectl logs x | grep q | grep -cE r",
      exitCode: 1, stdout: "0", stderr: "", context: "local", pipeStatuses: [0, 0, 1],
    });
    expect(j.exitClass).toBe("no_match");
    expect(j.isError).toBe(false);
  });
});

describe("the sentinel never reaches the caller", () => {
  it("leaves output byte-identical to an uninstrumented run", async () => {
    for (const command of ["echo hi | cat", 'echo \'{"a":1}\' | cat', "printf 'no-newline' | cat"]) {
      const bare = (await sh("/bin/bash", ["-c", command])).stdout;
      const r = await run(command);
      expect(r.stdout, command).toBe(bare);
      expect(r.stdout, command).not.toMatch(/siclaw_pipe_status/);
    }
  });

  it("degrades to the plain exit code when the trailer never runs", async () => {
    // A command that exits the shell itself skips the trailer. No sentinel, no statuses, and the
    // judgment falls back to exit-code-only — today's behaviour, which is the right failure mode.
    const r = await run("echo a | cat; exit 3");
    expect(r.statuses).toEqual([]);
    expect(r.judgment.exitClass).toBe("target_reported_failure");
  });
});

describe("scope", () => {
  it("instruments a pipeline and leaves everything else alone", () => {
    expect(hasPipeline("a | b")).toBe(true);
    expect(hasPipeline("a || b"), "|| is not a pipeline").toBe(false);
    expect(hasPipeline("kubectl get pods")).toBe(false);
    expect(pipelineStages("a | b | c")).toEqual(["a", "b", "c"]);
    expect(pipelineStages("a || b"), "|| must not split").toEqual(["a || b"]);
  });

  it("says nothing about a chain, because PIPESTATUS covers only the last pipeline", async () => {
    // Stated rather than implied: `;` and `&&` chains still report one status. Attributing a chain needs
    // per-command traps, which is a different mechanism.
    const r = await run("false; true | true");
    expect(r.statuses, "the last pipeline only").toEqual([0, 0]);
    expect(r.judgment.exitClass).toBe("success");
  });
});
