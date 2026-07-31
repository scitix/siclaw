import { describe, it, expect } from "vitest";
import { SessionTurnLocks, SessionBusyError } from "./session-turn-lock.js";

/**
 * The property: two turns for one session never overlap. Everything else here exists so
 * that property cannot be defeated by an error path or by queue ordering.
 */

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SessionTurnLocks", () => {
  it("serialises two turns for the same session", async () => {
    const locks = new SessionTurnLocks();
    let active = 0, maxActive = 0;
    const turn = () => locks.run("s1", async () => {
      active++; maxActive = Math.max(maxActive, active);
      await tick(30);
      active--;
    });
    await Promise.all([turn(), turn(), turn()]);
    expect(maxActive).toBe(1);
  });

  it("lets different sessions run at the same time", async () => {
    const locks = new SessionTurnLocks();
    let active = 0, maxActive = 0;
    const turn = (id: string) => locks.run(id, async () => {
      active++; maxActive = Math.max(maxActive, active);
      await tick(30);
      active--;
    });
    await Promise.all([turn("a"), turn("b"), turn("c")]);
    expect(maxActive).toBe(3);
  });

  it("releases when the turn throws, rather than wedging the session forever", async () => {
    const locks = new SessionTurnLocks();
    await expect(locks.run("s1", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(locks.isBusy("s1")).toBe(false);
    await expect(locks.run("s1", async () => "ok")).resolves.toBe("ok");
  });

  it("gives up with a 409-shaped error when the wait runs out", async () => {
    // Callers key on status 409 / "already running" — the Lark path queues on exactly that
    // rather than showing the user an error, so the shape has to match what a box returns.
    const locks = new SessionTurnLocks();
    const held = locks.run("s1", () => tick(200));
    await tick(10);
    const err = await locks.run("s1", async () => "never", 30).catch((e) => e);
    expect(err).toBeInstanceOf(SessionBusyError);
    expect(err.status).toBe(409);
    expect(String(err.message)).toMatch(/already running/i);
    await held;
  });

  it("hands the lock to the longest waiter, not to whoever asks next", async () => {
    const locks = new SessionTurnLocks();
    const order: string[] = [];
    const held = locks.run("s1", () => tick(60));
    await tick(5);
    const first = locks.run("s1", async () => { order.push("first"); });
    await tick(5);
    const second = locks.run("s1", async () => { order.push("second"); });
    await Promise.all([held, first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("reports where the in-flight turn is running, so a busy send can steer into it", async () => {
    // This is what lets a rejected second send reach the box ACTUALLY running the turn
    // instead of failing: the message rides the running turn as a steer.
    const locks = new SessionTurnLocks();
    const held = locks.run("s1", async () => {
      locks.noteBox("s1", "agentbox-a-1", "https://10.0.0.5:3000");
      expect(locks.busyOn("s1")).toEqual({ boxId: "agentbox-a-1", endpoint: "https://10.0.0.5:3000" });
      await tick(20);
    });
    await held;
    // Dropped the moment the turn ends, so it can never become a stale binding.
    expect(locks.busyOn("s1")).toBeUndefined();
    expect(locks.isBusy("s1")).toBe(false);
  });

  it("reports nothing while a turn is queued but not yet dispatched", async () => {
    // A waiter has not chosen a box yet; a steer target must never be guessed.
    const locks = new SessionTurnLocks();
    const held = locks.run("s1", async () => { locks.noteBox("s1", "a", "https://x:3000"); await tick(60); });
    await tick(10);
    const queued = locks.run("s1", async () => "second");
    await held;
    expect(locks.busyOn("s1")).toBeUndefined(); // handed over, not yet dispatched
    await queued;
  });

  it("does not leak an entry once the queue drains", async () => {
    const locks = new SessionTurnLocks();
    await Promise.all([
      locks.run("s1", () => tick(10)),
      locks.run("s1", () => tick(10)),
    ]);
    expect(locks.isBusy("s1")).toBe(false);
  });
});
