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

  it("coordinator does not reach for memory (disabled fleet-wide)", () => {
    // Asserted as structure and as an ABSENCE, so it survives any rewording of
    // the persona. The answer/route contract itself lives in
    // docs/design/coordinator-routing.md — pinning its prose here would only
    // restate the diff and would break on every future improvement.
    expect(AGENT_TYPES.coordinator.capabilities).not.toContain("search_memory");
    expect(AGENT_TYPES.coordinator.persona).not.toContain("search_memory");
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
