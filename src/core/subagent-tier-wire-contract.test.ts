/**
 * Cross-repo wire contract for the sub-agent tier menu.
 *
 * `config.getAgent` is answered by a DIFFERENT implementation under Upstream mode,
 * so the shape that arrives is not the one this repo's own writer produces. Every
 * other test in this suite feeds the Standalone shape, which is exactly why the
 * mismatch below shipped: the projection returned null for the upstream payload,
 * no menu reached the tool description, `spawn_subagent` never exposed
 * `model_tier`, and the whole feature was silently absent on those deployments —
 * with the entire suite green.
 *
 * The fixtures here are the payloads as another implementation actually emits
 * them. Treat them as frozen: changing one means the wire contract changed and
 * both sides have to agree, not that a test needs updating.
 */
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import {
  MAX_SUBAGENT_TIERS,
  WHEN_TO_USE_MAX_CHARS,
  canonicalFixturePayload,
  canonicalTierConfig,
  normalizeSubagentTierCandidates,
  normalizeSubagentTierConfig,
  normalizeSubagentTierMenu,
  projectTierMenuFromConfig,
  renderTierMenuForDescription,
} from "./subagent-models.js";

const sha256Hex = (input: string) => crypto.createHash("sha256").update(input).digest("hex");

/**
 * Loaded from the GOLDEN FIXTURE rather than written inline, so the other
 * implementation can assert against the same bytes instead of a transcription —
 * transcribing is exactly the step where a spelling drifts, which is the failure
 * this file exists to prevent.
 */
const golden = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(url.fileURLToPath(import.meta.url)), "__fixtures__/subagent-tier-wire.golden.json"),
    "utf-8",
  ),
);

/**
 * Upstream mode: the producer projects the menu and sends it under the snake_case
 * FIELD of a snake_case RPC, while the payload inside is camelCase. Read from the
 * producer's own envelope shape so a structural change on that side fails here.
 */
const UPSTREAM_PROJECTED_MENU = golden.config_getAgent.subagent_model_tiers;
const REV: string = UPSTREAM_PROJECTED_MENU.revision;

/** The credential-bearing half, for the confidentiality assertions. */
const UPSTREAM_CANDIDATES = golden.config_getModelBinding.binding.subagentTiers;

/**
 * Standalone: the raw config array this repo writes itself. Not in the shared
 * fixture — it is not part of the cross-repo contract, only of the compatibility
 * path that accepts it.
 */
const STANDALONE_CONFIG = [
  { tier: "fast", provider: "p-a", modelId: "m-1", whenToUse: "read logs, grep code, check config" },
  { tier: "deep", provider: "p-b", modelId: "m-2", whenToUse: "cross-source causal reasoning" },
];

describe("tier menu wire contract", () => {
  it("accepts an already-projected menu from a control plane", () => {
    // The regression this file exists for. Before the shape dispatch this
    // returned null and the feature did not exist under Upstream mode.
    const menu = projectTierMenuFromConfig(UPSTREAM_PROJECTED_MENU, sha256Hex);
    expect(menu).not.toBeNull();
    expect(menu!.items.map((i) => i.tier)).toEqual(["fast", "deep"]);
  });

  it("PRESERVES the producer's revision rather than recomputing it", () => {
    // Recomputing would hash a projection that no longer carries provider or
    // modelId, so it could never match the revision shipped with the candidates —
    // and every spawn would report revision_mismatch.
    const menu = projectTierMenuFromConfig(UPSTREAM_PROJECTED_MENU, sha256Hex);
    expect(menu!.revision).toBe(REV);
  });

  it("reads the CANONICAL camelCase key the producer actually emits", () => {
    // The casing split is deliberate: the RPC FIELD is snake_case
    // (subagent_model_tiers), the PAYLOAD inside it is camelCase (whenToUse).
    // Reading the key straight off the producer's envelope means a rename there
    // fails here.
    expect(Object.keys(UPSTREAM_PROJECTED_MENU.items[0])).toContain("whenToUse");
    const menu = projectTierMenuFromConfig(UPSTREAM_PROJECTED_MENU, sha256Hex);
    expect(menu!.items[0].whenToUse.length).toBeGreaterThan(0);
  });

  it("also tolerates the snake_case alias, but that is tolerance and not the contract", () => {
    // The consumer accepts it because that RPC is snake_case elsewhere and a
    // producer emitting it is not wrong. The producer should still emit the
    // canonical key, and may reject the alias — asymmetry is deliberate: a
    // consumer that refuses a spelling turns a cosmetic difference into a silent
    // outage, while a producer that emits one keeps the contract crisp.
    const aliased = {
      revision: REV,
      items: [{ tier: "fast", when_to_use: "read logs and summarise findings" }],
    };
    const menu = projectTierMenuFromConfig(aliased, sha256Hex);
    expect(menu).not.toBeNull();
    expect(menu!.items[0].whenToUse).toContain("read logs");
  });

  it("still handles the Standalone config array, computing a revision from it", () => {
    const menu = projectTierMenuFromConfig(STANDALONE_CONFIG, sha256Hex);
    expect(menu).not.toBeNull();
    expect(menu!.revision).toBe(sha256Hex(canonicalTierConfig(STANDALONE_CONFIG)));
    expect(menu!.items.map((i) => i.tier)).toEqual(["fast", "deep"]);
  });

  it("never leaks provider or modelId, whichever shape it came from", () => {
    for (const input of [UPSTREAM_PROJECTED_MENU, STANDALONE_CONFIG]) {
      const serialized = JSON.stringify(projectTierMenuFromConfig(input, sha256Hex));
      expect(serialized).not.toContain("p-a");
      expect(serialized).not.toContain("m-1");
      expect(serialized).not.toContain("provider");
      expect(serialized).not.toContain("modelId");
    }
  });

  it("renders a usable description passage from the upstream shape", () => {
    // End of the chain: if this is empty the lead never learns the feature exists,
    // which is how the original mismatch presented.
    const menu = projectTierMenuFromConfig(UPSTREAM_PROJECTED_MENU, sha256Hex);
    const text = renderTierMenuForDescription(menu);
    expect(text).toContain("model_tier");
    expect(text).toContain("fast —");
    expect(text).toContain("deep —");
  });

  it("normalizes the upstream menu directly too (tools-channel path)", () => {
    // The same payload also travels Gateway → AgentBox, where the box normalizes
    // whatever arrives. Both entry points must accept it.
    const result = normalizeSubagentTierMenu(UPSTREAM_PROJECTED_MENU);
    expect(result.ok).toBe(true);
  });

  it("rejects an upstream menu whose revision is not 64 lowercase hex", () => {
    // Contract, not preference: the two channels compare revisions literally.
    const bad = { ...UPSTREAM_PROJECTED_MENU, revision: "not-a-sha" };
    expect(projectTierMenuFromConfig(bad, sha256Hex)).toBeNull();
  });

  it("treats null/absent as a clear on both shapes", () => {
    expect(projectTierMenuFromConfig(null, sha256Hex)).toBeNull();
    expect(projectTierMenuFromConfig(undefined, sha256Hex)).toBeNull();
    expect(projectTierMenuFromConfig({ revision: REV, items: [] }, sha256Hex)).toBeNull();
  });
});

describe("the fixture PAYLOAD is pinned, so cross-repo drift is detectable", () => {
  /**
   * Digest of the canonicalized PAYLOAD — commentary excluded, keys sorted.
   *
   * Whole-file digests were the wrong comparison and could never have worked: the
   * two repositories carry the same payloads under different prose, each side
   * documenting it for its own readers, so the files differ for reasons unrelated
   * to the contract and each side ends up pinning a value only it can satisfy.
   * That is two independent constants, not a shared contract.
   *
   * This value is CROSS-REPO COMPARABLE. Any implementation that canonicalizes the
   * same way lands on the same string; in Go, unmarshalling into a map and
   * re-marshalling sorts the keys for you.
   */
  const EXPECTED_PAYLOAD_SHA256 = "de8aa805a00228e637f47d7480940f89361ba35de255ae9e8f76d6c2c31b7e4e";

  it("has not drifted without the digest being updated", () => {
    const actual = crypto.createHash("sha256")
      .update(canonicalFixturePayload(golden))
      .digest("hex");
    expect(
      actual,
      "fixture payload changed — update EXPECTED_PAYLOAD_SHA256 and propagate the same payload to the other implementation",
    ).toBe(EXPECTED_PAYLOAD_SHA256);
  });

  it("ignores commentary, so each side can document it in its own words", () => {
    // The whole reason the previous whole-file pinning was useless. Prose is not
    // contract; a differing header must not read as a differing contract.
    const withOtherProse = { ...golden, _comment: ["entirely different wording"], _rules: [] };
    expect(canonicalFixturePayload(withOtherProse)).toBe(canonicalFixturePayload(golden));
  });

  it("does NOT ignore a payload change", () => {
    // The guard has to bite on the thing it exists for.
    const tampered = JSON.parse(JSON.stringify(golden));
    tampered.config_getAgent.subagent_model_tiers.items[0].tier = "renamed";
    expect(canonicalFixturePayload(tampered)).not.toBe(canonicalFixturePayload(golden));
  });

  it("does not try to carry its own digest", () => {
    // A digest over the file cannot live inside it. Published here and referenced
    // from the fixture header; the other side computes it the same way.
    expect(Object.keys(golden).some((k) => k.toLowerCase().includes("sha"))).toBe(false);
  });
});

describe("the shared rules hold on this side", () => {
  // The producer's copy states the rules as PROSE in `_rules`. Asserting against
  // prose is not possible, so these check the behaviours it describes — the point
  // being that a rule changed on that side should fail something here rather than
  // only surfacing in production.

  it("enforces the tier pattern and the cap it declares", () => {
    const at = "a".repeat(32);
    const past = "a".repeat(33);
    expect(normalizeSubagentTierConfig([
      { tier: at, provider: "p", modelId: "m", whenToUse: "read logs and summarise" },
    ]).ok).toBe(true);
    expect(normalizeSubagentTierConfig([
      { tier: past, provider: "p", modelId: "m", whenToUse: "read logs and summarise" },
    ]).ok).toBe(false);

    const overCap = Array.from({ length: MAX_SUBAGENT_TIERS + 1 }, (_, i) => ({
      tier: `t${i}`, provider: "p", modelId: `m${i}`, whenToUse: "read logs and summarise",
    }));
    expect(normalizeSubagentTierConfig(overCap).ok).toBe(false);
  });

  it("enforces the whenToUse ceiling it declares", () => {
    const tooLong = "x".repeat(WHEN_TO_USE_MAX_CHARS + 1);
    expect(normalizeSubagentTierMenu({
      revision: REV,
      items: [{ tier: "fast", whenToUse: tooLong }],
    }).ok).toBe(false);
  });

  it("keeps the menu free of every field the rules forbid on it", () => {
    // "The menu never carries provider, modelId, modelConfig or any credential —
    // it is rendered into a tool description, i.e. into a prompt."
    const serialized = JSON.stringify(projectTierMenuFromConfig(STANDALONE_CONFIG, sha256Hex));
    for (const forbidden of ["provider", "modelId", "modelConfig", "apiKey", "p-a", "m-1"]) {
      expect(serialized, `menu must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("treats an empty envelope as malformed, not as a clear", () => {
    // "No tiers is expressed by OMITTING the field, never by an envelope with an
    // empty list."
    expect(normalizeSubagentTierMenu({ revision: REV, items: [] }).ok).toBe(false);
    expect(projectTierMenuFromConfig(undefined, sha256Hex)).toBeNull();
  });

  it("never requires whenToUse on the candidate half", () => {
    // "The candidates never carry whenToUse."
    expect(JSON.stringify(UPSTREAM_CANDIDATES)).not.toContain("whenToUse");
    expect(normalizeSubagentTierCandidates(UPSTREAM_CANDIDATES).ok).toBe(true);
  });

  it("treats provider as opaque — it is never parsed or pattern-matched", () => {
    // Which is what makes neutral sample values in this repo's copy cost nothing.
    const odd = {
      revision: REV,
      candidates: [{
        tier: "fast",
        provider: "!!! not a normal name @@@",
        modelId: "m",
        modelConfig: { apiKey: "k", models: [] },
      }],
    };
    expect(normalizeSubagentTierCandidates(odd).ok).toBe(true);
  });
});
