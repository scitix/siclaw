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

// Security contract: an empty embedding apiKey must only inherit the default
// LLM provider's key when the embedding endpoint is the SAME ORIGIN. A
// cross-origin endpoint (the self-hosted TEI case the env path enables) must
// NOT receive the LLM credential, otherwise a high-value key leaks to a
// different trust domain. See getEmbeddingConfig() in config.ts.
describe("getEmbeddingConfig — empty-key credential inheritance", () => {
  function writeSettings(settings: Record<string, unknown>): void {
    fs.writeFileSync(path.join(cfgDir, "settings.json"), JSON.stringify(settings));
  }

  const PROVIDER = {
    providers: {
      openai: {
        baseUrl: "https://llm.example.com/v1",
        apiKey: "sk-secret-llm-key",
        models: [{ id: "gpt-4o", name: "gpt-4o" }],
      },
    },
    default: { provider: "openai", modelId: "gpt-4o" },
  };

  it("does NOT inherit the LLM key for a cross-origin embedding endpoint", () => {
    writeSettings({
      ...PROVIDER,
      embedding: { baseUrl: "http://tei.svc/v1", apiKey: "", model: "", dimensions: 0 },
    });
    reloadConfig();
    expect(getEmbeddingConfig()?.apiKey).toBe("");
  });

  it("inherits the LLM key when the embedding endpoint is the same origin", () => {
    writeSettings({
      ...PROVIDER,
      embedding: { baseUrl: "https://llm.example.com/v1/embeddings", apiKey: "", model: "", dimensions: 0 },
    });
    reloadConfig();
    expect(getEmbeddingConfig()?.apiKey).toBe("sk-secret-llm-key");
  });

  it("uses an explicit embedding key regardless of origin", () => {
    writeSettings({
      ...PROVIDER,
      embedding: { baseUrl: "http://tei.svc/v1", apiKey: "emb-own-key", model: "", dimensions: 0 },
    });
    reloadConfig();
    expect(getEmbeddingConfig()?.apiKey).toBe("emb-own-key");
  });
});
