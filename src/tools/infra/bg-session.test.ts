import { describe, it, expect } from "vitest";
import { backgroundPgidFile, wrapBackgroundSession, backgroundSessionKillScript } from "./bg-session.js";

describe("bg-session", () => {
  it("builds a unique, sanitized pidfile path", () => {
    const a = backgroundPgidFile("functions.host_exec:0");
    const b = backgroundPgidFile("functions.host_exec:0");
    expect(a).toMatch(/^\/tmp\/siclaw-bg-functions_host_exec_0-[0-9a-f]{8}\.pgid$/);
    expect(a).not.toBe(b); // random suffix → no collision across jobs
  });

  it("wraps a command as a setsid session that records its session id and cleans up", () => {
    const wrapped = wrapBackgroundSession("timeout 600 sh -c 'do work'", "/tmp/x.pgid");
    expect(wrapped.startsWith("setsid -w sh -c ")).toBe(true);
    expect(wrapped).toContain("echo $$ > /tmp/x.pgid");   // record session id
    expect(wrapped).toContain("timeout 600 sh -c");        // inner command preserved
    expect(wrapped).toContain("rm -f /tmp/x.pgid");        // cleanup on normal exit
    // The inner single-quotes are escaped for the outer setsid `sh -c '…'` (one quoting level).
    expect(wrapped).toContain(`'\\''`);
  });

  it("kills by SESSION (pkill -s) with a process-group fallback", () => {
    const kill = backgroundSessionKillScript("/tmp/x.pgid");
    expect(kill).toContain("cat /tmp/x.pgid");
    expect(kill).toContain("pkill -TERM -s");
    expect(kill).toContain("pkill -KILL -s");
    expect(kill).toContain("kill -TERM -");  // group-kill fallback when pkill is absent
    expect(kill).toContain("rm -f /tmp/x.pgid");
  });
});
