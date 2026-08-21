import { describe, it, expect, vi } from "vitest";

/**
 * A capture ceiling only means something if it survives the trip back.
 *
 * `spawnAsync` sets `truncated` when the output hit the cap, and node_exec turns it into a note telling
 * the model that a search over the text proves nothing. Between them, `runInDebugPod` rebuilt its own
 * result object from `stdout`/`stderr` and dropped the flag — so a 10 MB-capped read that exited 0 was
 * reported as a complete success, which is the same false "nothing matched" the exit classes exist to
 * remove. The kill signal was dropped one layer earlier, in `spawnAsync`'s own `close` handler, so
 * `classifyExit`'s "SIGKILL means our timeout" branch could never fire.
 */

vi.mock("../infra/k8s-checks.js", () => ({ checkNodeReady: vi.fn(async () => null) }));

const runInDebugPod = vi.fn();
vi.mock("../infra/debug-pod.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/debug-pod.js")>("../infra/debug-pod.js");
  return {
    ...actual,
    runInDebugPod: (...a: unknown[]) => runInDebugPod(...a),
    ensureDebugPodReady: vi.fn(async () => undefined),
    acquireDebugPod: vi.fn(() => "node-debug-x"),
    releaseDebugPod: vi.fn(),
  };
});

const { createNodeExecTool } = await import("./node-exec.js");

async function run(result: Record<string, unknown>) {
  runInDebugPod.mockResolvedValueOnce(result);
  const tool = createNodeExecTool(undefined, "u1");
  const out = await tool.execute(
    "t1", { node: "node-1", command: "cat /var/log/syslog" },
    new AbortController().signal, {} as never,
  );
  return String((out.content as Array<{ text: string }>)[0]?.text ?? "");
}

describe("a truncated read says so, even when it exited cleanly", () => {
  it("carries the ceiling note when the command succeeded", async () => {
    const text = await run({ stdout: "line1\nline2", stderr: "", exitCode: 0, truncated: true });
    expect(text).toContain("output_truncated");
    // The note has to say what to DO — retrying the same command produces the same prefix.
    expect(text.toLowerCase()).toContain("narrow");
  });

  it("and does not claim truncation when the read was complete", async () => {
    const text = await run({ stdout: "line1\nline2", stderr: "", exitCode: 0 });
    expect(text).not.toContain("output_truncated");
  });

  it("carries it on a failed command too — the prefix is most misleading there", async () => {
    const text = await run({ stdout: "partial", stderr: "boom", exitCode: 1, truncated: true });
    expect(text).toContain("output_truncated");
  });
});

describe("a timeout kill is attributed to us, not to the target", () => {
  it("reads the signal that killed the child", async () => {
    const text = await run({ stdout: "", stderr: "", exitCode: null, signal: "SIGKILL" });
    // Whatever the class is worded as, it must not read as the target answering — that is the
    // misattribution the leg/class split exists to prevent.
    expect(text).not.toContain("target_reported_failure");
    expect(text).toMatch(/timeout|timed out|killed/i);
  });

  it("treats the signal-less timeout the same way", async () => {
    // `runInDebugPod` reports this shape when kubectl exits with a null code and no stderr: the same
    // event, observed without a signal.
    const text = await run({ stdout: "", stderr: "", exitCode: null, timedOut: true });
    expect(text).toMatch(/timeout|timed out|killed/i);
  });
});
