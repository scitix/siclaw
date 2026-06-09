import { describe, it, expect } from "vitest";
import { backgroundLaunchedResult, backgroundNotLineSafeError } from "./background-launch.js";

describe("backgroundLaunchedResult message", () => {
  const msg = () => {
    const r = backgroundLaunchedResult("functions.node_exec:0", "/o/file.output", "Running on the node in the background.");
    return JSON.parse(r.content[0].text).message as string;
  };

  it("keeps the default: end the turn, don't poll/sleep/spawn-a-waiter", () => {
    const m = msg();
    expect(m).toMatch(/END YOUR TURN/);
    expect(m).toMatch(/do NOT read anything, poll, sleep, or spawn a sub-agent/i);
  });

  it("directs the model to task_output(task_id) rather than reading the raw output_file", () => {
    expect(msg()).toMatch(/task_output\(task_id\)/);
  });

  it("carries the paired server/client EXCEPTION (so a perftest server isn't waited on → no deadlock)", () => {
    const m = msg();
    expect(m).toMatch(/EXCEPTION/);
    expect(m).toMatch(/immediately run the counterpart/i);
    expect(m).toMatch(/deadlock/i);
    expect(m.toLowerCase()).toContain("client"); // the counterpart to run now
  });

  it("still hides the internal handles from the user", () => {
    expect(msg()).toMatch(/do NOT show them to the user/);
  });

  it("backgroundNotLineSafeError stays a blocked structural-redaction rejection", () => {
    const r = backgroundNotLineSafeError();
    expect((r.details as any).blocked).toBe(true);
    expect((r.details as any).reason).toBe("background_not_line_safe");
  });
});
