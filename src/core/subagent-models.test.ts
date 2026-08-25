import { describe, it, expect } from "vitest";
import {
  MAX_SUBAGENT_TIERS,
  WHEN_TO_USE_MAX_CHARS,
  encodeSubagentModelsForDb,
  isTierPayloadCleared,
  normalizeSubagentTierCandidates,
  normalizeSubagentTierConfig,
  normalizeSubagentTierMenu,
  persistableTierOutcome,
  renderTierMenuForDescription,
  sanitizeWireItemStatuses,
  sanitizeWireTierOutcome,
  resolveTierSelection,
  type SubagentTierCandidates,
  type SubagentTierMenu,
} from "./subagent-models.js";

const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);
const WHY = "check logs and summarise findings";

function menu(items: Array<{ tier: string; whenToUse?: string }>, revision = REV_A): unknown {
  return { revision, items: items.map((i) => ({ tier: i.tier, whenToUse: i.whenToUse ?? WHY })) };
}

function candidates(
  entries: Array<{ tier: string; provider?: string; modelId?: string }>,
  revision = REV_A,
): unknown {
  return {
    revision,
    candidates: entries.map((e, i) => ({
      tier: e.tier,
      provider: e.provider ?? `prov-${i}`,
      modelId: e.modelId ?? `model-${i}`,
      modelConfig: { apiKey: "secret", baseUrl: "https://example.invalid" },
    })),
  };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);
  return result.value;
}

describe("normalizeSubagentTierMenu", () => {
  it("accepts a well-formed menu", () => {
    const value = unwrap(normalizeSubagentTierMenu(menu([{ tier: "fast" }, { tier: "deep" }])));
    expect(value.revision).toBe(REV_A);
    expect(value.items.map((i) => i.tier)).toEqual(["fast", "deep"]);
  });

  it("does NOT require provider/modelId — a menu never carries them", () => {
    // The whole point of the two-shape split: requiring a candidate field here
    // would reject every valid menu and disable tiering everywhere.
    const result = normalizeSubagentTierMenu(menu([{ tier: "fast" }]));
    expect(result.ok).toBe(true);
  });

  it("rejects a revision that is not 64 lowercase hex chars", () => {
    for (const revision of ["", "xyz", "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      const result = normalizeSubagentTierMenu(menu([{ tier: "fast" }], revision));
      expect(result.ok, `revision ${JSON.stringify(revision)}`).toBe(false);
    }
  });

  it("rejects an empty items array rather than treating it as a clear", () => {
    // An empty-but-present menu still carries a revision, which would leave a
    // revision on one side with nothing to match — a permanent mismatch.
    const result = normalizeSubagentTierMenu({ revision: REV_A, items: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("send null to clear");
  });

  it("rejects more than the tier cap", () => {
    const items = Array.from({ length: MAX_SUBAGENT_TIERS + 1 }, (_, i) => ({ tier: `t${i}` }));
    const result = normalizeSubagentTierMenu(menu(items));
    expect(result.ok).toBe(false);
  });

  it("rejects a duplicate tier", () => {
    const result = normalizeSubagentTierMenu(menu([{ tier: "fast" }, { tier: "fast" }]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("more than once");
  });

  it("rejects tier names outside the pattern", () => {
    for (const tier of ["Fast", "fast tier", "1fast", "", "fast!", "a".repeat(33), "-fast"]) {
      const result = normalizeSubagentTierMenu(menu([{ tier }]));
      expect(result.ok, `tier ${JSON.stringify(tier)}`).toBe(false);
    }
  });

  it("enforces whenToUse length in CODE POINTS, not UTF-16 units", () => {
    // 200 CJK code points is 200 UTF-16 units here, but an emoji-heavy string
    // would be double-counted by .length — that must not shorten the allowance.
    const cjk = "查".repeat(200);
    expect(normalizeSubagentTierMenu(menu([{ tier: "fast", whenToUse: cjk }])).ok).toBe(true);

    const astral = "🌟".repeat(WHEN_TO_USE_MAX_CHARS);
    expect(normalizeSubagentTierMenu(menu([{ tier: "fast", whenToUse: astral }])).ok).toBe(true);

    const tooLong = "🌟".repeat(WHEN_TO_USE_MAX_CHARS + 1);
    expect(normalizeSubagentTierMenu(menu([{ tier: "fast", whenToUse: tooLong }])).ok).toBe(false);
  });

  it("rejects whenToUse below the floor", () => {
    const result = normalizeSubagentTierMenu(menu([{ tier: "fast", whenToUse: "short" }]));
    expect(result.ok).toBe(false);
  });

  it("rejects control characters instead of stripping them", () => {
    // Silently editing operator prose that lands in a tool description is worse
    // than refusing it — the model would read something nobody wrote.
    for (const ch of ["\u0000", "\n", "\u001F", "\u007F", "\u009F"]) {
      const result = normalizeSubagentTierMenu(
        menu([{ tier: "fast", whenToUse: `check${ch} the logs please` }]),
      );
      expect(result.ok, `char ${JSON.stringify(ch)}`).toBe(false);
    }
  });

  it("rejects non-objects", () => {
    for (const raw of [null, undefined, 42, "menu", []]) {
      expect(normalizeSubagentTierMenu(raw).ok).toBe(false);
    }
  });
});

describe("normalizeSubagentTierCandidates", () => {
  it("accepts a well-formed payload", () => {
    const value = unwrap(
      normalizeSubagentTierCandidates(candidates([{ tier: "fast" }, { tier: "deep" }])),
    );
    expect(value.candidates.map((c) => c.tier)).toEqual(["fast", "deep"]);
  });

  it("does NOT require whenToUse — a candidate never carries it", () => {
    // Requiring it would reject every valid binding and silently disable tiering.
    const result = normalizeSubagentTierCandidates(candidates([{ tier: "fast" }]));
    expect(result.ok).toBe(true);
  });

  it("accepts tiers on DIFFERENT providers", () => {
    // Cross-provider is mandatory: under Upstream mode provider names are
    // generated per model row, so same-provider would mean same-model.
    const result = normalizeSubagentTierCandidates(
      candidates([
        { tier: "fast", provider: "p-one", modelId: "m1" },
        { tier: "deep", provider: "p-two", modelId: "m2" },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects two tiers pointing at the same model", () => {
    const result = normalizeSubagentTierCandidates(
      candidates([
        { tier: "fast", provider: "p", modelId: "m" },
        { tier: "quick", provider: "p", modelId: "m" },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("two tiers at p/m");
  });

  it("requires provider, modelId and modelConfig", () => {
    const base = { revision: REV_A };
    const cases: unknown[] = [
      { ...base, candidates: [{ tier: "fast", modelId: "m", modelConfig: {} }] },
      { ...base, candidates: [{ tier: "fast", provider: "p", modelConfig: {} }] },
      { ...base, candidates: [{ tier: "fast", provider: "p", modelId: "m" }] },
      { ...base, candidates: [{ tier: "fast", provider: " ", modelId: "m", modelConfig: {} }] },
    ];
    for (const raw of cases) {
      expect(normalizeSubagentTierCandidates(raw).ok).toBe(false);
    }
  });

  it("rejects a malformed revision and an over-cap list", () => {
    expect(normalizeSubagentTierCandidates(candidates([{ tier: "fast" }], "nope")).ok).toBe(false);
    const many = Array.from({ length: MAX_SUBAGENT_TIERS + 1 }, (_, i) => ({ tier: `t${i}` }));
    expect(normalizeSubagentTierCandidates(candidates(many)).ok).toBe(false);
  });
});

describe("normalizers never throw", () => {
  it("returns a rejection for hostile input instead of raising", () => {
    // A malformed tier list must not take down the parent turn.
    const hostile: unknown[] = [
      Object.create(null),
      { revision: REV_A, items: [Object.create(null)] },
      { revision: REV_A, items: [{ tier: {}, whenToUse: [] }] },
      { revision: {}, candidates: {} },
      Symbol.iterator,
      () => {},
    ];
    for (const raw of hostile) {
      expect(() => normalizeSubagentTierMenu(raw)).not.toThrow();
      expect(() => normalizeSubagentTierCandidates(raw)).not.toThrow();
    }
  });
});

describe("isTierPayloadCleared", () => {
  it("treats null/undefined as a clear and anything else as content", () => {
    expect(isTierPayloadCleared(null)).toBe(true);
    expect(isTierPayloadCleared(undefined)).toBe(true);
    expect(isTierPayloadCleared({ revision: REV_A, items: [] })).toBe(false);
    expect(isTierPayloadCleared(0)).toBe(false);
  });
});

describe("encodeSubagentModelsForDb", () => {
  const entry = { tier: "fast", provider: "p", modelId: "m", whenToUse: WHY };

  it("distinguishes absent (undefined) from cleared (null / empty)", () => {
    expect(encodeSubagentModelsForDb(undefined)).toBeUndefined();
    expect(encodeSubagentModelsForDb(null)).toBeNull();
    expect(encodeSubagentModelsForDb([])).toBeNull();
  });

  it("round-trips a valid list, trimming as it goes", () => {
    const json = encodeSubagentModelsForDb([{ ...entry, provider: "  p  ", whenToUse: ` ${WHY} ` }]);
    expect(JSON.parse(json as string)).toEqual([{ tier: "fast", provider: "p", modelId: "m", whenToUse: WHY }]);
  });

  it("accepts a cross-provider list", () => {
    const json = encodeSubagentModelsForDb([
      entry,
      { tier: "deep", provider: "other", modelId: "m2", whenToUse: WHY },
    ]);
    expect(JSON.parse(json as string)).toHaveLength(2);
  });

  it("THROWS on invalid input — this is a write path, not a turn", () => {
    // Contrast with the normalizers: refusing a bad write is right, refusing to
    // serve a turn is not.
    expect(() => encodeSubagentModelsForDb("nope")).toThrow(/must be null or an array/);
    expect(() => encodeSubagentModelsForDb([{ ...entry, tier: "Fast" }])).toThrow(/tier must match/);
    expect(() => encodeSubagentModelsForDb([entry, entry])).toThrow(/duplicate tier/);
    expect(() => encodeSubagentModelsForDb([{ ...entry, provider: "" }])).toThrow(/requires a provider/);
    expect(() => encodeSubagentModelsForDb([{ ...entry, modelId: "" }])).toThrow(/requires a modelId/);
    expect(() => encodeSubagentModelsForDb([{ ...entry, whenToUse: "tiny" }])).toThrow(/whenToUse/);
    expect(() =>
      encodeSubagentModelsForDb([entry, { ...entry, tier: "quick" }]),
    ).toThrow(/same model p\/m/);
    expect(() =>
      encodeSubagentModelsForDb(
        Array.from({ length: MAX_SUBAGENT_TIERS + 1 }, (_, i) => ({ ...entry, tier: `t${i}`, modelId: `m${i}` })),
      ),
    ).toThrow(/at most/);
  });
});

describe("normalizeSubagentTierConfig (read paths must never throw)", () => {
  const good = { tier: "fast", provider: "p", modelId: "m", whenToUse: WHY };

  it("rejects rather than throws on the shapes a stored column can actually hold", () => {
    // safeParseJson is a type ASSERTION: '[null]' parses, passes Array.isArray,
    // and then throws a TypeError on the first field access. Since this resolver
    // also feeds config.getModelBinding, that throw would take out an agent's
    // whole model binding over a malformed optional feature.
    const hostile: unknown[] = [
      [null],
      [undefined],
      ["fast"],
      [42],
      [[]],
      [{}],
      "not an array",
      42,
      { tier: "fast" },
    ];
    for (const raw of hostile) {
      expect(() => normalizeSubagentTierConfig(raw)).not.toThrow();
      expect(normalizeSubagentTierConfig(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it("treats null / undefined / [] as no tiers rather than as errors", () => {
    // The ordinary state of most agents.
    for (const raw of [null, undefined, []]) {
      const result = normalizeSubagentTierConfig(raw);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual([]);
    }
  });

  it("applies the same duplicate and cap rules the write path does", () => {
    expect(normalizeSubagentTierConfig([good, good]).ok).toBe(false);
    expect(normalizeSubagentTierConfig([good, { ...good, tier: "deep" }]).ok).toBe(false);
    const overCap = Array.from({ length: MAX_SUBAGENT_TIERS + 1 }, (_, i) => ({
      ...good, tier: `t${i}`, modelId: `m${i}`,
    }));
    expect(normalizeSubagentTierConfig(overCap).ok).toBe(false);
  });

  it("accepts snake_case field names, as a control plane may emit them", () => {
    const result = normalizeSubagentTierConfig([
      { tier: "fast", model_provider: "p", model_id: "m", when_to_use: WHY },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value[0]).toEqual({ tier: "fast", provider: "p", modelId: "m", whenToUse: WHY });
  });
});

describe("persistableTierOutcome", () => {
  it("keeps identifiers and reasons, and carries no credentials", () => {
    // This projection is what a terminal delegation event stores, and for a
    // BACKGROUND run it is the ONLY surviving record — the tool call returned
    // `launched` before any of it was known. Explicit field-by-field rather than
    // a spread, so the shape cannot quietly grow a credential-bearing field.
    const projected = persistableTierOutcome({
      requestedTier: "fast",
      resolvedTier: null,
      source: "request",
      fallbackReason: "candidate_missing",
      provider: "p",
      modelId: "m",
      detail: "some internal detail",
    });

    expect(projected).toEqual({
      requestedTier: "fast",
      source: "request",
      fallbackReason: "candidate_missing",
      provider: "p",
      modelId: "m",
    });
    expect(JSON.stringify(projected)).not.toContain("apiKey");
  });

  it("omits empty fields rather than storing nulls", () => {
    const projected = persistableTierOutcome({
      requestedTier: null,
      resolvedTier: "deep",
      source: "type_default",
    });
    expect(projected).toEqual({ resolvedTier: "deep", source: "type_default" });
  });
});

describe("sanitizeWireTierOutcome (runtime allow-list)", () => {
  it("keeps only the allow-listed keys, dropping anything else", () => {
    // The producer-side projection is compile-time; this is the consumer-side
    // runtime one. An HTTP boundary types its body by ASSERTION, which strips
    // nothing, so without this a caller could write credentials into a durable
    // record just by including them.
    const result = sanitizeWireTierOutcome({
      requestedTier: "fast",
      resolvedTier: "fast",
      source: "request",
      provider: "p",
      modelId: "m",
      fallbackReason: "unknown_tier",
      modelConfig: { apiKey: "sk-leak" },
      apiKey: "sk-leak-2",
      detail: "internal",
      extra: 1,
    });

    expect(result).toEqual({
      requestedTier: "fast",
      resolvedTier: "fast",
      source: "request",
      provider: "p",
      modelId: "m",
      fallbackReason: "unknown_tier",
    });
    expect(JSON.stringify(result)).not.toContain("sk-leak");
  });

  it("accepts strings only — a nested object is a smuggling attempt, not a value", () => {
    const result = sanitizeWireTierOutcome({
      source: "request",
      provider: { nested: "object" },
      modelId: ["array"],
      resolvedTier: 42,
    });
    expect(result).toEqual({ source: "request" });
  });

  it("returns undefined without a usable source, and for non-objects", () => {
    // `source` is what makes the record meaningful; without it there is nothing
    // to report.
    expect(sanitizeWireTierOutcome({ provider: "p" })).toBeUndefined();
    expect(sanitizeWireTierOutcome({ source: "" })).toBeUndefined();
    for (const raw of [null, undefined, 42, "tier", []]) {
      expect(sanitizeWireTierOutcome(raw)).toBeUndefined();
    }
  });

  it("sanitizes each item inside a group snapshot and skips malformed entries", () => {
    const result = sanitizeWireItemStatuses([
      { index: 0, status: "done", tier: { source: "env", modelConfig: { apiKey: "sk-leak" } } },
      { index: 1, status: "skipped" },
      { status: "missing index" },
      "not an object",
      { index: 2, status: 99 },
    ]);

    expect(result).toEqual([
      { index: 0, status: "done", tier: { source: "env" } },
      { index: 1, status: "skipped" },
    ]);
    expect(JSON.stringify(result)).not.toContain("sk-leak");
  });

  it("returns undefined for a non-array snapshot", () => {
    expect(sanitizeWireItemStatuses({ nope: true })).toBeUndefined();
    expect(sanitizeWireItemStatuses(null)).toBeUndefined();
  });
});

describe("resolveTierSelection", () => {
  const m = unwrap(normalizeSubagentTierMenu(menu([{ tier: "fast" }, { tier: "deep" }]))) as SubagentTierMenu;
  const c = unwrap(
    normalizeSubagentTierCandidates(candidates([{ tier: "fast" }, { tier: "deep" }])),
  ) as SubagentTierCandidates;

  it("resolves a requested tier that both channels agree on", () => {
    const result = resolveTierSelection(m, c, "fast");
    expect(result.kind).toBe("tier");
    if (result.kind === "tier") expect(result.candidate.tier).toBe("fast");
  });

  it("inherits when no tier was requested", () => {
    expect(resolveTierSelection(m, c, undefined).kind).toBe("inherit");
    expect(resolveTierSelection(m, c, "   ").kind).toBe("inherit");
  });

  it("inherits — not fails — when the deployment has no tier state at all", () => {
    expect(resolveTierSelection(null, null, "fast").kind).toBe("inherit");
  });

  it("reports revision_mismatch when the two revisions differ", () => {
    const stale = unwrap(
      normalizeSubagentTierCandidates(candidates([{ tier: "fast" }], REV_B)),
    ) as SubagentTierCandidates;
    const result = resolveTierSelection(m, stale, "fast");
    expect(result).toEqual({ kind: "fallback", reason: "revision_mismatch" });
  });

  it("reports revision_mismatch when only one side has state", () => {
    expect(resolveTierSelection(m, null, "fast")).toEqual({
      kind: "fallback",
      reason: "revision_mismatch",
    });
    expect(resolveTierSelection(null, c, "fast")).toEqual({
      kind: "fallback",
      reason: "revision_mismatch",
    });
  });

  it("reports candidate_missing when the menu advertised a tier the binding lacks", () => {
    const partial = unwrap(
      normalizeSubagentTierCandidates(candidates([{ tier: "fast" }])),
    ) as SubagentTierCandidates;
    const result = resolveTierSelection(m, partial, "deep");
    expect(result).toEqual({ kind: "fallback", reason: "candidate_missing" });
  });

  it("reports unknown_tier for a name that was never on the menu", () => {
    const result = resolveTierSelection(m, c, "cheapest");
    expect(result).toEqual({ kind: "fallback", reason: "unknown_tier" });
  });

  it("refuses a candidate the MENU did not advertise, even when it exists", () => {
    // The menu is the authorization boundary, not the candidate list: a tier the
    // lead was never offered is out of bounds even if a binding carries it.
    const menuWithoutDeep = unwrap(
      normalizeSubagentTierMenu(menu([{ tier: "fast" }])),
    ) as SubagentTierMenu;
    const result = resolveTierSelection(menuWithoutDeep, c, "deep");
    expect(result).toEqual({ kind: "fallback", reason: "unknown_tier" });
  });
});

describe("renderTierMenuForDescription", () => {
  it("returns empty string with no menu, so the parameter can be omitted entirely", () => {
    expect(renderTierMenuForDescription(null)).toBe("");
    expect(renderTierMenuForDescription(undefined)).toBe("");
  });

  it("lists each tier with its guidance and never leaks a model id", () => {
    const m = unwrap(
      normalizeSubagentTierMenu(menu([{ tier: "fast", whenToUse: "read logs, summarise" }])),
    ) as SubagentTierMenu;
    const text = renderTierMenuForDescription(m);
    expect(text).toContain("model_tier");
    expect(text).toContain("fast — read logs, summarise");
    expect(text).not.toContain("prov-");
    expect(text).not.toContain("model-");
  });
});
