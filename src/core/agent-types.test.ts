import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  AGENT_TYPES,
  LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT,
  PREVIOUS_KNOWLEDGE_QA_DEFAULT_PROMPT,
  normalizeAgentType,
  effectiveAgentPrompt,
  effectiveCapabilityKeys,
  resolveAgentPromptLayers,
} from "./agent-types.js";

describe("agent-types", () => {
  it("has the four designed types; built-ins lock capabilities and own immutable contracts", () => {
    expect(Object.keys(AGENT_TYPES).sort()).toEqual(["coordinator", "custom", "knowledge_qa", "sre"]);
    expect(AGENT_TYPES.sre.capabilities).toBeTruthy();
    expect(AGENT_TYPES.sre.defaultPrompt).toBeTruthy();
    expect(AGENT_TYPES.coordinator.capabilities).toContain("delegate_agents");
    expect(AGENT_TYPES.coordinator.capabilities).not.toContain("inspect_infra");
    expect(AGENT_TYPES.coordinator.capabilities).not.toContain("run_commands");
    expect(AGENT_TYPES.coordinator.defaultNoSkills).toBe(true);
    expect(AGENT_TYPES.knowledge_qa.capabilities).toEqual(["read_files"]);
    expect(AGENT_TYPES.knowledge_qa.defaultPrompt).toBeTruthy();
    expect(AGENT_TYPES.knowledge_qa.defaultNoSkills).toBe(true);
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

  it("coordinator does not reach for memory (disabled fleet-wide)", () => {
    // Asserted as structure and as an ABSENCE, so it survives any rewording of
    // the prompt. The answer/route contract itself lives in
    // docs/design/coordinator-routing.md — pinning its prose here would only
    // restate the diff and would break on every future improvement.
    expect(AGENT_TYPES.coordinator.capabilities).not.toContain("search_memory");
    expect(AGENT_TYPES.coordinator.defaultPrompt).not.toContain("search_memory");
  });

  it("normalizeAgentType defaults unknown/absent to custom", () => {
    expect(normalizeAgentType("sre")).toBe("sre");
    expect(normalizeAgentType("coordinator")).toBe("coordinator");
    expect(normalizeAgentType("knowledge_qa")).toBe("knowledge_qa");
    expect(normalizeAgentType("custom")).toBe("custom");
    expect(normalizeAgentType(undefined)).toBe("custom");
    expect(normalizeAgentType("bogus")).toBe("custom");
  });

  it("effectiveCapabilityKeys: built-in types override, custom uses own selection", () => {
    expect(effectiveCapabilityKeys("coordinator", ["run_commands"])).toEqual(AGENT_TYPES.coordinator.capabilities);
    expect(effectiveCapabilityKeys("sre", null)).toEqual(AGENT_TYPES.sre.capabilities);
    expect(effectiveCapabilityKeys("knowledge_qa", ["run_commands"])).toEqual(["read_files"]);
    expect(effectiveCapabilityKeys("custom", ["read_files"])).toEqual(["read_files"]);
    expect(effectiveCapabilityKeys("custom", null)).toBeNull();
  });

  it("keeps the compatibility text helper while layering authored specialization", () => {
    expect(effectiveAgentPrompt("coordinator", "maintainer truth")).toBe("maintainer truth");
    expect(effectiveAgentPrompt("coordinator", null)).toBe(AGENT_TYPES.coordinator.defaultPrompt);
    expect(effectiveAgentPrompt("knowledge_qa", "Prefer concise Chinese answers.")).toBe("Prefer concise Chinese answers.");
    expect(effectiveAgentPrompt("knowledge_qa", null)).toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("custom", "custom truth")).toBe("custom truth");
    expect(effectiveAgentPrompt("custom", "")).toBeUndefined();

    expect(resolveAgentPromptLayers("coordinator", "maintainer truth")).toEqual({
      typeContract: AGENT_TYPES.coordinator.defaultPrompt,
      addendum: "maintainer truth",
    });
    expect(resolveAgentPromptLayers("custom", "custom truth")).toEqual({ addendum: "custom truth" });
  });
  it("upgrades only exact materialized Knowledge QA defaults", () => {
    expect(effectiveAgentPrompt("knowledge_qa", LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT))
      .toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("knowledge_qa", PREVIOUS_KNOWLEDGE_QA_DEFAULT_PROMPT))
      .toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(resolveAgentPromptLayers("knowledge_qa", LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT)).toEqual({
      typeContract: AGENT_TYPES.knowledge_qa.defaultPrompt,
      addendum: undefined,
    });
    expect(effectiveAgentPrompt("knowledge_qa", `${LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT} Edited`))
      .toBe(`${LEGACY_KNOWLEDGE_QA_DEFAULT_PROMPT} Edited`);
  });
});
