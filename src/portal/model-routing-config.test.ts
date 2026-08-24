/**
 * Standalone tier resolution: config rows → menu + hydrated candidates.
 *
 * The behaviour under test is what happens when part of a tier list no longer
 * resolves, which is the steady state after any model or provider is removed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import { resolveAgentSubagentTiers, sha256Hex } from "./model-routing-config.js";
import { canonicalTierConfig } from "../core/subagent-models.js";

const WHY_FAST = "read logs and grep code — retrieval and summary";
const WHY_DEEP = "cross-source causal reasoning, or a conclusion a human reads";

/**
 * Answer the resolver's per-provider queries: one provider row lookup and one
 * model_entries lookup per distinct provider, in call order.
 */
function mockProviders(providers: Array<{ name: string; models: string[] } | null>) {
  const query = vi.fn();
  for (const provider of providers) {
    if (!provider) {
      query.mockResolvedValueOnce([[], []]);        // provider not found
      continue;
    }
    query.mockResolvedValueOnce([[{
      id: `${provider.name}-id`, name: provider.name,
      base_url: "https://x.invalid", api_key: "k", api_type: "openai",
    }], []]);
    query.mockResolvedValueOnce([
      provider.models.map((model_id) => ({
        model_id, name: model_id, reasoning: 0, vision: 0,
        context_window: 100_000, max_tokens: 4096, api_type: null,
        max_tokens_field: null, compat_overrides: null,
      })),
      [],
    ]);
  }
  (getDb as any).mockReturnValue({ query, getConnection: vi.fn() });
  return query;
}

const CONFIG = [
  { tier: "fast", provider: "p-a", modelId: "m-fast", whenToUse: WHY_FAST },
  { tier: "deep", provider: "p-b", modelId: "m-deep", whenToUse: WHY_DEEP },
];

describe("resolveAgentSubagentTiers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hydrates every tier when all of them resolve", async () => {
    mockProviders([{ name: "p-a", models: ["m-fast"] }, { name: "p-b", models: ["m-deep"] }]);
    const { menu, candidates } = await resolveAgentSubagentTiers(JSON.stringify(CONFIG));

    expect(menu!.items.map((i) => i.tier)).toEqual(["fast", "deep"]);
    expect(candidates!.candidates.map((c) => c.tier)).toEqual(["fast", "deep"]);
    expect(menu!.revision).toBe(candidates!.revision);
  });

  it("keeps healthy tiers usable when ONE model no longer exists", async () => {
    // The whole point. Returning null for the first unresolvable tier took every
    // healthy tier down with it — and asymmetrically, since the menu is built from
    // the raw config on a separate path: the menu still advertised both tiers
    // while the candidate side went empty, so the revisions disagreed and even the
    // surviving tier failed with revision_mismatch. Delete one model of two and
    // neither worked.
    mockProviders([{ name: "p-a", models: [] }, { name: "p-b", models: ["m-deep"] }]);
    const { menu, candidates } = await resolveAgentSubagentTiers(JSON.stringify(CONFIG));

    expect(candidates!.candidates.map((c) => c.tier)).toEqual(["deep"]);
    // The menu still lists both, so the dangling one resolves to candidate_missing
    // rather than silently vanishing from what the lead was offered.
    expect(menu!.items.map((i) => i.tier)).toEqual(["fast", "deep"]);
  });

  it("keeps healthy tiers usable when ONE provider is gone", async () => {
    mockProviders([null, { name: "p-b", models: ["m-deep"] }]);
    const { candidates } = await resolveAgentSubagentTiers(JSON.stringify(CONFIG));
    expect(candidates!.candidates.map((c) => c.tier)).toEqual(["deep"]);
  });

  it("computes the revision over the FULL config, not the surviving subset", async () => {
    // Both channels must agree, and the menu side hashes the whole config. A
    // revision over the survivors would mismatch on every spawn — which is the
    // failure this test exists to prevent, not merely an implementation detail.
    mockProviders([{ name: "p-a", models: [] }, { name: "p-b", models: ["m-deep"] }]);
    const { menu, candidates } = await resolveAgentSubagentTiers(JSON.stringify(CONFIG));

    const expected = sha256Hex(canonicalTierConfig(CONFIG));
    expect(menu!.revision).toBe(expected);
    expect(candidates!.revision).toBe(expected);
  });

  it("reports no tiers when NOTHING resolves", async () => {
    // A menu backed by nothing would offer the lead choices that can never be
    // honoured, so this is the one case that still collapses to null.
    mockProviders([null, null]);
    const result = await resolveAgentSubagentTiers(JSON.stringify(CONFIG));
    expect(result).toEqual({ menu: null, candidates: null });
  });

  it("returns no tiers for absent or empty config", async () => {
    (getDb as any).mockReturnValue({ query: vi.fn(), getConnection: vi.fn() });
    expect(await resolveAgentSubagentTiers(null)).toEqual({ menu: null, candidates: null });
    expect(await resolveAgentSubagentTiers("[]")).toEqual({ menu: null, candidates: null });
  });
});
