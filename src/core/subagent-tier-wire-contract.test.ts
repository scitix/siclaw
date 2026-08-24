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
import {
  canonicalTierConfig,
  normalizeSubagentTierMenu,
  projectTierMenuFromConfig,
  renderTierMenuForDescription,
} from "./subagent-models.js";

const sha256Hex = (input: string) => crypto.createHash("sha256").update(input).digest("hex");
const REV = "b3f1".padEnd(64, "0");

/**
 * Upstream mode: the control plane projects the menu itself and sends
 * `{revision, items}` with snake_case field names — the convention every other
 * field on this RPC uses (`tool_capabilities`, `agent_type`, `model_provider`).
 */
const UPSTREAM_PROJECTED_MENU = {
  revision: REV,
  items: [
    { tier: "fast", when_to_use: "read logs, grep code, check config — retrieval and summary" },
    { tier: "deep", when_to_use: "cross-source causal reasoning, or a conclusion a human reads" },
  ],
};

/** Standalone: the raw config array, camelCase, with provider/modelId present. */
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

  it("accepts snake_case when_to_use, since that RPC is snake_case throughout", () => {
    const menu = projectTierMenuFromConfig(UPSTREAM_PROJECTED_MENU, sha256Hex);
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
