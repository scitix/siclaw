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
  it("loads and normalizes the single-key form as the default alias", () => {
    expect(loadConfig(baseEnv())).toEqual({
      baseUrl: "https://sicore.example.com",
      keys: [{ alias: "default", apiKey: "test-key", agentId: "agent-1" }],
      requestTimeoutMs: 30_000,
      pollIntervalMs: 3_000,
    });
  });

  it("treats SICLAW_AGENT_ID as optional for key self-resolution", () => {
    expect(loadConfig(baseEnv({ SICLAW_AGENT_ID: undefined })).keys).toEqual([
      { alias: "default", apiKey: "test-key", agentId: undefined },
    ]);
  });

  it("parses SICLAW_A2A_KEYS into named keys in declaration order", () => {
    const env = baseEnv({
      SICLAW_A2A_KEY: undefined,
      SICLAW_AGENT_ID: undefined,
      SICLAW_A2A_KEYS: '{"sre":"sk-a","kb":"sk-b"}',
    });
    expect(loadConfig(env).keys).toEqual([
      { alias: "sre", apiKey: "sk-a" },
      { alias: "kb", apiKey: "sk-b" },
    ]);
  });

  it("merges the single key as default alongside named keys", () => {
    const env = baseEnv({
      SICLAW_AGENT_ID: undefined,
      SICLAW_A2A_KEYS: '{"kb":"sk-b"}',
    });
    expect(loadConfig(env).keys).toEqual([
      { alias: "default", apiKey: "test-key", agentId: undefined },
      { alias: "kb", apiKey: "sk-b" },
    ]);
  });

  it("rejects a named alias colliding with the single-key default", () => {
    const env = baseEnv({
      SICLAW_AGENT_ID: undefined,
      SICLAW_A2A_KEYS: '{"default":"sk-b"}',
    });
    expect(() => loadConfig(env)).toThrow(/collides with the single-key/);
  });

  it("rejects invalid alias names", () => {
    const env = baseEnv({
      SICLAW_A2A_KEY: undefined,
      SICLAW_AGENT_ID: undefined,
      SICLAW_A2A_KEYS: '{"SRE":"sk-a"}',
    });
    expect(() => loadConfig(env)).toThrow(/is invalid/);
  });

  it("rejects SICLAW_AGENT_ID combined with SICLAW_A2A_KEYS", () => {
    const env = baseEnv({
      SICLAW_A2A_KEY: undefined,
      SICLAW_A2A_KEYS: '{"sre":"sk-a"}',
    });
    expect(() => loadConfig(env)).toThrow(/cannot be combined with SICLAW_A2A_KEYS/);
  });

  it("rejects malformed SICLAW_A2A_KEYS JSON without echoing values", () => {
    const env = baseEnv({
      SICLAW_A2A_KEY: undefined,
      SICLAW_AGENT_ID: undefined,
      SICLAW_A2A_KEYS: "not-json",
    });
    expect(() => loadConfig(env)).toThrow(/must be a JSON object/);
  });

  it("rejects a non-string key value without echoing it", () => {
    const env = baseEnv({
      SICLAW_A2A_KEY: undefined,
      SICLAW_AGENT_ID: undefined,
      SICLAW_A2A_KEYS: '{"sre":123}',
    });
    try {
      loadConfig(env);
      throw new Error("expected ConfigError");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain("sre");
      expect((error as Error).message).not.toContain("123");
    }
  });

  it("requires at least one key", () => {
    const env = baseEnv({ SICLAW_A2A_KEY: undefined, SICLAW_AGENT_ID: undefined });
    expect(() => loadConfig(env)).toThrow(/at least one key/);
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
    const env = baseEnv({ SICLAW_A2A_KEY: undefined, SICLAW_AGENT_ID: undefined, SICLAW_A2A_KEY_FILE: keyFile });
    expect(loadConfig(env).keys).toEqual([{ alias: "default", apiKey: "file-key", agentId: undefined }]);
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
