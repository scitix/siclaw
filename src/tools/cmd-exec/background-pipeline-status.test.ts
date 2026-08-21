import { describe, it, expect, vi } from "vitest";
import { createRestrictedBashTool } from "./restricted-bash.js";
import { instrumentPipeline, hasPipeline } from "../infra/pipeline-status.js";
import type { BackgroundExecExecutor } from "../../core/tool-registry.js";

/**
 * PIPESTATUS instrumentation is a FOREGROUND mechanism, and the background path had it anyway.
 *
 * The foreground path strips the sentinel line before sanitizing and feeds the per-stage statuses to
 * `classifyExit`. The background writer does neither: it streams the child's stdout to a file that
 * `task_output` reads verbatim. So instrumenting a background pipeline put `__siclaw_pipe_status_…` into
 * the output the model reads — breaking any JSON in it — while a failed upstream stage still completed as
 * a success, which is the exact false empty-result the instrumentation exists to prevent.
 *
 * The check is on the command handed to the executor, because that is the observable contract between
 * this tool and the runtime.
 */

// The sentinel is module-private, so derive it from what the instrumenter actually emits rather than
// retyping it — a copy here would keep passing after the real one changed.
const SENTINEL = (() => {
  const m = /__siclaw_pipe_status_\w+__/.exec(instrumentPipeline("a | b"));
  if (!m) throw new Error("could not derive the sentinel from instrumentPipeline");
  return m[0];
})();

function capture() {
  const seen: string[] = [];
  const executor: BackgroundExecExecutor = vi.fn((opts: any) => {
    seen.push(String(opts?.command ?? opts?.file ?? ""));
    return { jobId: "j1", outputFile: "/tmp/out" };
  }) as never;
  return { seen, wiring: { executor, sessionIdRef: { current: "s1" } } };
}

async function launch(command: string) {
  const { seen, wiring } = capture();
  const tool = createRestrictedBashTool(undefined, wiring);
  const result = await tool.execute(
    "t1", { command, run_in_background: true },
    new AbortController().signal, {} as never,
  );
  return { seen, result };
}

// A background launch requires the LAST stage's sanitizer to be line-safe (a structural one cannot be
// streamed), so every command here ends in a stage with no sanitizer at all — `wc`, `sort`, `nproc`.
// A pipeline ending in `grep` or `head` is refused before the executor is reached, which is a different
// control and would make this test pass without proving anything.
describe("a background pipeline is not instrumented", () => {
  it("hands the executor the command as written", async () => {
    const { seen } = await launch("ps -ef | wc -l");
    expect(seen.length, "the executor was called").toBe(1);
    expect(seen[0], "no sentinel in the background command").not.toContain(SENTINEL);
    expect(seen[0], "no PIPESTATUS capture either").not.toContain("PIPESTATUS");
  });

  it("for every pipeline shape, including ones that would carry a status", async () => {
    for (const cmd of [
      "ps -ef | wc -l",
      "ps -ef | grep kubelet | wc -l",
      "ps -ef | grep -v root | grep kubelet | wc -l",
    ]) {
      const { seen } = await launch(cmd);
      expect(seen.length, `${cmd}: the executor was reached`).toBe(1);
      expect(seen[0], cmd).not.toContain(SENTINEL);
    }
  });

  it("and a non-pipeline background command is untouched, as before", async () => {
    const { seen } = await launch("nproc");
    expect(seen.length).toBe(1);
    expect(seen[0]).not.toContain(SENTINEL);
  });
});

describe("the foreground path still instruments", () => {
  // The counter-case: if this stopped happening, the per-stage classification would silently go away and
  // nothing else in the suite would notice, since its absence looks like a pipeline that simply succeeded.
  it("keeps the sentinel machinery for a foreground pipeline", () => {
    expect(hasPipeline("ps -ef | grep -c kubelet")).toBe(true);
    const wrapped = instrumentPipeline("ps -ef | grep -c kubelet");
    expect(wrapped).toContain(SENTINEL);
    expect(wrapped).toContain("PIPESTATUS");
  });
});
