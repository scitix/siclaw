import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createSkillPreviewTool, registration } from "./skill-preview.js";
import { ToolResultArtifactStore, withToolResultArtifactCapture } from "../../core/tool-result-artifact.js";
import os from "node:os";
import { persistableToolDetails } from "../../shared/tool-result-metadata.js";
import { MAX_PREVIEW_METADATA_BYTES } from "../../shared/skill-preview-storage.js";

/** Tests write to the real DRAFTS_BASE (.siclaw/user-data/skill-drafts/) under cwd,
 *  matching production behavior. Each test creates a unique subdirectory and
 *  the tool cleans it up after reading. afterEach ensures cleanup on failure. */
const DRAFTS_BASE = path.resolve(process.cwd(), ".siclaw/user-data/skill-drafts");

describe("skill_preview tool", () => {
  let testSkillDir: string;
  let tool: ReturnType<typeof createSkillPreviewTool>;

  beforeEach(() => {
    tool = createSkillPreviewTool();
    // Each test gets a unique skill name under DRAFTS_BASE
    const uniqueName = `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    testSkillDir = path.join(DRAFTS_BASE, uniqueName);
    fs.mkdirSync(testSkillDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testSkillDir)) {
      fs.rmSync(testSkillDir, { recursive: true, force: true });
    }
  });

  function exec(params: Record<string, unknown>) {
    return tool.execute("test-id", params, undefined, {} as any);
  }

  function writeSkill(skillMd: string, scripts?: Array<{ name: string; content: string }>) {
    fs.writeFileSync(path.join(testSkillDir, "SKILL.md"), skillMd, "utf-8");
    if (scripts) {
      const scriptsDir = path.join(testSkillDir, "scripts");
      fs.mkdirSync(scriptsDir, { recursive: true });
      for (const s of scripts) {
        fs.writeFileSync(path.join(scriptsDir, s.name), s.content, "utf-8");
      }
    }
    return testSkillDir;
  }

  it("keeps complete preview files in details when artifact capture bounds the model text", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-skill-preview-"));
    const store = new ToolResultArtifactStore({ rootDir: root, getScope: () => ({ agentId: "a", sessionId: "s" }) });
    const specs = "---\nname: large-preview\ndescription: Complete preview regression\n---\n" + "Read-only procedure.\n".repeat(800) + "END_OF_SKILL";
    const script = "#!/bin/sh\nprintf 'PREVIEW_SCRIPT_END'\n";
    writeSkill(specs, [{ name: "check.sh", content: script }]);
    try {
      await store.initialize();
      const wrapped = withToolResultArtifactCapture(tool, store, 4096);
      const result = await wrapped.execute("preview-call", { dir: testSkillDir }, undefined, {} as any);
      const text = result.content.filter(b => b.type === "text").map(b => b.text).join("");
      expect(text.length).toBeLessThanOrEqual(8000);
      expect(text).toContain("artifact_id:");
      const details = JSON.parse(JSON.stringify(result.details)); // SSE/DB round trip
      expect(details.skillPreview.skill.specs).toBe(specs);
      expect(details.skillPreview.skill.files.find((f: any) => f.path === "SKILL.md").content).toBe(specs);
      expect(details.skillPreview.skill.files.find((f: any) => f.path === "scripts/check.sh").content).toBe(script);
      expect(fs.existsSync(testSkillDir)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ["ascii", "x".repeat(1_150_000)],
    ["utf8", "界".repeat(400_000)],
    ["escaped JSON", '"'.repeat(550_000)],
  ])("reports an omitted %s preview to the model before artifact capture", async (_kind, reference) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-preview-limit-"));
    const store = new ToolResultArtifactStore({ rootDir: root, getScope: () => ({ agentId: "a", sessionId: "s" }) });
    writeSkill("---\nname: oversized-preview\ndescription: Preview limit regression\n---\n# Draft\n");
    fs.mkdirSync(path.join(testSkillDir, "references"));
    fs.writeFileSync(path.join(testSkillDir, "references", "notes.txt"), reference + "END_OF_OVERSIZED_REFERENCE");
    try {
      await store.initialize();
      const wrapped = withToolResultArtifactCapture(tool, store, 4096);
      const result = await wrapped.execute("preview-limit", { dir: testSkillDir }, undefined, {} as any);
      const text = result.content.filter(b => b.type === "text").map(b => b.text).join("");
      const modelResult = JSON.parse(text);
      expect(modelResult).toMatchObject({ error: true, status: "omitted", reason: "size_limit", limitBytes: MAX_PREVIEW_METADATA_BYTES });
      expect(modelResult.summary).toContain("smaller preview");
      expect(text).not.toContain("Click View");
      expect(text).not.toContain("END_OF_OVERSIZED_REFERENCE");
      expect(result.details).toHaveProperty("error", true);
      expect(result.details).not.toHaveProperty("toolResultArtifact");
      const saved = persistableToolDetails(result.details);
      expect(saved?.skillPreview).toMatchObject({ status: "omitted", reason: modelResult.reason, name: modelResult.name });
      expect(saved?.skillPreview).not.toHaveProperty("skill");
      expect(fs.existsSync(testSkillDir)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  // --- Validation ---

  it("returns error for empty dir", async () => {
    const result = await exec({ dir: "" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("dir is required");
    expect(result.details).toHaveProperty("error", true);
  });

  it("returns error for non-existent directory", async () => {
    const result = await exec({ dir: path.join(DRAFTS_BASE, "nonexistent-12345") });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("Directory not found");
  });

  it("returns error when SKILL.md is missing", async () => {
    // testSkillDir exists but has no SKILL.md
    const emptyDir = path.join(DRAFTS_BASE, `empty-${Date.now()}`);
    fs.mkdirSync(emptyDir, { recursive: true });
    const result = await exec({ dir: emptyDir });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("SKILL.md not found");
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  // --- Security: path traversal ---

  it("blocks path traversal outside drafts base", async () => {
    const result = await exec({ dir: "/etc" });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("must be under");
    expect(result.details).toHaveProperty("error", true);
  });

  it("blocks relative path traversal", async () => {
    const result = await exec({ dir: path.join(DRAFTS_BASE, "..", "..") });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("must be under");
  });

  it("blocks dir that resolves to DRAFTS_BASE itself", async () => {
    const result = await exec({ dir: DRAFTS_BASE });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toContain("subdirectory");
  });

  // --- Frontmatter parsing ---

  it("parses name and inline description from frontmatter", async () => {
    const dir = writeSkill(`---
name: check-pod-oom
description: Diagnose OOM killed pods
type: Monitoring
---
# Check Pod OOM
`);
    const result = await exec({ dir });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.skill.name).toBe("check-pod-oom");
    expect(parsed.skill.description).toBe("Diagnose OOM killed pods");
    expect(parsed.skill.type).toBe("Monitoring");
  });

  it("parses multiline description from frontmatter", async () => {
    const dir = writeSkill(`---
name: gpu-diag
description: >-
  Diagnose GPU NVLink errors.
  Supports CRC and replay error detection.
---
# GPU Diag
`);
    const result = await exec({ dir });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.skill.name).toBe("gpu-diag");
    expect(parsed.skill.description).toContain("Diagnose GPU NVLink errors");
    expect(parsed.skill.description).toContain("Supports CRC");
  });

  it("strips quotes from inline description", async () => {
    const dir = writeSkill(`---
name: quoted
description: "A skill that does X"
---
# Quoted
`);
    const result = await exec({ dir });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.skill.description).toBe("A skill that does X");
  });

  it("returns error when frontmatter has no name", async () => {
    const dir = writeSkill(`---
description: Some skill
---
# No Name Skill
`);
    const result = await exec({ dir });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/name field/);
    expect(result.details.error).toBe(true);
  });

  it("returns error for SKILL.md without frontmatter", async () => {
    const dir = writeSkill("# Just a title\n\nSome content");
    const result = await exec({ dir });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/name field/);
    expect(result.details.error).toBe(true);
  });

  // --- Scripts ---

  it("reads scripts from scripts/ directory", async () => {
    const dir = writeSkill(`---
name: my-skill
description: test
---
# My Skill
`, [
      { name: "check.sh", content: "#!/bin/bash\necho hello" },
      { name: "setup.py", content: "#!/usr/bin/env python3\nprint('hi')" },
    ]);
    const result = await exec({ dir });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.skill.scripts).toHaveLength(2);
    expect(parsed.skill.scripts[0].name).toBe("check.sh");
    expect(parsed.skill.scripts[0].content).toContain("echo hello");
    expect(parsed.skill.scripts[1].name).toBe("setup.py");
  });

  it("returns empty scripts array when no scripts/ directory", async () => {
    const dir = writeSkill(`---
name: no-scripts
description: Pure guidance skill
---
# No Scripts
`);
    const result = await exec({ dir });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.skill.scripts).toEqual([]);
  });

  it("scripts are sorted by name", async () => {
    const dir = writeSkill(`---
name: sorted
description: test
---
# Sorted
`, [
      { name: "z-last.sh", content: "last" },
      { name: "a-first.sh", content: "first" },
    ]);
    const result = await exec({ dir });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.skill.scripts[0].name).toBe("a-first.sh");
    expect(parsed.skill.scripts[1].name).toBe("z-last.sh");
  });

  // --- Cleanup ---

  it("cleans up draft directory after reading", async () => {
    const dir = writeSkill(`---
name: cleanup-test
description: test
---
# Cleanup
`);
    expect(fs.existsSync(dir)).toBe(true);
    await exec({ dir });
    expect(fs.existsSync(dir)).toBe(false);
  });

  // --- Output format ---

  it("returns expected JSON structure", async () => {
    const dir = writeSkill(`---
name: structured
description: Test structure
type: Network
---
# Structured Skill
`, [{ name: "run.sh", content: "#!/bin/bash\necho ok" }]);
    const result = await exec({ dir });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveProperty("skill");
    expect(parsed).toHaveProperty("summary");
    expect(parsed.skill).toHaveProperty("name", "structured");
    expect(parsed.skill).toHaveProperty("description", "Test structure");
    expect(parsed.skill).toHaveProperty("type", "Network");
    expect(parsed.skill).toHaveProperty("specs");
    expect(parsed.skill).toHaveProperty("scripts");
    expect(parsed.summary).toContain("structured");
  });

  // --- Registration ---

  it("registration has correct modes", () => {
    expect(registration.modes).toEqual(["web", "channel"]);
    expect(registration.category).toBe("workflow");
  });
});
