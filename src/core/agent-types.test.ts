import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  AGENT_TYPES,
  COMPLETE_CATALOG_KNOWLEDGE_QA_DEFAULT_PROMPT,
  LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT,
  PREVIOUS_KNOWLEDGE_QA_DEFAULT_PROMPT,
  PRODUCT_SUPPORT_DEFAULT_PROMPT,
  normalizeAgentType,
  requireAgentType,
  effectiveAgentPrompt,
  effectiveCapabilityKeys,
  resolveAgentPromptLayers,
} from "./agent-types.js";

describe("agent-types", () => {
  it("has the four designed types; built-ins lock capabilities and own their runtime contracts", () => {
    expect(Object.keys(AGENT_TYPES).sort()).toEqual(["custom", "knowledge_qa", "product_support", "sre"]);
    expect(AGENT_TYPES.sre.capabilities).toBeTruthy();
    expect(AGENT_TYPES.sre.defaultPrompt).toBeTruthy();
    expect(AGENT_TYPES.knowledge_qa.capabilities).toEqual(["read_files"]);
    expect(AGENT_TYPES.knowledge_qa.defaultPrompt).toBeTruthy();
    expect(AGENT_TYPES.knowledge_qa.defaultNoSkills).toBe(true);
    expect(AGENT_TYPES.product_support.capabilities).toEqual(["read_files"]);
    expect(AGENT_TYPES.product_support.defaultPrompt).toBe(PRODUCT_SUPPORT_DEFAULT_PROMPT);
    expect(AGENT_TYPES.product_support.defaultNoSkills).toBe(true);
    expect(AGENT_TYPES.custom.capabilities).toBeNull();
    expect(AGENT_TYPES.custom.defaultPrompt).toBeNull();
  });

  it("the Portal mirror matches this registry (locked capabilities + description)", () => {
    // portal-web/src/lib/agentTypes.ts duplicates the locked capability lists and
    // descriptions for the type picker, and its own header says to keep them in
    // sync. It drifted once: the coordinator kept advertising "read-only router"
    // and `search_memory` after both changed here, which tells operators the
    // wrong thing about an agent they are configuring. Read as text rather than
    // imported so no build boundary is crossed, and resolved relative to THIS
    // file so a checked-out copy compares against its own sibling mirror.
    const mirror = readFileSync(
      new URL("../../portal-web/src/lib/agentTypes.ts", import.meta.url),
      "utf8",
    );
    for (const [key, def] of Object.entries(AGENT_TYPES)) {
      const block = mirror.split(`key: "${key}"`)[1]?.split("},")[0];
      expect(block, `no ${key} block in the Portal mirror`).toBeTruthy();
      expect(block).toContain(def.description);
      const mirrored = [...(block!.match(/capabilities: \[([^\]]*)\]/)?.[1] ?? "")
        .matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(mirrored, `${key} capabilities drifted`).toEqual(def.capabilities ?? []);
    }
  });

  it("normalizeAgentType defaults unknown/absent to custom", () => {
    expect(normalizeAgentType("sre")).toBe("sre");
    expect(() => normalizeAgentType("coordinator")).toThrow("retired");
    expect(() => requireAgentType("coordinator")).toThrow("retired");
    expect(normalizeAgentType("knowledge_qa")).toBe("knowledge_qa");
    expect(normalizeAgentType("product_support")).toBe("product_support");
    expect(normalizeAgentType("custom")).toBe("custom");
    expect(normalizeAgentType(undefined)).toBe("custom");
    expect(normalizeAgentType("bogus")).toBe("custom");
  });

  it("requireAgentType accepts product_support at the fail-closed harness boundary", () => {
    expect(requireAgentType("product_support")).toBe("product_support");
    expect(() => requireAgentType("future_type")).toThrow("Invalid or missing agent_type");
  });

  it("effectiveCapabilityKeys: built-in types override, custom uses own selection", () => {
    expect(effectiveCapabilityKeys("sre", null)).toEqual(AGENT_TYPES.sre.capabilities);
    expect(effectiveCapabilityKeys("knowledge_qa", ["run_commands"])).toEqual(["read_files"]);
    expect(effectiveCapabilityKeys("product_support", ["run_commands"])).toEqual(["read_files"]);
    expect(effectiveCapabilityKeys("custom", ["read_files"])).toEqual(["read_files"]);
    expect(effectiveCapabilityKeys("custom", null)).toBeNull();
  });

  it("keeps the compatibility text helper while layering authored specialization", () => {
    expect(effectiveAgentPrompt("knowledge_qa", "maintainer truth")).toBe("maintainer truth");
    expect(effectiveAgentPrompt("knowledge_qa", null)).toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("knowledge_qa", "Prefer concise Chinese answers.")).toBe("Prefer concise Chinese answers.");
    expect(effectiveAgentPrompt("knowledge_qa", null)).toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("custom", "custom truth")).toBe("custom truth");
    expect(effectiveAgentPrompt("custom", "")).toBeUndefined();

    expect(resolveAgentPromptLayers("knowledge_qa", "maintainer truth")).toEqual({
      typeContract: AGENT_TYPES.knowledge_qa.defaultPrompt,
      addendum: "maintainer truth",
    });
    expect(resolveAgentPromptLayers("product_support", "Managed business contract")).toEqual({
      typeContract: PRODUCT_SUPPORT_DEFAULT_PROMPT,
      addendum: "Managed business contract",
    });
    expect(resolveAgentPromptLayers("product_support", "")).toEqual({
      typeContract: PRODUCT_SUPPORT_DEFAULT_PROMPT,
      addendum: undefined,
    });
    expect(resolveAgentPromptLayers("custom", "custom truth")).toEqual({ addendum: "custom truth" });
  });

  it("upgrades only exact materialized Knowledge QA defaults", () => {
    expect(effectiveAgentPrompt("knowledge_qa", LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT))
      .toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("knowledge_qa", PREVIOUS_KNOWLEDGE_QA_DEFAULT_PROMPT))
      .toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("knowledge_qa", COMPLETE_CATALOG_KNOWLEDGE_QA_DEFAULT_PROMPT))
      .toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(resolveAgentPromptLayers("knowledge_qa", LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT)).toEqual({
      typeContract: AGENT_TYPES.knowledge_qa.defaultPrompt,
      addendum: undefined,
    });
    expect(effectiveAgentPrompt("knowledge_qa", `${LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT} Edited`))
      .toBe(`${LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT} Edited`);
  });
});
