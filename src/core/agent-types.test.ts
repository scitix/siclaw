import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  AGENT_TYPES,
  COORDINATOR_DEFAULT_PROMPT,
  SRE_DEFAULT_PROMPT,
  normalizeAgentType,
  effectiveAgentPrompt,
  effectiveCapabilityKeys,
} from "./agent-types.js";

describe("agent-types", () => {
  it("has the four designed types; built-ins lock caps and supply editable prompt defaults", () => {
    expect(Object.keys(AGENT_TYPES).sort()).toEqual(["coordinator", "custom", "knowledge_qa", "sre"]);
    expect(AGENT_TYPES.sre.capabilities).toBeTruthy();
    expect(AGENT_TYPES.sre.defaultPrompt).toBeTruthy();
    expect(AGENT_TYPES.coordinator.capabilities).toContain("delegate_agents");
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

  it("effectiveAgentPrompt: persisted prompt replaces the built-in default", () => {
    expect(effectiveAgentPrompt("coordinator", "maintainer truth")).toBe("maintainer truth");
    expect(effectiveAgentPrompt("coordinator", null)).toBe(AGENT_TYPES.coordinator.defaultPrompt);
    expect(effectiveAgentPrompt("knowledge_qa", "Prefer concise Chinese answers.")).toBe("Prefer concise Chinese answers.");
    expect(effectiveAgentPrompt("knowledge_qa", null)).toBe(AGENT_TYPES.knowledge_qa.defaultPrompt);
    expect(effectiveAgentPrompt("custom", "custom truth")).toBe("custom truth");
    expect(effectiveAgentPrompt("custom", "")).toBeUndefined();
  });

  // ── Digest tripwire ──────────────────────────────────────────────────────────
  // Deliberately the kind of test that breaks on every rewording. It asserts NOTHING about whether
  // the wording is good — only that a change to it was acknowledged. The coordinator prompt has a
  // second copy outside this repository (see the comment on the constant), and a one-sided edit is
  // otherwise caught by nothing at all. Known limitation: this can only see THIS side change.
  it("COORDINATOR_DEFAULT_PROMPT digest — update BOTH copies when this fails", () => {
    const digest = createHash("sha256").update(COORDINATOR_DEFAULT_PROMPT, "utf8").digest("hex");
    expect(
      digest,
      "COORDINATOR_DEFAULT_PROMPT changed. If that is deliberate: (1) update this digest, and " +
        "(2) make the SAME edit to the management plane's default-coordinator-prompt constant — " +
        "otherwise deployed coordinators keep the old text and this change does nothing. See " +
        "docs/design/2026-08-25-coordinator-prompt-proposal.md.",
    ).toBe("54d571595621122bda50c37815424311891709ec86cbf7d95f7bdeb01b1cd210");
  });

  it("the continuation rule is coordinator-scoped and carves out input-required", () => {
    // Scope: editing the coordinator's constant must not reach the SRE agent. Asserted by digest so
    // that an accidental edit to SRE_DEFAULT_PROMPT fails here rather than shipping silently.
    expect(createHash("sha256").update(SRE_DEFAULT_PROMPT, "utf8").digest("hex")).toBe(
      "5aa1d8449c26501f38bd573f8f300076dfed8b76664633f517c6961392fd87d4",
    );
    expect(SRE_DEFAULT_PROMPT).not.toContain("session_id");

    // The carve-out is the load-bearing half: a returned question is exactly the shape the
    // continuation rule fires on (a delegation that came back without findings), so without it the
    // rule instructs the coordinator to continue a session that is waiting on the USER — which ends
    // with it inventing an answer and reporting a conclusion built on it.
    expect(COORDINATOR_DEFAULT_PROMPT).toContain("asking for the completed result");
    expect(COORDINATOR_DEFAULT_PROMPT).toContain("a returned question belongs to the USER");
    expect(COORDINATOR_DEFAULT_PROMPT).toContain("do not answer on the user's behalf");
  });
});
