import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import test from "node:test";
import {
  normalizedRules,
  resolveExisting,
  resolveWriteTarget,
  type InitCommand,
} from "./main.js";

interface RunnerHandle {
  send(value: unknown): void;
  next(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

function startRunner(): RunnerHandle {
  const child = spawn(process.execPath, [new URL("./main.js", import.meta.url).pathname], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const queue: Array<Record<string, unknown>> = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  lines.on("line", (line) => {
    const value = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(value);
    else queue.push(value);
  });
  return {
    send(value) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
    },
    next() {
      const value = queue.shift();
      if (value) return Promise.resolve(value);
      return new Promise((resolve) => waiters.push(resolve));
    },
    async close() {
      if (child.exitCode === null) {
        child.stdin.write('{"type":"close"}\n');
      }
      await new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.once("error", reject);
      });
    },
  };
}

test("initializes Pi 0.82.1 with bundled Kimi K3 without a network call", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "kbc-pi-runner-"));
  const runner = startRunner();
  try {
    runner.send({
      type: "init",
      cwd,
      sessionId: "test-session",
      systemPrompt: "Test only.",
      provider: "moonshotai",
      model: "kimi-k3",
      apiKey: "unit-test-secret",
      thinkingLevel: "max",
      maxToolCalls: 5,
      readOnly: true,
      allowedReadRoots: [cwd],
      filesystemAccess: {},
      fileTools: ["Read", "Glob", "Grep"],
      tools: [],
    });
    const ready = await runner.next();
    assert.equal(ready.type, "ready");
    assert.equal(ready.provider, "moonshotai");
    assert.equal(ready.model, "kimi-k3");
    assert.equal(ready.thinkingLevel, "max");
    assert.deepEqual(ready.tools, ["Read", "Glob", "Grep"]);
  } finally {
    await runner.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("fatal initialization errors do not expose the API key", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "kbc-pi-runner-"));
  const runner = startRunner();
  const secret = "unit-test-secret-value";
  try {
    runner.send({
      type: "init",
      cwd,
      sessionId: "test-session",
      systemPrompt: "Test only.",
      provider: "moonshotai",
      model: "not-a-real-model",
      apiKey: secret,
      thinkingLevel: "high",
      maxToolCalls: 5,
      readOnly: true,
      allowedReadRoots: [cwd],
      filesystemAccess: {},
      fileTools: [],
      tools: [],
    });
    const fatal = await runner.next();
    assert.equal(fatal.type, "fatal");
    assert.equal(JSON.stringify(fatal).includes(secret), false);
  } finally {
    await runner.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("filesystem boundary keeps raw read-only and confines nested writes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "kbc-pi-files-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "kbc-pi-outside-"));
  try {
    await mkdir(path.join(cwd, "raw"), { recursive: true });
    await writeFile(path.join(cwd, "raw", "source.md"), "frozen", "utf8");
    await writeFile(path.join(outside, "secret.md"), "secret", "utf8");
    await symlink(path.join(outside, "secret.md"), path.join(cwd, "linked-secret.md"));
    const config: InitCommand = {
      type: "init",
      cwd,
      sessionId: "filesystem-test",
      systemPrompt: "Test only.",
      provider: "moonshotai",
      model: "kimi-k3",
      apiKey: "unit-test-secret",
      thinkingLevel: "high",
      maxToolCalls: 5,
      readOnly: false,
      allowedReadRoots: [],
      filesystemAccess: {},
      fileTools: [],
      tools: [],
    };
    const rules = normalizedRules(config);

    assert.equal(
      await resolveExisting("raw/source.md", cwd, rules, "read"),
      await realpath(path.join(cwd, "raw", "source.md")),
    );
    await assert.rejects(
      resolveWriteTarget("raw/source.md", cwd, rules),
      /write denied/u,
    );
    await assert.rejects(
      resolveExisting("linked-secret.md", cwd, rules, "read"),
      /symbolic links/u,
    );

    const nested = await resolveWriteTarget("candidates/a/result.md", cwd, rules);
    assert.equal(nested, path.join(await realpath(cwd), "candidates", "a", "result.md"));
    await writeFile(nested, "candidate", "utf8");
    assert.equal(
      await resolveExisting("candidates/a/result.md", cwd, rules, "write"),
      nested,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
