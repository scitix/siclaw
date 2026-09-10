import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("siclaw executable dispatch", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-entrypoint-"));
    fs.copyFileSync(fileURLToPath(new URL("../siclaw.mjs", import.meta.url)), path.join(dir, "siclaw.mjs"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module", version: "test" }));
    fs.mkdirSync(path.join(dir, "dist"));
    for (const mode of ["main", "local", "agents"]) {
      fs.writeFileSync(path.join(dir, "dist", `cli-${mode}.js`),
        `console.log(JSON.stringify({ mode: ${JSON.stringify(mode)}, args: process.argv.slice(2) }));`);
    }
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  function run(args: string[]) {
    return spawnSync(process.execPath, [path.join(dir, "siclaw.mjs"), ...args], {
      cwd: dir, encoding: "utf8", timeout: 10_000,
    });
  }

  it.each([[], ["--help"], ["local", "--help"], ["agents", "--help"]].map(args => [args]))
    ("shows help without loading any runtime: %j", (args) => {
      const result = run(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Usage: siclaw");
      expect(result.stdout).not.toContain('"mode":');
      expect(fs.readdirSync(dir)).not.toContain(".siclaw");
    });

  it("starts the local Web runtime with its options intact", () => {
    const result = run(["local", "--open"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ mode: "local", args: ["--open"] });
  });

  it("routes agent listing without loading the diagnostic runtime", () => {
    expect(JSON.parse(run(["agents"]).stdout)).toEqual({ mode: "agents", args: [] });
  });

  it("does not interpret prompt contents as global help", () => {
    expect(JSON.parse(run(["--prompt", "--help"]).stdout))
      .toEqual({ mode: "main", args: ["--prompt", "--help"] });
  });

  it("prints the version without loading a runtime", () => {
    const result = run(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("test");
  });
});
