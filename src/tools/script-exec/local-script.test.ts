import { describe, it, expect } from "vitest";
import { createLocalScriptTool } from "./local-script.js";

describe("createLocalScriptTool", () => {
  const tool = createLocalScriptTool();

  it("has correct name (local_script, not run_skill)", () => {
    expect(tool.name).toBe("local_script");
  });

  it("has correct label", () => {
    expect(tool.label).toBe("Local Script");
  });

  it("rejects missing skill parameter", async () => {
    const result = await tool.execute(
      "test-id",
      { skill: "", script: "test.sh" },
      undefined,
      {} as any
    );
    const text = (result.content as any)[0].text;
    expect(text).toContain("Error");
  });

  it("rejects missing script parameter", async () => {
    const result = await tool.execute(
      "test-id",
      { skill: "test-skill", script: "" },
      undefined,
      {} as any
    );
    const text = (result.content as any)[0].text;
    expect(text).toContain("Error");
  });

  it("rejects path traversal in skill name", async () => {
    const result = await tool.execute(
      "test-id",
      { skill: "../evil", script: "test.sh" },
      undefined,
      {} as any
    );
    const text = (result.content as any)[0].text;
    expect(text).toContain("path separator");
  });

  it("uses the Session-scoped script resolver instead of process-global Skills", async () => {
    const isolatedTool = createLocalScriptTool(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        resolveSkillScript: () => null,
        listSkillScripts: () => ["agent-only.sh"],
        listAllSkillsWithScripts: () => [],
        skillMdHint: () => "",
      } as any,
    );

    const result = await isolatedTool.execute(
      "test-id",
      { skill: "personal", script: "missing.sh" },
      undefined,
      {} as any,
    );
    expect((result.content as any)[0].text).toContain("agent-only.sh");
  });
});
