import { describe, it, expect } from "vitest";
import { toolSemantics, commonMistakes } from "./sre-knowledge.js";

// Broader coverage lives in deep-search.test.ts. This file adds
// structural/contract assertions to guard against regression if
// someone removes the bash/node_exec/pod_exec/read mentions.

describe("toolSemantics — contract", () => {
  it("describes all three exec tools (bash, node_exec, pod_exec)", () => {
    const s = toolSemantics();
    expect(s).toContain("### bash tool");
    expect(s).toContain("### node_exec tool");
    expect(s).toContain("pod_exec");
  });

  it("calls out the read tool", () => {
    expect(toolSemantics()).toContain("### read tool");
  });

  it("warns that node_exec has NO pipes", () => {
    expect(toolSemantics()).toContain("NO pipes");
  });

  it("mentions whitelisted read-only commands for node_exec", () => {
    expect(toolSemantics()).toContain("whitelisted");
  });

  it("prefers skill scripts over raw commands", () => {
    expect(toolSemantics()).toContain("skill");
  });
});

describe("commonMistakes — contract", () => {
  it("enumerates at least 5 labelled mistakes", () => {
    const m = commonMistakes();
    expect(m).toMatch(/1\.\s/);
    expect(m).toMatch(/2\.\s/);
    expect(m).toMatch(/3\.\s/);
    expect(m).toMatch(/4\.\s/);
    expect(m).toMatch(/5\.\s/);
  });

  it("distinguishes WRONG vs RIGHT patterns", () => {
    const m = commonMistakes();
    expect(m).toContain("WRONG:");
    expect(m).toContain("RIGHT:");
  });

  it("instructs reading SKILL.md", () => {
    expect(commonMistakes()).toContain("SKILL.md");
  });
});
