import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SICORE_URL: "https://sicore.example.com/",
    SICLAW_AGENT_ID: "agent-1",
    SICLAW_A2A_KEY: "test-key",
    ...extra,
  };
}

describe("loadConfig", () => {
  it("loads and normalizes environment configuration", () => {
    expect(loadConfig(baseEnv())).toEqual({
      baseUrl: "https://sicore.example.com",
      agentId: "agent-1",
      apiKey: "test-key",
      requestTimeoutMs: 30_000,
      pollIntervalMs: 3_000,
    });
  });

  it("treats SICLAW_AGENT_ID as optional for key self-resolution", () => {
    expect(loadConfig(baseEnv({ SICLAW_AGENT_ID: undefined })).agentId).toBeUndefined();
  });

  it("allows HTTP only for loopback testing", () => {
    expect(loadConfig(baseEnv({ SICORE_URL: "http://127.0.0.1:3000" })).baseUrl)
      .toBe("http://127.0.0.1:3000");
    expect(() => loadConfig(baseEnv({ SICORE_URL: "http://sicore.example.com" })))
      .toThrow(/must use HTTPS/);
  });

  it("reads a private key file without persisting it in config", () => {
    const dir = mkdtempSync(join(tmpdir(), "sicore-a2a-config-"));
    tempDirs.push(dir);
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "file-key\n", { mode: 0o600 });
    chmodSync(keyFile, 0o600);
    const env = baseEnv({ SICLAW_A2A_KEY: undefined, SICLAW_A2A_KEY_FILE: keyFile });
    expect(loadConfig(env).apiKey).toBe("file-key");
  });

  it.runIf(process.platform !== "win32")("rejects a group-readable key file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sicore-a2a-config-"));
    tempDirs.push(dir);
    const keyFile = join(dir, "key");
    writeFileSync(keyFile, "file-key\n", { mode: 0o644 });
    chmodSync(keyFile, 0o644);
    expect(() => loadConfig(baseEnv({ SICLAW_A2A_KEY: undefined, SICLAW_A2A_KEY_FILE: keyFile })))
      .toThrow(/chmod 600/);
  });

  it("rejects ambiguous key sources", () => {
    expect(() => loadConfig(baseEnv({ SICLAW_A2A_KEY_FILE: "/tmp/key" })))
      .toThrow(ConfigError);
  });
});
