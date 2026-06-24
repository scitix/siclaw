import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reloadConfig, getEmbeddingConfig } from "./config.js";

// Infrastructure env overrides for the embedding endpoint (K8s/AgentBox path,
// where there is no settings.json `embedding` section). See config.ts.
const EMB_ENV = [
  "SICLAW_EMBEDDING_BASE_URL",
  "SICLAW_EMBEDDING_MODEL",
  "SICLAW_EMBEDDING_DIMENSIONS",
  "SICLAW_EMBEDDING_API_KEY",
] as const;

const saved: Record<string, string | undefined> = {};
const savedConfigDir = process.env.SICLAW_CONFIG_DIR;
let cfgDir: string;

beforeEach(() => {
  for (const k of EMB_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Point at an empty dir so loadConfig() has no settings.json `embedding` to
  // merge — isolates the env-override behaviour under test.
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-cfg-"));
  process.env.SICLAW_CONFIG_DIR = cfgDir;
  reloadConfig();
});

afterEach(() => {
  for (const k of EMB_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
  if (savedConfigDir === undefined) delete process.env.SICLAW_CONFIG_DIR;
  else process.env.SICLAW_CONFIG_DIR = savedConfigDir;
  fs.rmSync(cfgDir, { recursive: true, force: true });
  reloadConfig();
});

describe("getEmbeddingConfig — SICLAW_EMBEDDING_* env overrides", () => {
  it("returns null when no embedding env and no settings.json", () => {
    reloadConfig();
    expect(getEmbeddingConfig()).toBeNull();
  });

  it("builds config from env (baseUrl + model + dimensions)", () => {
    process.env.SICLAW_EMBEDDING_BASE_URL = "http://tei.svc/v1";
    process.env.SICLAW_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-4B";
    process.env.SICLAW_EMBEDDING_DIMENSIONS = "2560";
    reloadConfig();
    expect(getEmbeddingConfig()).toEqual({
      baseUrl: "http://tei.svc/v1",
      apiKey: "",
      model: "Qwen/Qwen3-Embedding-4B",
      dimensions: 2560,
    });
  });

  it("applies defaults (bge-m3 / 1024) when only baseUrl is set", () => {
    process.env.SICLAW_EMBEDDING_BASE_URL = "http://tei.svc/v1";
    reloadConfig();
    expect(getEmbeddingConfig()).toEqual({
      baseUrl: "http://tei.svc/v1",
      apiKey: "",
      model: "BAAI/bge-m3",
      dimensions: 1024,
    });
  });

  it("ignores a non-numeric dimensions value and falls back to default", () => {
    process.env.SICLAW_EMBEDDING_BASE_URL = "http://tei.svc/v1";
    process.env.SICLAW_EMBEDDING_DIMENSIONS = "not-a-number";
    reloadConfig();
    expect(getEmbeddingConfig()?.dimensions).toBe(1024);
  });

  it("still returns null when only model/dimensions set but baseUrl is empty", () => {
    // Without a baseUrl the embedding API cannot be called → FTS-only fallback.
    process.env.SICLAW_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-4B";
    process.env.SICLAW_EMBEDDING_DIMENSIONS = "2560";
    reloadConfig();
    expect(getEmbeddingConfig()).toBeNull();
  });
});
