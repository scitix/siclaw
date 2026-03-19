import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Queue of responses for the mock execFile. Each entry is either
 * { stdout, stderr } for success or an Error for failure.
 */
const responseQueue: Array<{ stdout: string; stderr: string } | Error> = [];

vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout?: string, stderr?: string) => void,
  ) => {
    const response = responseQueue.shift();
    if (!response) {
      cb(new Error("No mock response queued"));
      return;
    }
    if (response instanceof Error) {
      // Pass stderr from the error object if present (for testing stderr inspection)
      const stderr = "stderr" in response ? (response as Error & { stderr: string }).stderr : "";
      cb(response, "", stderr);
    } else {
      cb(null, response.stdout, response.stderr);
    }
  },
}));

const { compareVersions, checkSemgrepVersion, runSemgrep } = await import(
  "./semgrep-runner.js"
);

function loadFixtureRaw(): string {
  return readFileSync(
    join(__dirname, "__fixtures__", "semgrep-output.json"),
    "utf-8",
  );
}

beforeEach(() => {
  responseQueue.length = 0;
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(compareVersions("1.50.0", "1.50.0")).toBe(0);
  });

  it("returns positive when a > b", () => {
    expect(compareVersions("1.156.0", "1.50.0")).toBeGreaterThan(0);
  });

  it("returns negative when a < b", () => {
    expect(compareVersions("1.49.9", "1.50.0")).toBeLessThan(0);
  });

  it("handles major version difference", () => {
    expect(compareVersions("2.0.0", "1.156.0")).toBeGreaterThan(0);
  });

  it("handles different segment counts", () => {
    expect(compareVersions("1.50", "1.50.0")).toBe(0);
  });
});

describe("checkSemgrepVersion", () => {
  it("returns version on success", async () => {
    responseQueue.push({ stdout: "1.156.0\n", stderr: "" });
    const version = await checkSemgrepVersion();
    expect(version).toBe("1.156.0");
  });

  it("throws when version is below minimum", async () => {
    responseQueue.push({ stdout: "1.40.0\n", stderr: "" });
    await expect(checkSemgrepVersion()).rejects.toThrow("below minimum");
  });

  it("throws with install instructions when semgrep not found", async () => {
    const err = new Error("spawn semgrep ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    responseQueue.push(err);
    await expect(checkSemgrepVersion()).rejects.toThrow(
      "semgrep not found. Install with: pip install semgrep",
    );
  });
});

describe("runSemgrep", () => {
  it("returns ExtractionOutput with correct result count from fixture", async () => {
    const fixtureJson = loadFixtureRaw();
    // version check
    responseQueue.push({ stdout: "1.156.0\n", stderr: "" });
    // semgrep run
    responseQueue.push({ stdout: fixtureJson, stderr: "" });

    const result = await runSemgrep({
      rulePaths: ["rules/go/"],
      srcPath: "/tmp/src",
    });

    expect(result.results).toHaveLength(4);
    expect(result.errors).toHaveLength(0);
    expect(result.scannedFiles).toContain("pkg/controller/pod.go");

    const first = result.results[0]!;
    expect(first.ruleId).toBe("siclaw.go.klog-printf");
    expect(first.framework).toBe("klog");
    expect(first.level).toBe("error");
  });

  it("throws on semgrep timeout", async () => {
    responseQueue.push({ stdout: "1.156.0\n", stderr: "" });
    const err = new Error("timeout") as Error & { killed: boolean };
    err.killed = true;
    responseQueue.push(err);

    await expect(
      runSemgrep({ rulePaths: ["rules/go/"], srcPath: "/tmp/src", timeoutMs: 1000 }),
    ).rejects.toThrow("Semgrep timed out after 1000ms");
  });

  it("throws with stderr content on non-zero exit", async () => {
    responseQueue.push({ stdout: "1.156.0\n", stderr: "" });
    const err = new Error("exit code 2") as Error & { stderr: string };
    err.stderr = "Invalid rule syntax";
    responseQueue.push(err);

    await expect(
      runSemgrep({ rulePaths: ["rules/go/"], srcPath: "/tmp/src" }),
    ).rejects.toThrow("Semgrep failed: Invalid rule syntax");
  });
});
