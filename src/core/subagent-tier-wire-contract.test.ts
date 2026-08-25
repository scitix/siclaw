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
  canonicalTierConfig,
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

/** Upstream mode: the producer projects, and uses this RPC's snake_case convention. */
const UPSTREAM_PROJECTED_MENU = golden.projectedMenu;
const REV: string = golden.projectedMenu.revision;

/** Standalone: the raw config array, camelCase, with provider/modelId present. */
const STANDALONE_CONFIG = golden.configArray.value;

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
    const menu = projectTierMenuFromConfig(UPSTREAM_PROJECTED_MENU, sha256Hex);
    expect(menu!.items[0].whenToUse).toContain("read logs");
    expect(golden.rules.whenToUseCanonicalKey).toBe("whenToUse");
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

describe("the golden fixture matches what this implementation enforces", () => {
  // The fixture states the rules as DATA so neither implementation can quietly
  // relax one. If a constant here moves, this fails and the fixture (and the
  // other repository) has to be updated deliberately.
  const rules = golden.rules;

  it("agrees on the tier pattern, the cap and the whenToUse bounds", () => {
    expect(rules.maxTiers).toBe(MAX_SUBAGENT_TIERS);
    expect(rules.whenToUseMaxCodePoints).toBe(WHEN_TO_USE_MAX_CHARS);

    // A tier at the pattern's limits is accepted; one past them is not.
    const at = "a".repeat(32);
    const past = "a".repeat(33);
    expect(new RegExp(rules.tierPattern).test(at)).toBe(true);
    expect(new RegExp(rules.tierPattern).test(past)).toBe(false);
  });

  it("agrees that both whenToUse spellings are accepted", () => {
    for (const key of rules.whenToUseAcceptedKeys) {
      const menu = projectTierMenuFromConfig(
        { revision: REV, items: [{ tier: "fast", [key]: "read logs and summarise findings" }] },
        sha256Hex,
      );
      expect(menu, `key ${key}`).not.toBeNull();
    }
  });

  it("agrees that the menu never carries the candidate-only fields", () => {
    const serialized = JSON.stringify(projectTierMenuFromConfig(STANDALONE_CONFIG, sha256Hex));
    for (const forbidden of rules.menuMustNotContain) {
      expect(serialized, `menu must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("agrees that an empty items array is malformed rather than a clear", () => {
    expect(rules.emptyItemsIsMalformed).toBe(true);
    expect(normalizeSubagentTierMenu({ revision: REV, items: [] }).ok).toBe(false);
  });
});
