import { describe, expect, it } from "vitest";
import { parseCliOptions } from "./cli-options.js";

describe("headless CLI arguments", () => {
  it("preserves prompt text and accepts explicit agent selection and session continuation", () => {
    expect(parseCliOptions(["--agent", "sre-oncall", "--continue", "--prompt", "Check recent events\nthen summarize", "--debug"]))
      .toEqual({ agent: "sre-oncall", prompt: "Check recent events\nthen summarize", continueSession: true, debug: true });
  });

  it("accepts --print for existing scripts", () => {
    expect(parseCliOptions(["--print", "--prompt", "check pods"]).prompt).toBe("check pods");
  });

  it.each([[], ["--continue"], ["--print"], ["--agent", "sre-oncall"]].map(args => [args]))
    ("requires a prompt instead of starting an interactive session: %j", (args) => {
      expect(() => parseCliOptions(args)).toThrow("requires --prompt");
    });

  it.each([
    ["--prompt"], ["--prompt", "   "], ["--prompt", "--continue"],
    ["--prompt", "check", "--agent"], ["--prompt", "check", "--prompt", "again"],
    ["--dp", "--prompt", "check"], ["unknown"],
  ].map(args => [args]))("rejects invalid invocations: %j", (args) => {
    expect(() => parseCliOptions(args)).toThrow();
  });
});
