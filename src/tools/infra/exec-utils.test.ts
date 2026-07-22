import { describe, it, expect } from "vitest";
import { filterPodNoise, stdinExecCmd } from "./exec-utils.js";

describe("filterPodNoise", () => {
  it("removes kubectl exec SPDY stream diagnostics but preserves the real error", () => {
    const noisy = [
      "I0722 15:03:20.306993   65357 log.go:244] (0x46) Create stream",
      "I0722 15:03:20.355662   65357 log.go:244] Reply frame received for 1",
      "error: executable file not found in $PATH",
    ].join("\n");

    expect(filterPodNoise(noisy)).toBe(
      "error: executable file not found in $PATH",
    );
  });

  it("keeps ordinary command stderr", () => {
    expect(filterPodNoise("permission denied\ncommand failed")).toBe("permission denied\ncommand failed");
  });
});

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
