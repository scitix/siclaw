import { describe, expect, it } from "vitest";
import { BackgroundWorkTurn, backgroundWorkResultPrompt, decorateBackgroundWorkEvent } from "./background-work-turn.js";

describe("required subagent completion mailbox", () => {
  it("delivers a client result while its long-lived server remains running", async () => {
    const turn = new BackgroundWorkTurn();
    turn.register("server"); turn.register("client");
    const waiting = turn.next();
    turn.complete({ taskId: "client", status: "completed", outputFile: "/tmp/client", summary: "client finished" });
    expect((await waiting).map(n => n.taskId)).toEqual(["client"]);
    expect(turn.pending).toBe(true);
    expect(turn.resultPrompt([])).toContain('"pendingJobIds":["server"]');
    const stopped = turn.next();
    turn.complete({ taskId: "server", status: "stopped", summary: "helper stopped" });
    expect((await stopped)[0].status).toBe("stopped");
    expect(turn.pending).toBe(false);
    expect(turn.complete({ taskId: "client", status: "completed", summary: "duplicate" })).toBe(true);
    expect(await turn.next()).toEqual([]);
  });

  it("wakes on real user input during a job wait, without consuming ready results", async () => {
    const turn = new BackgroundWorkTurn();
    expect(turn.queueSteer("active-model input")).toBe(false);
    turn.register("job");
    const waiting = turn.next();
    expect(turn.queueSteer("stop the server and summarize")).toBe(true);
    turn.complete({ taskId: "job", status: "completed", summary: "ready" });
    expect(await waiting).toEqual([]);
    expect(turn.takeSteer()?.text).toBe("stop the server and summarize");
    expect((await turn.next())[0].taskId).toBe("job");
  });

  it("rolls back a launch failure instead of keeping the request waiting", async () => {
    const turn = new BackgroundWorkTurn();
    turn.register("failed-launch");
    const waiting = turn.next();
    turn.unregister("failed-launch");
    expect(await waiting).toEqual([]);
    expect(turn.jobIds).toEqual([]);
  });

  it("handles completion before waiting and children launched during synthesis", async () => {
    const turn = new BackgroundWorkTurn();
    turn.register("group");
    turn.complete({ taskId: "group", status: "done", summary: "reduce report" });
    expect(backgroundWorkResultPrompt(await turn.next())).toContain("reduce report");
    turn.register("followup");
    expect(turn.pending).toBe(true);
    turn.complete({ taskId: "followup", status: "timed_out", summary: "timeout" });
    expect((await turn.next())[0].status).toBe("timed_out");
  });

  it("marks only server-authored result echoes as internal", () => {
    const turn = new BackgroundWorkTurn();
    const text = turn.resultPrompt([{ taskId: "a", status: "done", summary: "ready" }]);
    const echo = decorateBackgroundWorkEvent({ message: { role: "user", content: [{ type: "text", text }] } }, turn);
    expect(echo).toHaveProperty("internalMessage", true);
    expect(decorateBackgroundWorkEvent({ message: { role: "user", content: "also check node B" } }, turn)).not.toHaveProperty("internalMessage");
  });

  it("Stop wakes the waiter and late owned results never schedule a detached reply", async () => {
    const turn = new BackgroundWorkTurn();
    turn.register("a");
    const waiting = turn.next();
    turn.cancel();
    expect(await waiting).toEqual([]);
    expect(turn.complete({ taskId: "a", status: "done", summary: "late" })).toBe(true);
    expect(turn.complete({ taskId: "another-turn", status: "done", summary: "other" })).toBe(false);
    expect(turn.pending).toBe(false);
  });
});
