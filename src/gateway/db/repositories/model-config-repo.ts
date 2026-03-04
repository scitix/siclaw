/**
 * Model Config Repository — providers and model entries
 */

import crypto from "node:crypto";
import { eq, and, sql, notInArray } from "drizzle-orm";
import type { Database } from "../index.js";
import { modelProviders, modelEntries, embeddingConfig } from "../schema.js";

export class ModelConfigRepository {
  constructor(private db: Database) {}

  /**
   * Remove orphan model entries whose provider_id no longer exists.
   * Called once at startup to keep the DB clean.
   */
  async cleanOrphanModels() {
    const providerIds = this.db
      .select({ id: modelProviders.id })
      .from(modelProviders);

    const result = await this.db
      .delete(modelEntries)
      .where(notInArray(modelEntries.providerId, providerIds));

    const deleted = (result as any)?.rowsAffected ?? (result as any)?.changes ?? 0;
    if (deleted > 0) {
      console.log(`[model-config] Cleaned ${deleted} orphan model entries`);
    }
  }

  // ─── Providers ─────────────────────────────────

  async listProviders() {
    const rows = await this.db
      .select({
        name: modelProviders.name,
        baseUrl: modelProviders.baseUrl,
        apiKey: modelProviders.apiKey,
        api: modelProviders.api,
        authHeader: modelProviders.authHeader,
        sortOrder: modelProviders.sortOrder,
        modelCount: sql<number>`(SELECT COUNT(*) FROM model_entries WHERE provider_id = ${modelProviders.id})`,
      })
      .from(modelProviders)
      .orderBy(modelProviders.sortOrder);

    return rows.map((r) => ({
      name: r.name,
      baseUrl: r.baseUrl ?? "",
      apiKey: r.apiKey ? "••••••" + (r.apiKey.length > 6 ? r.apiKey.slice(-4) : "") : "",
      apiKeySet: !!r.apiKey,
      api: r.api,
      authHeader: r.authHeader,
      modelCount: Number(r.modelCount),
    }));
  }

  async saveProvider(
    providerName: string,
    baseUrl?: string,
    apiKey?: string,
  ) {
    const rows = await this.db
      .select()
      .from(modelProviders)
      .where(eq(modelProviders.name, providerName))
      .limit(1);

    if (rows.length === 0) {
      // INSERT new provider
      await this.db.insert(modelProviders).values({
        id: crypto.randomUUID(),
        name: providerName,
        baseUrl: baseUrl ?? null,
        apiKey: apiKey ?? null,
        api: "openai-completions",
        authHeader: false,
        sortOrder: 0,
      });
      return;
    }

    // UPDATE existing provider
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (baseUrl !== undefined) updates.baseUrl = baseUrl;
    if (apiKey !== undefined) updates.apiKey = apiKey;

    await this.db
      .update(modelProviders)
      .set(updates)
      .where(eq(modelProviders.name, providerName));
  }

  async deleteProvider(providerName: string) {
    // Verify existence before delete (avoids sql.js getRowsModified race)
    const existing = await this.db
      .select({ name: modelProviders.name })
      .from(modelProviders)
      .where(eq(modelProviders.name, providerName))
      .limit(1);
    if (existing.length === 0) {
      throw new Error(`Provider "${providerName}" not found`);
    }
    await this.db
      .delete(modelProviders)
      .where(eq(modelProviders.name, providerName));
  }

  // ─── Models ────────────────────────────────────

  async listModels(providerName?: string) {
    if (providerName) {
      const rows = await this.db
        .select({
          id: modelEntries.modelId,
          name: modelEntries.name,
          provider: modelProviders.name,
          reasoning: modelEntries.reasoning,
          inputJson: modelEntries.inputJson,
          costJson: modelEntries.costJson,
          contextWindow: modelEntries.contextWindow,
          maxTokens: modelEntries.maxTokens,
          compatJson: modelEntries.compatJson,
          category: modelEntries.category,
          isDefault: modelEntries.isDefault,
          sortOrder: modelEntries.sortOrder,
        })
        .from(modelEntries)
        .innerJoin(modelProviders, eq(modelEntries.providerId, modelProviders.id))
        .where(eq(modelProviders.name, providerName))
        .orderBy(modelEntries.sortOrder);
      return rows;
    }

    const rows = await this.db
      .select({
        id: modelEntries.modelId,
        name: modelEntries.name,
        provider: modelProviders.name,
        reasoning: modelEntries.reasoning,
        inputJson: modelEntries.inputJson,
        costJson: modelEntries.costJson,
        contextWindow: modelEntries.contextWindow,
        maxTokens: modelEntries.maxTokens,
        compatJson: modelEntries.compatJson,
        category: modelEntries.category,
        isDefault: modelEntries.isDefault,
        sortOrder: modelEntries.sortOrder,
      })
      .from(modelEntries)
      .innerJoin(modelProviders, eq(modelEntries.providerId, modelProviders.id))
      .orderBy(modelProviders.sortOrder, modelEntries.sortOrder);
    return rows;
  }

  async addModel(
    providerName: string,
    model: {
      id: string;
      name: string;
      reasoning?: boolean;
      input?: string[];
      cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow?: number;
      maxTokens?: number;
      compat?: Record<string, unknown>;
      category?: string;
    },
  ) {
    const provRows = await this.db
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(eq(modelProviders.name, providerName))
      .limit(1);

    if (provRows.length === 0) {
      throw new Error(`Provider "${providerName}" not found`);
    }
    const providerId = provRows[0].id;

    // Check for duplicates (case-insensitive to prevent kimi-k2.5 vs Kimi-K2.5)
    const existing = await this.db
      .select({ id: modelEntries.id })
      .from(modelEntries)
      .where(
        and(
          eq(modelEntries.providerId, providerId),
          sql`lower(${modelEntries.modelId}) = lower(${model.id})`,
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      throw new Error(`Model "${model.id}" already exists in provider "${providerName}" (case-insensitive match)`);
    }

    const newEntry = {
      id: crypto.randomUUID(),
      providerId,
      modelId: model.id,
      name: model.name,
      reasoning: model.reasoning ?? false,
      inputJson: model.input ?? ["text"],
      costJson: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? 128000,
      maxTokens: model.maxTokens ?? 65536,
      compatJson: (model.compat ?? {
        supportsDeveloperRole: false,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
      }) as Record<string, unknown>,
      category: model.category ?? "llm",
      isDefault: false,
      sortOrder: 0,
    };

    await this.db.insert(modelEntries).values(newEntry);

    return {
      id: newEntry.modelId,
      name: newEntry.name,
      reasoning: newEntry.reasoning,
      input: newEntry.inputJson,
      cost: newEntry.costJson,
      contextWindow: newEntry.contextWindow,
      maxTokens: newEntry.maxTokens,
      compat: newEntry.compatJson,
    };
  }

  async removeModel(providerName: string, modelId: string) {
    const provRows = await this.db
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(eq(modelProviders.name, providerName))
      .limit(1);

    if (provRows.length === 0) {
      throw new Error(`Provider "${providerName}" not found`);
    }

    // Verify existence before delete (avoids sql.js getRowsModified race)
    const existing = await this.db
      .select({ id: modelEntries.id })
      .from(modelEntries)
      .where(
        and(
          eq(modelEntries.providerId, provRows[0].id),
          eq(modelEntries.modelId, modelId),
        ),
      )
      .limit(1);
    if (existing.length === 0) {
      throw new Error(`Model "${modelId}" not found`);
    }
    await this.db
      .delete(modelEntries)
      .where(
        and(
          eq(modelEntries.providerId, provRows[0].id),
          eq(modelEntries.modelId, modelId),
        ),
      );
  }

  // ─── Default Model ────────────────────────────

  async getDefault() {
    const rows = await this.db
      .select({
        provider: modelProviders.name,
        modelId: modelEntries.modelId,
      })
      .from(modelEntries)
      .innerJoin(modelProviders, eq(modelEntries.providerId, modelProviders.id))
      .where(eq(modelEntries.isDefault, true))
      .limit(1);

    return rows[0] ?? null;
  }

  async setDefault(providerName: string, modelId: string) {
    const provRows = await this.db
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(eq(modelProviders.name, providerName))
      .limit(1);

    if (provRows.length === 0) {
      throw new Error(`Provider "${providerName}" not found`);
    }

    // Clear all defaults
    await this.db
      .update(modelEntries)
      .set({ isDefault: false })
      .where(eq(modelEntries.isDefault, true));

    // Set new default
    await this.db
      .update(modelEntries)
      .set({ isDefault: true })
      .where(
        and(
          eq(modelEntries.providerId, provRows[0].id),
          eq(modelEntries.modelId, modelId),
        ),
      );
  }

  // ─── Resolved Default Config ─────────────────────

  async getResolvedDefaultConfig(): Promise<{
    baseUrl: string;
    apiKey: string;
    model: string;
  } | null> {
    const rows = await this.db
      .select({
        baseUrl: modelProviders.baseUrl,
        apiKey: modelProviders.apiKey,
        modelId: modelEntries.modelId,
      })
      .from(modelEntries)
      .innerJoin(modelProviders, eq(modelEntries.providerId, modelProviders.id))
      .where(eq(modelEntries.isDefault, true))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      baseUrl: row.baseUrl ?? "",
      apiKey: row.apiKey ?? "",
      model: row.modelId,
    };
  }

  // ─── Full Provider Config (for AgentBox) ───────

  async getProviderWithModels(providerName: string): Promise<{
    name: string;
    baseUrl: string;
    apiKey: string;
    api: string;
    authHeader: boolean;
    models: Array<{
      id: string;
      name: string;
      reasoning: boolean;
      input: string[];
      cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
      contextWindow: number;
      maxTokens: number;
      compat: Record<string, unknown>;
    }>;
  } | null> {
    const provRows = await this.db
      .select({
        id: modelProviders.id,
        name: modelProviders.name,
        baseUrl: modelProviders.baseUrl,
        apiKey: modelProviders.apiKey,
        api: modelProviders.api,
        authHeader: modelProviders.authHeader,
      })
      .from(modelProviders)
      .where(eq(modelProviders.name, providerName))
      .limit(1);

    if (provRows.length === 0) return null;
    const prov = provRows[0];

    const modelRows = await this.db
      .select({
        modelId: modelEntries.modelId,
        name: modelEntries.name,
        reasoning: modelEntries.reasoning,
        inputJson: modelEntries.inputJson,
        costJson: modelEntries.costJson,
        contextWindow: modelEntries.contextWindow,
        maxTokens: modelEntries.maxTokens,
        compatJson: modelEntries.compatJson,
      })
      .from(modelEntries)
      .where(eq(modelEntries.providerId, prov.id))
      .orderBy(modelEntries.sortOrder);

    return {
      name: prov.name,
      baseUrl: prov.baseUrl ?? "",
      apiKey: prov.apiKey ?? "",
      api: prov.api,
      authHeader: prov.authHeader,
      models: modelRows.map((m) => ({
        id: m.modelId,
        name: m.name,
        reasoning: m.reasoning,
        input: m.inputJson ?? ["text"],
        cost: m.costJson ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        compat: (m.compatJson ?? {}) as Record<string, unknown>,
      })),
    };
  }

  // ─── Embedding Config ──────────────────────────

  async getEmbeddingConfig(): Promise<{ provider: string; model: string; dimensions: number } | null> {
    const rows = await this.db
      .select()
      .from(embeddingConfig)
      .where(eq(embeddingConfig.id, "default"))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      provider: row.providerName ?? "",
      model: row.model ?? "",
      dimensions: row.dimensions,
    };
  }

  async getResolvedEmbeddingConfig(): Promise<{
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions: number;
  } | null> {
    const config = await this.getEmbeddingConfig();
    if (!config || !config.provider) return null;

    const provRows = await this.db
      .select({ baseUrl: modelProviders.baseUrl, apiKey: modelProviders.apiKey })
      .from(modelProviders)
      .where(eq(modelProviders.name, config.provider))
      .limit(1);

    if (provRows.length === 0) return null;
    const prov = provRows[0];
    return {
      baseUrl: prov.baseUrl ?? "",
      apiKey: prov.apiKey ?? "",
      model: config.model,
      dimensions: config.dimensions,
    };
  }

  /**
   * Export the full provider/model/embedding config as a settings.json-compatible object.
   * API keys are included in plain text (internal use only).
   */
  async exportSettingsConfig(): Promise<{
    providers: Record<string, { baseUrl: string; apiKey: string; api: string; authHeader: boolean; models: unknown[] }>;
    default?: { provider: string; modelId: string };
    embedding?: { baseUrl: string; apiKey: string; model: string; dimensions: number };
  }> {
    // Providers with raw API keys
    const provRows = await this.db
      .select({
        name: modelProviders.name,
        baseUrl: modelProviders.baseUrl,
        apiKey: modelProviders.apiKey,
        api: modelProviders.api,
        authHeader: modelProviders.authHeader,
      })
      .from(modelProviders)
      .orderBy(modelProviders.sortOrder);

    // All models
    const modelRows = await this.db
      .select({
        modelId: modelEntries.modelId,
        name: modelEntries.name,
        provider: modelProviders.name,
        reasoning: modelEntries.reasoning,
        inputJson: modelEntries.inputJson,
        costJson: modelEntries.costJson,
        contextWindow: modelEntries.contextWindow,
        maxTokens: modelEntries.maxTokens,
        compatJson: modelEntries.compatJson,
      })
      .from(modelEntries)
      .innerJoin(modelProviders, eq(modelEntries.providerId, modelProviders.id))
      .orderBy(modelProviders.sortOrder, modelEntries.sortOrder);

    // Build providers map
    const providers: Record<string, { baseUrl: string; apiKey: string; api: string; authHeader: boolean; models: unknown[] }> = {};
    for (const p of provRows) {
      providers[p.name] = {
        baseUrl: p.baseUrl ?? "",
        apiKey: p.apiKey ?? "",
        api: p.api,
        authHeader: p.authHeader,
        models: [],
      };
    }
    for (const m of modelRows) {
      if (providers[m.provider]) {
        providers[m.provider].models.push({
          id: m.modelId,
          name: m.name,
          reasoning: m.reasoning,
          input: m.inputJson,
          cost: m.costJson,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          compat: m.compatJson,
        });
      }
    }

    // Default model
    const defaultModel = await this.getDefault();

    // Embedding
    const embCfg = await this.getResolvedEmbeddingConfig();

    return {
      providers,
      ...(defaultModel ? { default: defaultModel } : {}),
      ...(embCfg ? { embedding: embCfg } : {}),
    };
  }

  async setEmbeddingConfig(provider: string, model: string, dimensions: number) {
    const existing = await this.db
      .select({ id: embeddingConfig.id })
      .from(embeddingConfig)
      .where(eq(embeddingConfig.id, "default"))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(embeddingConfig)
        .set({ providerName: provider, model, dimensions, updatedAt: new Date() })
        .where(eq(embeddingConfig.id, "default"));
    } else {
      await this.db.insert(embeddingConfig).values({
        id: "default",
        providerName: provider,
        model,
        dimensions,
      });
    }
  }
}
