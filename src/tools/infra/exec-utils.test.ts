import { describe, it, expect } from "vitest";
import { filterPodNoise, stdinExecCmd, prepareExecEnv, spawnAsync } from "./exec-utils.js";

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

describe("the child environment does not point at the credential tree", () => {
  // Regression guard for a pointer, not a secret: `SICLAW_CREDENTIALS_DIR` used to be injected into
  // every child env AND allowed through sanitizeEnv, so an expansion payload needed no knowledge of
  // the layout. Nothing in a child ever read it; the only reader is core/config.ts in the main process.
  it("omits SICLAW_CREDENTIALS_DIR even when a credentials dir is configured", () => {
    const env = prepareExecEnv({ credentialsDir: "/app/.siclaw/credentials" } as never, null);
    expect(env.childEnv).not.toHaveProperty("SICLAW_CREDENTIALS_DIR");
    // The things a child legitimately needs are still there.
    expect(env.childEnv).toHaveProperty("KUBECONFIG");
  });
});

describe("the output cap and the UTF-8 decode fix have to coexist", () => {
  // These arrived from opposite directions and conflicted in a rebase: main added
  // `setEncoding("utf8")` so a multi-byte character split across two data events stops becoming two
  // U+FFFD, and this branch added a ceiling so an unbounded read stops reading as a complete answer.
  //
  // Combining them naively reintroduces the first bug at the cut instead of at a chunk boundary: with
  // decoding on the stream the chunks are STRINGS, so slicing at the cap can end on a lone surrogate —
  // half an emoji. Hence the explicit trim, and hence this test.
  it("keeps multi-byte output intact below the cap", async () => {
    const text = "中".repeat(200_000) + "🎉";
    const r = await spawnAsync("/bin/bash", ["-c", `printf '%s' '${text}'`], 30_000);
    expect((r.stdout.match(/中/g) ?? []).length).toBe(200_000);
    expect(r.stdout, "no replacement characters at any chunk boundary").not.toContain("�");
    expect(r.truncated).toBeFalsy();
  });

  it("reports truncation and never cuts a character in half", async () => {
    const r = await spawnAsync("/bin/bash", ["-c", "yes ABCDEFGHIJ | head -c 20000000"], 60_000);
    expect(r.truncated, "the caller must be told this is a prefix").toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1024 * 1024 * 10);
    expect(/[\uD800-\uDBFF]$/.test(r.stdout), "the cut is not half a character").toBe(false);
  });
});
