/**
 * Resolution-order and projection tests for sub-agent model tiering.
 *
 * Separate from `subagent-models.test.ts` (payload shapes) because these cover the
 * pieces that decide WHICH tier is attempted — the env override, the type default,
 * and the config→menu projection that keeps credentials off the menu channel.
 */
import { describe, it, expect } from "vitest";
import { resolveRequestedTier, getSubagentModelTierOverride } from "./subagent-registry.js";
import { canonicalTierConfig, projectTierMenuFromConfig } from "./subagent-models.js";

const WHY = "read logs and summarise what changed";
const fakeHash = (canonical: string) => `${canonical.length}`.padStart(64, "0");

describe("getSubagentModelTierOverride", () => {
  it("treats unset and empty as no intervention", () => {
    expect(getSubagentModelTierOverride({})).toEqual({ mode: "none" });
    expect(getSubagentModelTierOverride({ SICLAW_SUBAGENT_MODEL_TIER: "" })).toEqual({ mode: "none" });
    expect(getSubagentModelTierOverride({ SICLAW_SUBAGENT_MODEL_TIER: "   " })).toEqual({ mode: "none" });
  });

  it("recognises `off` case-insensitively", () => {
    for (const raw of ["off", "OFF", " Off "]) {
      expect(getSubagentModelTierOverride({ SICLAW_SUBAGENT_MODEL_TIER: raw })).toEqual({ mode: "off" });
    }
  });

  it("treats any other value as a pinned tier name", () => {
    expect(getSubagentModelTierOverride({ SICLAW_SUBAGENT_MODEL_TIER: "fast" })).toEqual({
      mode: "pin",
      tier: "fast",
    });
  });

  it("has NO `inherit` value — that is what `off` means", () => {
    // One behaviour, one spelling. Two spellings is how Claude Code shipped a bug
    // where `inherit` silently suppressed the per-call parameter.
    const result = getSubagentModelTierOverride({ SICLAW_SUBAGENT_MODEL_TIER: "inherit" });
    expect(result).toEqual({ mode: "pin", tier: "inherit" });
  });
});

describe("resolveRequestedTier", () => {
  it("prefers the request over the type default", () => {
    expect(resolveRequestedTier("fast", "general-purpose", {})).toEqual({
      tier: "fast",
      source: "request",
    });
  });

  it("falls to inherit when nothing asks for a tier", () => {
    expect(resolveRequestedTier(null, "general-purpose", {})).toEqual({
      tier: null,
      source: "inherit",
    });
    expect(resolveRequestedTier("   ", undefined, {})).toEqual({ tier: null, source: "inherit" });
  });

  it("env `off` beats an explicit request — it is a rollback lever", () => {
    // An agent whose prompt keeps asking for a tier must still stop tiering when
    // ops says so, or the lever does not work.
    expect(resolveRequestedTier("fast", "general-purpose", { SICLAW_SUBAGENT_MODEL_TIER: "off" })).toEqual({
      tier: null,
      source: "inherit",
    });
  });

  it("env pin beats an explicit request, and is attributed to env", () => {
    expect(
      resolveRequestedTier("deep", "general-purpose", { SICLAW_SUBAGENT_MODEL_TIER: "fast" }),
    ).toEqual({ tier: "fast", source: "env" });
  });

  it("attributes a type default to type_default, not request", () => {
    // general-purpose deliberately has no default, so an unknown type behaves the
    // same as one without: inherit.
    expect(resolveRequestedTier(null, "no-such-type", {})).toEqual({ tier: null, source: "inherit" });
  });
});

describe("projectTierMenuFromConfig", () => {
  const config = [
    { tier: "fast", provider: "prov-a", modelId: "m-1", whenToUse: WHY },
    { tier: "deep", provider: "prov-b", modelId: "m-2", whenToUse: WHY },
  ];

  it("drops provider and modelId — they must never reach the menu channel", () => {
    const menu = projectTierMenuFromConfig(config, fakeHash);
    expect(menu).not.toBeNull();
    const serialized = JSON.stringify(menu);
    expect(serialized).not.toContain("prov-a");
    expect(serialized).not.toContain("m-1");
    expect(menu!.items).toEqual([
      { tier: "fast", whenToUse: WHY },
      { tier: "deep", whenToUse: WHY },
    ]);
  });

  it("returns null for absent or empty config (the clear signal)", () => {
    expect(projectTierMenuFromConfig(null, fakeHash)).toBeNull();
    expect(projectTierMenuFromConfig([], fakeHash)).toBeNull();
    expect(projectTierMenuFromConfig(undefined, fakeHash)).toBeNull();
  });

  it("returns null rather than a partial menu when an entry is malformed", () => {
    // A menu entry with nothing behind it reads to the lead as an offer that
    // cannot be fulfilled, so a broken list ships as no list.
    expect(projectTierMenuFromConfig([{ tier: "Fast", provider: "p", modelId: "m", whenToUse: WHY }], fakeHash)).toBeNull();
    expect(projectTierMenuFromConfig([{ tier: "fast", provider: "p", modelId: "m", whenToUse: "tiny" }], fakeHash)).toBeNull();
    expect(projectTierMenuFromConfig([{ tier: "fast", modelId: "m", whenToUse: WHY }], fakeHash)).toBeNull();
  });
});

describe("canonicalTierConfig", () => {
  it("is independent of entry order, so both channels agree on a revision", () => {
    // The menu and the candidates are produced by different code paths; an
    // order-dependent revision would report a mismatch for two descriptions of
    // the same configuration and tiering would never engage.
    const a = canonicalTierConfig([
      { tier: "fast", provider: "p", modelId: "m1", whenToUse: WHY },
      { tier: "deep", provider: "p", modelId: "m2", whenToUse: WHY },
    ]);
    const b = canonicalTierConfig([
      { tier: "deep", provider: "p", modelId: "m2", whenToUse: WHY },
      { tier: "fast", provider: "p", modelId: "m1", whenToUse: WHY },
    ]);
    expect(a).toBe(b);
  });

  it("changes when any defining field changes", () => {
    const base = [{ tier: "fast", provider: "p", modelId: "m", whenToUse: WHY }];
    const canonical = canonicalTierConfig(base);
    expect(canonicalTierConfig([{ ...base[0], modelId: "other" }])).not.toBe(canonical);
    expect(canonicalTierConfig([{ ...base[0], provider: "other" }])).not.toBe(canonical);
    expect(canonicalTierConfig([{ ...base[0], whenToUse: `${WHY} extra` }])).not.toBe(canonical);
    expect(canonicalTierConfig([{ ...base[0], tier: "quick" }])).not.toBe(canonical);
  });
});
