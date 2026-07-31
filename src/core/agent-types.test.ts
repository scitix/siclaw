import { describe, it, expect } from "vitest";
import { AGENT_TYPES, normalizeAgentType, effectiveCapabilityKeys } from "./agent-types.js";

describe("agent-types", () => {
  it("has the three designed types; sre/coordinator lock caps+persona, custom does not", () => {
    expect(Object.keys(AGENT_TYPES).sort()).toEqual(["coordinator", "custom", "sre"]);
    expect(AGENT_TYPES.sre.capabilities).toBeTruthy();
    expect(AGENT_TYPES.sre.persona).toBeTruthy();
    expect(AGENT_TYPES.coordinator.capabilities).toContain("delegate_agents");
    expect(AGENT_TYPES.coordinator.capabilities).not.toContain("run_commands");
    expect(AGENT_TYPES.coordinator.defaultNoSkills).toBe(true);
    expect(AGENT_TYPES.custom.capabilities).toBeNull();
    expect(AGENT_TYPES.custom.persona).toBeNull();
  });

  it("coordinator is dual-mode (answer from knowledge OR route) and no longer uses memory", () => {
    const persona = AGENT_TYPES.coordinator.persona!;
    // (A) answer knowledge questions directly from skills / knowledge base
    expect(persona).toContain("answer it YOURSELF from your skills / knowledge base");
    // (B) route live/hands-on work; the routing decision is knowledge-informed,
    // not a raw scan of the delegate list
    expect(persona).toContain("To ROUTE:");
    expect(persona).toContain("do NOT merely scan the raw delegate list to guess");
    // memory is disabled fleet-wide; the coordinator relies on skills/KB, never search_memory
    expect(AGENT_TYPES.coordinator.capabilities).not.toContain("search_memory");
    expect(persona).not.toContain("search_memory");
  });

  it("normalizeAgentType defaults unknown/absent to custom", () => {
    expect(normalizeAgentType("sre")).toBe("sre");
    expect(normalizeAgentType("coordinator")).toBe("coordinator");
    expect(normalizeAgentType("custom")).toBe("custom");
    expect(normalizeAgentType(undefined)).toBe("custom");
    expect(normalizeAgentType("bogus")).toBe("custom");
  });

  it("effectiveCapabilityKeys: built-in types override, custom uses own selection", () => {
    expect(effectiveCapabilityKeys("coordinator", ["run_commands"])).toEqual(AGENT_TYPES.coordinator.capabilities);
    expect(effectiveCapabilityKeys("sre", null)).toEqual(AGENT_TYPES.sre.capabilities);
    expect(effectiveCapabilityKeys("custom", ["read_files"])).toEqual(["read_files"]);
    expect(effectiveCapabilityKeys("custom", null)).toBeNull();
  });
});
