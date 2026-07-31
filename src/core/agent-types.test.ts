import { describe, it, expect } from "vitest";
import { AGENT_TYPES, normalizeAgentType, effectiveAgentPrompt, effectiveCapabilityKeys } from "./agent-types.js";

describe("agent-types", () => {
  it("has the three designed types; built-ins lock caps and supply editable prompt defaults", () => {
    expect(Object.keys(AGENT_TYPES).sort()).toEqual(["coordinator", "custom", "sre"]);
    expect(AGENT_TYPES.sre.capabilities).toBeTruthy();
    expect(AGENT_TYPES.sre.defaultPrompt).toBeTruthy();
    expect(AGENT_TYPES.coordinator.capabilities).toContain("delegate_agents");
    expect(AGENT_TYPES.coordinator.capabilities).not.toContain("run_commands");
    expect(AGENT_TYPES.coordinator.defaultNoSkills).toBe(true);
    expect(AGENT_TYPES.custom.capabilities).toBeNull();
    expect(AGENT_TYPES.custom.defaultPrompt).toBeNull();
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

  it("effectiveAgentPrompt: persisted prompt replaces the built-in default", () => {
    expect(effectiveAgentPrompt("coordinator", "maintainer truth")).toBe("maintainer truth");
    expect(effectiveAgentPrompt("coordinator", null)).toBe(AGENT_TYPES.coordinator.defaultPrompt);
    expect(effectiveAgentPrompt("custom", "custom truth")).toBe("custom truth");
    expect(effectiveAgentPrompt("custom", "")).toBeUndefined();
  });
});
