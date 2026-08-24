/**
 * These spawn real processes on purpose. The defect being fixed lives entirely in how signals and
 * pipe closure interact, and a mocked child reproduces neither: the unit test that would have
 * caught it is one that actually declines to die.
 *
 * The load-bearing case is "ignores SIGTERM". Restore `timeout` to the exec options and drop the
 * timer, and that test goes from rejecting in ~0.3s to RESOLVING at ~3s — a revert that leaves it
 * passing means the check is broken, not that the code is fine.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import {
  boundedExec, BoundedExecTimeout, BoundedExecFailure, BoundedExecOverflow, BoundedExecAborted,
} from "./bounded-exec.js";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

function has(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("boundedExec — ordinary outcomes", () => {
  it("resolves with stdout on success", async () => {
    const r = await boundedExec("echo hello", { env, timeoutMs: 5000 });
    expect(r.stdout.trim()).toBe("hello");
  });

  it("rejects on a non-zero exit, keeping whatever was written", async () => {
    const err = await boundedExec("echo partial; echo oops >&2; exit 3", { env, timeoutMs: 5000 })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecFailure);
    expect(err.code).toBe(3);
    expect(err.stdout).toContain("partial");
    expect(err.stderr).toContain("oops");
  });

  it("survives a multibyte character split across two stdout chunks", async () => {
    // 20k of CJK forces several data events; per-chunk decoding would yield U+FFFD at the seams.
    const r = await boundedExec("for i in $(seq 1 2000); do printf '排障耗时分析——'; done", {
      env, timeoutMs: 10000,
    });
    expect(r.stdout).not.toContain("�");
    expect(r.stdout.match(/排障耗时分析——/g)?.length).toBe(2000);
  });

  it("does not report a timeout for a command that finishes just inside the cap", async () => {
    const r = await boundedExec("printf done", { env, timeoutMs: 3000 });
    expect(r.stdout).toBe("done");
  });
});

describe("boundedExec — the cap actually bounds the call", () => {
  it("kills a command that IGNORES SIGTERM, instead of waiting it out", async () => {
    const started = Date.now();
    const err = await boundedExec("trap '' TERM; sleep 3; echo never", { env, timeoutMs: 300, graceMs: 200 })
      .then(() => null, (e) => e);
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(BoundedExecTimeout);
    expect(err.timedOut).toBe(true);
    // Node's exec `timeout` sends SIGTERM, which this command discards; the old code then waited for
    // `close` and settled at ~3s with a SUCCESS. SIGKILL to the group ends it at once.
    expect(elapsed).toBeLessThan(1500);
    expect(err.stdout).not.toContain("never");
  });

  it("reports the cap it applied, so the caller can widen it deliberately", async () => {
    const err = await boundedExec("trap '' TERM; sleep 3", { env, timeoutMs: 250, graceMs: 200 })
      .then(() => null, (e) => e);
    expect(err.timeoutMs).toBe(250);
  });

  it("keeps the output produced before the cap was hit", async () => {
    const err = await boundedExec("echo early; trap '' TERM; sleep 3", { env, timeoutMs: 400, graceMs: 200 })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecTimeout);
    expect(err.stdout).toContain("early");
  });

  it("kills the whole group, not just the direct child", async () => {
    // The shell exits immediately; a child holding stdout would keep `close` from firing. Killing
    // the group takes the child with it.
    const started = Date.now();
    const err = await boundedExec("sleep 3 & trap '' TERM; wait", { env, timeoutMs: 300, graceMs: 200 })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecTimeout);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("settles even when the survivor escaped the process group", async () => {
    // `setsid` puts the sleep in its OWN session, so `-pid` never reaches it and it goes on holding
    // the inherited stdout — exactly the shape `sudo` can produce. Only the grace bounds this.
    if (!has("setsid")) return; // absent on macOS; the guarantee is unchanged, just unobservable here
    const started = Date.now();
    const err = await boundedExec("setsid sleep 5 & trap '' TERM; wait", {
      env, timeoutMs: 300, graceMs: 250,
    }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecTimeout);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("an abort kills the command without waiting for the cap", async () => {
    const ac = new AbortController();
    const started = Date.now();
    const p = boundedExec("trap '' TERM; sleep 5", { env, timeoutMs: 60_000, signal: ac.signal, graceMs: 200 })
      .then(() => null, (e) => e);
    setTimeout(() => ac.abort(), 150);
    const err = await p;
    // The abort path relied on the same broken group kill and had the same never-settles hole:
    // before this it hung for the full 60s cap on a command that ignores SIGTERM.
    expect(Date.now() - started).toBeLessThan(1500);
    expect(err).toBeInstanceOf(BoundedExecFailure);
  });

  it("an already-aborted signal does not start a command that then runs to completion", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await boundedExec("trap '' TERM; sleep 5", { env, timeoutMs: 60_000, signal: ac.signal, graceMs: 200 })
      .then(() => null, (e) => e);
    expect(err).toBeTruthy();
  });
});

describe("boundedExec — the process group is real", () => {
  // This is the fact the whole fix rests on, and the one the previous code assumed without
  // checking: `exec` drops `detached`, so the child stayed in the AGENT's process group and
  // `-child.pid` was ESRCH on every call. spawn honours it. Asserted directly, because a
  // regression here silently turns the group kill back into a direct-child kill and the hang
  // returns — while every timeout test above still passes on the grace alone.
  it("puts the child in a group of its own, asked through the real code path", async () => {
    if (process.platform === "win32") return;
    // The shell reports its own pid and pgid. Group leader ⇒ they are equal, which is precisely what
    // `-child.pid` needs and what `exec` could never deliver. Asked through boundedExec so this
    // tests OUR spawn options rather than restating Node's documentation.
    const r = await boundedExec("echo $$; ps -o pgid= -p $$", { env, timeoutMs: 5000 });
    const [pid, pgid] = r.stdout.trim().split(/\s+/).map((s) => Number(s.trim()));
    expect(Number.isFinite(pid)).toBe(true);
    expect(pgid).toBe(pid);
  });

  it("kills a grandchild that inherited stdout, which is what unblocks `close`", async () => {
    const started = Date.now();
    const err = await boundedExec("sleep 4 & trap '' TERM; wait", { env, timeoutMs: 300, graceMs: 3000 })
      .then(() => null, (e) => e);
    // graceMs is deliberately LONGER than the assertion window: if the group kill fails and only
    // the grace settles this, the elapsed time crosses 1.5s and the test fails. So this asserts the
    // kill, not the backstop.
    expect(err).toBeInstanceOf(BoundedExecTimeout);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

// These shapes are the integration contract with classifyExit (exit-classification.ts), which
// reads `code` and `signal` to pick a class. Moving off `exec` stopped Node producing them, so they
// are asserted here: change one and the class silently becomes channel_error — "the target never ran
// the command" — over a command that ran and was killed, or over a truncated prefix that then reads
// as a complete result.
describe("boundedExec — error shapes classifyExit depends on", () => {
  it("a timeout arrives as code=null + signal=SIGKILL, which classifies as interrupted", async () => {
    const err = await boundedExec("trap '' TERM; sleep 3", { env, timeoutMs: 250, graceMs: 200 })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecTimeout);
    expect(err.code).toBeNull();
    expect(err.signal).toBe("SIGKILL");
    expect(err.timedOut).toBe(true);
  });

  it("an overflow arrives as ERR_CHILD_PROCESS_STDIO_MAXBUFFER, which classifies as output_truncated", async () => {
    const err = await boundedExec("yes abcdefghij", { env, timeoutMs: 10_000, maxBuffer: 32 * 1024, graceMs: 300 })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecOverflow);
    expect(err.code).toBe("ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    // The message is the second thing classifyExit matches on, so it must carry the phrase too.
    expect(err.message).toMatch(/maxBuffer length exceeded/i);
  });

  it("an ordinary non-zero exit keeps its numeric code, so it stays the target's own answer", async () => {
    const err = await boundedExec("exit 7", { env, timeoutMs: 5000 }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecFailure);
    expect(err.code).toBe(7);
    expect(err.timedOut).toBeUndefined();
    expect((err as any).aborted).toBeUndefined();
  });

  it("an abort is distinguishable from a timeout despite the identical code/signal pair", async () => {
    // Both are code=null + SIGKILL, which is all classifyExit looks at — so without a separate
    // marker a user Stop is described as "killed at the tool's timeout, raise timeout_seconds".
    const ac = new AbortController();
    const p = boundedExec("sleep 3", { env, timeoutMs: 60_000, signal: ac.signal, graceMs: 200 })
      .then(() => null, (e) => e);
    setTimeout(() => ac.abort(), 100);
    const err = await p;
    expect(err).toBeInstanceOf(BoundedExecAborted);
    expect(err.aborted).toBe(true);
    expect(err.timedOut).toBeUndefined();
    // Still the shape classifyExit needs, so nothing downstream has to special-case it to classify.
    expect(err.code).toBeNull();
    expect(err.signal).toBe("SIGKILL");
  });

  it("an already-aborted signal reports the same abort marker", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await boundedExec("echo hi", { env, timeoutMs: 5000, signal: ac.signal })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecAborted);
    expect(err.aborted).toBe(true);
  });
});

describe("boundedExec — output cap", () => {
  it("stops a command whose output passes the cap", async () => {
    const err = await boundedExec("yes abcdefghij", { env, timeoutMs: 10_000, maxBuffer: 64 * 1024, graceMs: 300 })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecOverflow);
    expect(err.maxBuffer).toBe(64 * 1024);
  });

  it("counts BYTES, not UTF-16 units, so CJK cannot run past the cap", async () => {
    // Each 排 is 3 bytes but 1 string unit. A `.length` cap would let ~3x through.
    const err = await boundedExec("while :; do printf '排排排排排排排排排排'; done", {
      env, timeoutMs: 10_000, maxBuffer: 30 * 1024, graceMs: 300,
    }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecOverflow);
    expect(Buffer.byteLength(err.stdout, "utf8")).toBeGreaterThan(30 * 1024);
    // Had the cap counted string units it would have taken ~3x the bytes to trip.
    expect(Buffer.byteLength(err.stdout, "utf8")).toBeLessThan(30 * 1024 * 2.5);
  });

  it("does not trip the cap on ordinary output", async () => {
    const r = await boundedExec("printf 'small'", { env, timeoutMs: 5000, maxBuffer: 1024 });
    expect(r.stdout).toBe("small");
  });

  it("reports a prefix bounded near the cap", async () => {
    const err = await boundedExec("yes abcdefghijklmnopqrstuvwxyz", {
      env, timeoutMs: 10_000, maxBuffer: 64 * 1024, graceMs: 1500,
    }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecOverflow);
    const captured = Buffer.byteLength(err.stdout, "utf8");
    expect(captured).toBeGreaterThan(64 * 1024);
    expect(captured).toBeLessThan(64 * 1024 + 1024 * 1024);
    // NOTE: this passes with or without the stop-collecting guard in bounded-exec.ts, because the
    // group kill lands before another chunk arrives. The guard only matters for a survivor that
    // outlives the kill, which needs `setsid` to reproduce — see the escaped-the-group case above.
    // Stated rather than left implied, so nobody reads this as covering the guard.
  });
});

// Review findings on this file, each with the case that produced them.
describe("boundedExec — the cap is per stream, as exec's was", () => {
  it("does not fail a command that stays under the cap on each stream separately", async () => {
    // exec's maxBuffer was "the most allowed on stdout OR stderr", tracked per stream. 6+6 against a
    // 10-unit cap passed then; one shared counter fails it.
    const half = 6 * 1024;
    const r = await boundedExec(
      `head -c ${half} /dev/zero | tr '\\0' a; head -c ${half} /dev/zero | tr '\\0' b >&2`,
      { env, timeoutMs: 10_000, maxBuffer: 10 * 1024, graceMs: 300 },
    );
    expect(Buffer.byteLength(r.stdout, "utf8")).toBe(half);
    expect(Buffer.byteLength(r.stderr, "utf8")).toBe(half);
  });

  it("still trips when ONE stream passes the cap", async () => {
    const err = await boundedExec("head -c 40000 /dev/zero | tr '\\0' a >&2", {
      env, timeoutMs: 10_000, maxBuffer: 8 * 1024, graceMs: 300,
    }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecOverflow);
  });
});

// Both cases here need a survivor that outlives the group kill, because that is the ONLY situation
// in which a second stop condition can arrive: when the kill lands, `close` fires within
// milliseconds and the call has already settled. `setsid` is what produces a survivor, so on a
// platform without it (macOS) these skip — the latch is then covered by reasoning and the reviewer's
// reproduction, not by a test that ran. Stated rather than left for someone to discover.
describe("boundedExec — the first stop condition wins", () => {
  it("a flood that starts AFTER the timeout neither extends the deadline nor changes the reason", async () => {
    if (!has("setsid")) return;
    // The survivor must stay quiet until the timeout has fired, or it is not the case being tested:
    // `yes` alone passes a 16 KiB cap within a millisecond or two, so the overflow legitimately
    // becomes the FIRST condition and Overflow is the correct answer — which is how the first
    // version of this test failed on Linux while skipping on macOS. The sleep puts the flood on the
    // far side of the 100ms timeout, so the ordering under test is really timeout-then-overflow.
    const started = Date.now();
    const err = await boundedExec(
      "setsid sh -c 'sleep 0.35; yes abcdefghij' & trap '' TERM; wait",
      { env, timeoutMs: 100, maxBuffer: 16 * 1024, graceMs: 400 },
    ).then(() => null, (e) => e);
    const elapsed = Date.now() - started;
    expect(err).toBeInstanceOf(BoundedExecTimeout);
    // 100 + 400 + slack. Re-arming on the flood pushed this to ~724ms in the reviewer's repro.
    expect(elapsed).toBeLessThan(700);
  });

  it("an abort arriving after the timeout does not change the reported reason", async () => {
    if (!has("setsid")) return;
    // This is the one that pins the LATCH specifically: an abort does not go through the output
    // path, so it reaches killAndBound and is refused there. In the flood case above the collect
    // guard stops counting first, so that test covers the pair of guards rather than the latch alone.
    const ac = new AbortController();
    const p = boundedExec("setsid sleep 5 & trap '' TERM; wait", {
      env, timeoutMs: 120, signal: ac.signal, graceMs: 500,
    }).then(() => null, (e) => e);
    setTimeout(() => ac.abort(), 250);
    const err = await p;
    expect(err).toBeInstanceOf(BoundedExecTimeout);
  });
});

describe("boundedExec — an already-aborted turn", () => {
  it("does not run the command at all", async () => {
    // The command would leave a trace if it ran. An abort that arrives before the call should not
    // start a kubectl just to kill it.
    const marker = `/tmp/bounded-exec-abort-${process.pid}-${Math.round(performance.now())}`;
    const ac = new AbortController();
    ac.abort();
    const err = await boundedExec(`touch ${marker}`, { env, timeoutMs: 5000, signal: ac.signal })
      .then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BoundedExecFailure);
    const { existsSync, rmSync } = await import("node:fs");
    const ran = existsSync(marker);
    if (ran) rmSync(marker, { force: true });
    expect(ran).toBe(false);
  });
});
