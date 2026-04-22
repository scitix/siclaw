import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSkillsDir, parseFrontmatter } from "./builtin-sync.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-parse-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Helper: write a SKILL.md into <tmpDir>/<name>/ and optionally add scripts
 * and labels (merged into the root meta.json).
 */
function writeSkill(
  name: string,
  specs: string,
  scripts?: Record<string, string>,
  labels?: Record<string, string[]>,
): void {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), specs);
  if (scripts) {
    const scriptsDir = path.join(dir, "scripts");
    fs.mkdirSync(scriptsDir);
    for (const [fname, content] of Object.entries(scripts)) {
      fs.writeFileSync(path.join(scriptsDir, fname), content);
    }
  }
  if (labels) {
    const metaPath = path.join(tmpDir, "meta.json");
    let existing: any = {};
    if (fs.existsSync(metaPath)) {
      existing = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    }
    existing.labels = { ...(existing.labels || {}), ...labels };
    fs.writeFileSync(metaPath, JSON.stringify(existing));
  }
}

describe("parseSkillsDir", () => {
  // ── 1. empty directory ──────────────────────────────────────────────
  it("returns [] for an empty directory", () => {
    const result = parseSkillsDir(tmpDir);
    expect(result).toEqual([]);
  });

  // ── 2. nonexistent directory ────────────────────────────────────────
  it("returns [] when the directory does not exist", () => {
    // Missing directory is a valid state (e.g. slim deployment that stripped
    // skills/); parseSkillsDir returns [] so callers can fall through their
    // own empty-result guard rather than crash on ENOENT.
    const bogus = path.join(tmpDir, "does-not-exist");
    expect(parseSkillsDir(bogus)).toEqual([]);
  });

  // ── 3. basic frontmatter ────────────────────────────────────────────
  it("parses name from basic frontmatter", () => {
    writeSkill("my-skill", "---\nname: foo\n---\nBody text");
    const [skill] = parseSkillsDir(tmpDir);
    expect(skill.name).toBe("foo");
    expect(skill.dirName).toBe("my-skill");
  });

  // ── 4. block scalar description (>-) ────────────────────────────────
  it("parses block scalar description (>-) and joins continuation lines", () => {
    const specs = [
      "---",
      "name: blocker",
      "description: >-",
      "  line1",
      "  line2",
      "---",
      "Body",
    ].join("\n");
    writeSkill("block", specs);
    const [skill] = parseSkillsDir(tmpDir);
    expect(skill.description).toBe("line1 line2");
  });

  // ── 5. inline description ──────────────────────────────────────────
  it("parses inline description", () => {
    writeSkill("inline", "---\nname: inl\ndescription: simple desc\n---\n");
    const [skill] = parseSkillsDir(tmpDir);
    expect(skill.description).toBe("simple desc");
  });

  // ── 6. skill without description ───────────────────────────────────
  it("returns empty description when not present in frontmatter", () => {
    writeSkill("no-desc", "---\nname: nd\n---\n");
    const [skill] = parseSkillsDir(tmpDir);
    expect(skill.description).toBe("");
  });

  // ── 7. skill with scripts ─────────────────────────────────────────
  it("reads .sh and .py scripts, sorted alphabetically", () => {
    writeSkill("scripted", "---\nname: scripted\n---\n", {
      "check.sh": "#!/bin/bash\nexit 0",
      "analyze.py": "print('ok')",
    });
    const [skill] = parseSkillsDir(tmpDir);
    expect(skill.scripts).toHaveLength(2);
    // alphabetical order: analyze.py < check.sh
    expect(skill.scripts[0].name).toBe("analyze.py");
    expect(skill.scripts[0].content).toBe("print('ok')");
    expect(skill.scripts[1].name).toBe("check.sh");
    expect(skill.scripts[1].content).toBe("#!/bin/bash\nexit 0");
  });

  // ── 8. skill without scripts dir ──────────────────────────────────
  it("returns empty scripts array when scripts/ does not exist", () => {
    writeSkill("no-scripts", "---\nname: ns\n---\n");
    const [skill] = parseSkillsDir(tmpDir);
    expect(skill.scripts).toEqual([]);
  });

  // ── 9. labels from meta.json ──────────────────────────────────────
  it("maps labels from meta.json by dirName", () => {
    writeSkill("labeled", "---\nname: labeled\n---\n", undefined, {
      labeled: ["k8s", "debug"],
    });
    const [skill] = parseSkillsDir(tmpDir);
    expect(skill.labels).toEqual(["k8s", "debug"]);
  });

  // ── 10. skill not in meta.json ────────────────────────────────────
  it("returns empty labels when skill is not in meta.json", () => {
    // Write meta.json with labels for a different skill
    writeSkill("other", "---\nname: other\n---\n", undefined, {
      "something-else": ["tag"],
    });
    const [skill] = parseSkillsDir(tmpDir);
    expect(skill.labels).toEqual([]);
  });

  // ── 11. directory without SKILL.md ─────────────────────────────────
  it("skips directories that do not contain SKILL.md", () => {
    fs.mkdirSync(path.join(tmpDir, "empty-dir"));
    const result = parseSkillsDir(tmpDir);
    expect(result).toEqual([]);
  });

  // ── 12. SKILL.md without name ──────────────────────────────────────
  it("skips skills whose SKILL.md lacks a name field", () => {
    writeSkill("nameless", "---\ndescription: something\n---\n");
    const result = parseSkillsDir(tmpDir);
    expect(result).toEqual([]);
  });

  // ── 13. multiple skills ───────────────────────────────────────────
  it("returns all valid skills from the directory", () => {
    writeSkill("alpha", "---\nname: alpha\n---\n");
    writeSkill("beta", "---\nname: beta\n---\n");
    writeSkill("gamma", "---\nname: gamma\n---\n");
    const result = parseSkillsDir(tmpDir);
    expect(result).toHaveLength(3);
    const names = result.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
  });

  // ── 14. non-directory entries ignored ──────────────────────────────
  it("ignores non-directory entries (files) in the root", () => {
    writeSkill("real", "---\nname: real\n---\n");
    // Write a stray file at the root level
    fs.writeFileSync(path.join(tmpDir, "stray-file.txt"), "noise");
    const result = parseSkillsDir(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("real");
  });

  // ── additional edge cases ─────────────────────────────────────────

  it("ignores non-.sh/.py files in scripts/", () => {
    writeSkill("filtered-scripts", "---\nname: fs\n---\n", {
      "run.sh": "echo hi",
      "helper.py": "pass",
      "readme.md": "# doc",
      "data.json": "{}",
    });
    const [skill] = parseSkillsDir(tmpDir);
    expect(skill.scripts).toHaveLength(2);
    expect(skill.scripts.map((s) => s.name)).toEqual(["helper.py", "run.sh"]);
  });

  it("handles SKILL.md with no frontmatter block — skips it", () => {
    writeSkill("no-front", "Just some markdown without frontmatter");
    const result = parseSkillsDir(tmpDir);
    expect(result).toEqual([]);
  });

  it("handles meta.json with invalid JSON gracefully", () => {
    writeSkill("valid", "---\nname: valid\n---\n");
    fs.writeFileSync(path.join(tmpDir, "meta.json"), "not json {{{");
    const result = parseSkillsDir(tmpDir);
    // The skill should still be returned, just with empty labels
    expect(result).toHaveLength(1);
    expect(result[0].labels).toEqual([]);
  });

  it("parses block scalar description with | (literal) style", () => {
    const specs = [
      "---",
      "name: lit",
      "description: |",
      "  literal line1",
      "  literal line2",
      "---",
    ].join("\n");
    writeSkill("literal", specs);
    const [skill] = parseSkillsDir(tmpDir);
    expect(skill.description).toBe("literal line1 literal line2");
  });

  it("includes the full raw specs content (frontmatter + body)", () => {
    const specs = "---\nname: full\n---\n# Body\nSome content here";
    writeSkill("full-specs", specs);
    const [skill] = parseSkillsDir(tmpDir);
    expect(skill.specs).toBe(specs);
  });

  // ── platform skill isolation ──────────────────────────────────────────

  it("does not parse platform directory skills when called with skills/core/ — separation is at call site", () => {
    // parseSkillsDir is called with skills/core/ (not skills/), so skills/platform/
    // is never in scope. Verify: calling parseSkillsDir(tmpDir) does not reach
    // a sibling "platform" directory that lives outside tmpDir.
    writeSkill("real-skill", "---\nname: real-skill\n---\nReal");

    // Create a sibling platform dir outside tmpDir to confirm it can't bleed in
    const siblingPlatform = path.join(os.tmpdir(), `platform-sibling-${Date.now()}`);
    fs.mkdirSync(path.join(siblingPlatform, "skill-authoring"), { recursive: true });
    fs.writeFileSync(path.join(siblingPlatform, "skill-authoring", "SKILL.md"), "---\nname: skill-authoring\n---\nPlatform skill");
    try {
      const result = parseSkillsDir(tmpDir);
      expect(result.map((s) => s.name)).toContain("real-skill");
      expect(result.map((s) => s.name)).not.toContain("skill-authoring");
    } finally {
      fs.rmSync(siblingPlatform, { recursive: true, force: true });
    }
  });

  it("actual skills/core/ does not contain platform skills (skill-authoring, session-feedback)", () => {
    const coreDir = path.resolve(process.cwd(), "skills", "core");
    if (!fs.existsSync(coreDir)) return; // skip if not run from repo root
    const result = parseSkillsDir(coreDir);
    const names = result.map((s) => s.name);
    expect(names).not.toContain("skill-authoring");
    expect(names).not.toContain("session-feedback");
  });
});

describe("parseFrontmatter", () => {
  it("parses inline name and description", () => {
    const md = "---\nname: foo\ndescription: a short summary\n---\n\nbody";
    expect(parseFrontmatter(md)).toEqual({ name: "foo", description: "a short summary" });
  });

  it("joins a `>-` block scalar description into a single line (regression for rollback bug)", () => {
    // Every built-in skill uses this shape — the naive /^description:\s*(.+)$/m
    // regex captured ">-" verbatim and corrupted skills on rollback.
    const md = [
      "---",
      "name: pod-crash-debug",
      "description: >-",
      "  Diagnose pod crash failures (CrashLoopBackOff, OOMKilled).",
      "  Checks pod status, events, and previous logs.",
      "---",
      "",
      "# body",
    ].join("\n");

    const { name, description } = parseFrontmatter(md);
    expect(name).toBe("pod-crash-debug");
    expect(description).not.toBe(">-");
    expect(description).toBe(
      "Diagnose pod crash failures (CrashLoopBackOff, OOMKilled). Checks pod status, events, and previous logs.",
    );
  });

  it("returns empty strings when frontmatter is missing", () => {
    expect(parseFrontmatter("# no frontmatter here")).toEqual({ name: "", description: "" });
  });
});
