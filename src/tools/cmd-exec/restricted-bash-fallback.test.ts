/**
 * A background launch the executor DECLINES falls through and runs in the FOREGROUND.
 *
 * That makes the mode a per-path decision, not a per-call one. Deciding it once, up front, sent the
 * fallback out carrying the background command — no sandbox deadline, only the outer backstop, which
 * in production is padded by 15s to stay behind the inner one. A `timeout_seconds: 1` command then
 * stopped at about 16 seconds.
 *
 * Its own file because it mocks boundedExec: what the fallback hands to boundedExec is the whole
 * question, and nothing observable from outside the module answers it. An earlier version of this
 * test asserted on what the EXECUTOR received and on the builder's output instead, and passed with
 * the fix reverted — it was checking the two things that never changed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const boundedExecCalls: string[] = [];

vi.mock("./bounded-exec.js", () => ({
  boundedExec: (command: string) => {
    boundedExecCalls.push(command);
    // Resolve as an empty success: the command line is what is under test, not the run.
    return Promise.resolve({ stdout: "", stderr: "" });
  },
  BoundedExecTimeout: class extends Error { readonly timedOut = true; },
  BoundedExecFailure: class extends Error {},
  BoundedExecAborted: class extends Error { readonly aborted = true; },
  BoundedExecOverflow: class extends Error { readonly overflow = true; },
  TIMEOUT_KILL_GRACE_MS: 2000,
  DEFAULT_MAX_BUFFER: 1024 * 1024 * 10,
}));

const { createRestrictedBashTool } = await import("./restricted-bash.js");

describe("a declined background launch runs with the foreground deadline", () => {
  beforeEach(() => { boundedExecCalls.length = 0; });

  const inProduction = async (fn: () => Promise<void>) => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try { await fn(); } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  };

  it("gives the executor an uncapped command and boundedExec a capped one", async () => {
    await inProduction(async () => {
      const executorSaw: string[] = [];
      const tool = createRestrictedBashTool(undefined, {
        executor: (req: any) => {
          executorSaw.push(req.command);
          throw new Error("concurrency cap reached"); // decline → fall through to foreground
        },
        sessionIdRef: { current: "s" },
      } as any);

      await tool.execute("call-1", {
        command: "kubectl version",
        run_in_background: true,
        timeout_seconds: 1,
      });

      // The background attempt: stoppable, deliberately unbounded.
      expect(executorSaw).toHaveLength(1);
      expect(executorSaw[0]).toContain("setsid");
      expect(executorSaw[0]).not.toContain("timeout -k");

      // The fallback that actually ran: the deadline is back. This is the assertion that fails when
      // the mode is decided once instead of per path.
      expect(boundedExecCalls).toHaveLength(1);
      expect(boundedExecCalls[0]).toContain("timeout -k 5 1");
      expect(boundedExecCalls[0]).toContain("setsid");
    });
  });

  it("an ordinary foreground run is unaffected", async () => {
    await inProduction(async () => {
      const tool = createRestrictedBashTool(undefined, { sessionIdRef: { current: "s" } } as any);
      await tool.execute("call-2", { command: "kubectl version", timeout_seconds: 7 });
      expect(boundedExecCalls).toHaveLength(1);
      expect(boundedExecCalls[0]).toContain("timeout -k 5 7");
    });
  });

  it("outside production there is no wrapper, so the outer timer is the only deadline", async () => {
    const tool = createRestrictedBashTool(undefined, { sessionIdRef: { current: "s" } } as any);
    await tool.execute("call-3", { command: "kubectl version", timeout_seconds: 3 });
    expect(boundedExecCalls).toHaveLength(1);
    expect(boundedExecCalls[0]).not.toContain("sudo");
    expect(boundedExecCalls[0]).not.toContain("timeout -k");
  });
});
