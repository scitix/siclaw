/**
 * Model Config Repository Tests
 *
 * Tests updateModel() and the model-change detection logic used by
 * http-server to decide when to re-apply setModel to pi-agent.
 */

import { describe, it, expect, beforeEach } from "vitest";
import initSqlJs from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as schema from "../schema-sqlite.js";
import { ModelConfigRepository } from "./model-config-repo.js";

// ── Test DB Setup ──

async function createTestDb() {
  const SQL = await initSqlJs();
  const sqlJsDb = new SQL.Database();
  sqlJsDb.run("PRAGMA foreign_keys = ON");

  sqlJsDb.run(`CREATE TABLE model_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT,
    api_key TEXT,
    api TEXT NOT NULL DEFAULT 'openai-completions',
    auth_header INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  sqlJsDb.run(`CREATE TABLE model_entries (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    name TEXT NOT NULL,
    reasoning INTEGER NOT NULL DEFAULT 0,
    input_json TEXT,
    cost_json TEXT,
    context_window INTEGER NOT NULL DEFAULT 128000,
    max_tokens INTEGER NOT NULL DEFAULT 65536,
    compat_json TEXT,
    category TEXT NOT NULL DEFAULT 'llm',
    is_default INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE UNIQUE INDEX uk_provider_model ON model_entries(provider_id, model_id)`);

  sqlJsDb.run(`CREATE TABLE embedding_config (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL DEFAULT 1024,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  const db = drizzle(sqlJsDb, { schema }) as any;
  return db;
}

const TEST_PROVIDER = "test-provider";

async function seedProvider(repo: ModelConfigRepository) {
  // Insert a provider directly since addProvider isn't what we're testing
  const db = (repo as any).db;
  await db.insert(schema.modelProviders).values({
    id: "prov-1",
    name: TEST_PROVIDER,
    baseUrl: "https://api.test.com",
    apiKey: "sk-test",
    api: "openai-completions",
  });
}

async function seedModel(repo: ModelConfigRepository, overrides?: Partial<{ reasoning: boolean; contextWindow: number; maxTokens: number }>) {
  return repo.addModel(TEST_PROVIDER, {
    id: "gpt-4o",
    name: "GPT-4o",
    reasoning: overrides?.reasoning ?? false,
    contextWindow: overrides?.contextWindow ?? 128000,
    maxTokens: overrides?.maxTokens ?? 16384,
  });
}

// ── Tests ──

describe("ModelConfigRepository.updateModel", () => {
  let repo: ModelConfigRepository;

  beforeEach(async () => {
    const db = await createTestDb();
    repo = new ModelConfigRepository(db);
    await seedProvider(repo);
  });

  it("updates reasoning flag", async () => {
    await seedModel(repo, { reasoning: false });

    await repo.updateModel(TEST_PROVIDER, "gpt-4o", { reasoning: true });

    const provider = await repo.getProviderWithModels(TEST_PROVIDER);
    const model = provider!.models.find(m => m.id === "gpt-4o");
    expect(model!.reasoning).toBe(true);
  });

  it("updates name", async () => {
    await seedModel(repo);

    await repo.updateModel(TEST_PROVIDER, "gpt-4o", { name: "GPT-4o Updated" });

    const provider = await repo.getProviderWithModels(TEST_PROVIDER);
    const model = provider!.models.find(m => m.id === "gpt-4o");
    expect(model!.name).toBe("GPT-4o Updated");
  });

  it("updates contextWindow and maxTokens", async () => {
    await seedModel(repo, { contextWindow: 128000, maxTokens: 16384 });

    await repo.updateModel(TEST_PROVIDER, "gpt-4o", { contextWindow: 200000, maxTokens: 32000 });

    const provider = await repo.getProviderWithModels(TEST_PROVIDER);
    const model = provider!.models.find(m => m.id === "gpt-4o");
    expect(model!.contextWindow).toBe(200000);
    expect(model!.maxTokens).toBe(32000);
  });

  it("updates multiple fields at once", async () => {
    await seedModel(repo, { reasoning: false });

    await repo.updateModel(TEST_PROVIDER, "gpt-4o", {
      name: "GPT-4o Reasoning",
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 100000,
    });

    const provider = await repo.getProviderWithModels(TEST_PROVIDER);
    const model = provider!.models.find(m => m.id === "gpt-4o");
    expect(model!.name).toBe("GPT-4o Reasoning");
    expect(model!.reasoning).toBe(true);
    expect(model!.contextWindow).toBe(200000);
    expect(model!.maxTokens).toBe(100000);
  });

  it("no-ops when updates object is empty", async () => {
    await seedModel(repo, { reasoning: false });

    // Should not throw
    await repo.updateModel(TEST_PROVIDER, "gpt-4o", {});

    const provider = await repo.getProviderWithModels(TEST_PROVIDER);
    const model = provider!.models.find(m => m.id === "gpt-4o");
    expect(model!.reasoning).toBe(false);
  });

  it("throws for non-existent provider", async () => {
    await expect(
      repo.updateModel("no-such-provider", "gpt-4o", { reasoning: true }),
    ).rejects.toThrow("not found");
  });

  it("throws for non-existent model", async () => {
    await expect(
      repo.updateModel(TEST_PROVIDER, "no-such-model", { reasoning: true }),
    ).rejects.toThrow("not found");
  });
});

// ── Model Change Detection (mirrors http-server logic) ──

describe("model change detection", () => {
  function needsUpdate(
    current: { id: string; provider: string; reasoning: boolean; contextWindow: number; maxTokens: number } | undefined,
    found: { id: string; provider: string; reasoning: boolean; contextWindow: number; maxTokens: number },
  ): boolean {
    return !current
      || current.id !== found.id
      || current.provider !== found.provider
      || current.reasoning !== found.reasoning
      || current.contextWindow !== found.contextWindow
      || current.maxTokens !== found.maxTokens;
  }

  it("detects reasoning change (false → true)", () => {
    const current = { id: "m1", provider: "p1", reasoning: false, contextWindow: 128000, maxTokens: 16384 };
    const found = { id: "m1", provider: "p1", reasoning: true, contextWindow: 128000, maxTokens: 16384 };
    expect(needsUpdate(current, found)).toBe(true);
  });

  it("detects reasoning change (true → false)", () => {
    const current = { id: "m1", provider: "p1", reasoning: true, contextWindow: 128000, maxTokens: 16384 };
    const found = { id: "m1", provider: "p1", reasoning: false, contextWindow: 128000, maxTokens: 16384 };
    expect(needsUpdate(current, found)).toBe(true);
  });

  it("detects contextWindow change", () => {
    const current = { id: "m1", provider: "p1", reasoning: false, contextWindow: 128000, maxTokens: 16384 };
    const found = { id: "m1", provider: "p1", reasoning: false, contextWindow: 200000, maxTokens: 16384 };
    expect(needsUpdate(current, found)).toBe(true);
  });

  it("detects maxTokens change", () => {
    const current = { id: "m1", provider: "p1", reasoning: false, contextWindow: 128000, maxTokens: 16384 };
    const found = { id: "m1", provider: "p1", reasoning: false, contextWindow: 128000, maxTokens: 32000 };
    expect(needsUpdate(current, found)).toBe(true);
  });

  it("returns false when nothing changed", () => {
    const current = { id: "m1", provider: "p1", reasoning: true, contextWindow: 128000, maxTokens: 16384 };
    const found = { id: "m1", provider: "p1", reasoning: true, contextWindow: 128000, maxTokens: 16384 };
    expect(needsUpdate(current, found)).toBe(false);
  });

  it("returns true when current is undefined (first prompt)", () => {
    const found = { id: "m1", provider: "p1", reasoning: false, contextWindow: 128000, maxTokens: 16384 };
    expect(needsUpdate(undefined, found)).toBe(true);
  });

  it("detects model id change", () => {
    const current = { id: "m1", provider: "p1", reasoning: false, contextWindow: 128000, maxTokens: 16384 };
    const found = { id: "m2", provider: "p1", reasoning: false, contextWindow: 128000, maxTokens: 16384 };
    expect(needsUpdate(current, found)).toBe(true);
  });
});
