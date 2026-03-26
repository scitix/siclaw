import { describe, it, expect } from "vitest";
import { stdinExecCmd } from "./exec-utils.js";

describe("stdinExecCmd", () => {
  it("generates correct bash stdin command without args", () => {
    expect(stdinExecCmd("bash")).toBe("bash -s");
  });

  it("generates correct bash stdin command with args", () => {
    expect(stdinExecCmd("bash", "--flag value")).toBe("bash -s -- --flag value");
  });

  it("generates correct python3 stdin command without args", () => {
    // python3 uses `-` (dash) to read from stdin, NOT `-s` (which means no site-packages)
    expect(stdinExecCmd("python3")).toBe("python3 -");
  });

  it("generates correct python3 stdin command with args", () => {
    expect(stdinExecCmd("python3", "--node worker-1")).toBe("python3 - --node worker-1");
  });

  it("python3 command does NOT contain -s flag", () => {
    const cmd = stdinExecCmd("python3", "arg1");
    expect(cmd).not.toContain("-s");
  });
});
