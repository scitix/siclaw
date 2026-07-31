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

  it("coordinator keeps its triage invisible — the reply must not narrate its own rules", () => {
    // Observed in a real Feishu reply: "这是知识性问题,我已从内部知识库查到原理" and
    // "由于我是协调者,不做直接的 hands-on 诊断". The user asked about RoCE, not about
    // how the bot decides things.
    const persona = AGENT_TYPES.coordinator.persona!;
    expect(persona).toContain("KEEP THIS TRIAGE INVISIBLE");
    expect(persona).toContain("never announce which mode you picked");
    // On failure, report the outcome the user needs — not the role that blocks it.
    expect(persona).toContain("state the OUTCOME the user needs");
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
