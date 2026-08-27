import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filterHarnessSkills } from "./skill-overlay.js";

describe("personal preview Skill overlay", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-overlay-"));
    roots.push(root);
    const resolvedDir = path.join(root, ".siclaw/skills/resolved");
    const platformDir = path.join(root, "skills/platform");
    const inheritFile = path.join(root, ".siclaw/skills/.inherit-builtins.json");
    const disabledFile = path.join(root, ".siclaw/skills/.disabled-builtins.json");
    fs.mkdirSync(path.dirname(disabledFile), { recursive: true });
    return { root, resolvedDir, platformDir, inheritFile, disabledFile };
  }

  it("personal Skill wins over a same-named image Built-in", () => {
    const f = fixture();
    const got = filterHarnessSkills([
      { name: "probe", filePath: path.join(f.platformDir, "probe/SKILL.md") },
      { name: "probe", filePath: path.join(f.resolvedDir, "probe/SKILL.md") },
      { name: "manage-skill", filePath: path.join(f.platformDir, "manage-skill/SKILL.md") },
    ], { resolvedDir: f.resolvedDir, builtinDirs: [f.platformDir], inheritFile: f.inheritFile, disabledFile: f.disabledFile });
    expect(got.map((skill) => skill.filePath)).toEqual([
      path.join(f.resolvedDir, "probe/SKILL.md"),
      path.join(f.platformDir, "manage-skill/SKILL.md"),
    ]);
  });

  it("explicit mask removes only the Built-in", () => {
    const f = fixture();
    fs.writeFileSync(f.disabledFile, JSON.stringify(["manage-skill"]));
    const got = filterHarnessSkills([
      { name: "manage-skill", filePath: path.join(f.platformDir, "manage-skill/SKILL.md") },
      { name: "probe", filePath: path.join(f.resolvedDir, "probe/SKILL.md") },
    ], { resolvedDir: f.resolvedDir, builtinDirs: [f.platformDir], inheritFile: f.inheritFile, disabledFile: f.disabledFile });
    expect(got.map((skill) => skill.name)).toEqual(["probe"]);
  });

  it("inheritance off removes every Built-in but keeps personal Skills", () => {
    const f = fixture();
    fs.writeFileSync(f.inheritFile, JSON.stringify(false));
    const got = filterHarnessSkills([
      { name: "manage-skill", filePath: path.join(f.platformDir, "manage-skill/SKILL.md") },
      { name: "triage", filePath: path.join(f.platformDir, "triage/SKILL.md") },
      { name: "probe", filePath: path.join(f.resolvedDir, "probe/SKILL.md") },
    ], {
      resolvedDir: f.resolvedDir,
      builtinDirs: [f.platformDir],
      inheritFile: f.inheritFile,
      disabledFile: f.disabledFile,
    });
    expect(got.map((skill) => skill.name)).toEqual(["probe"]);
  });

  it("does not accept a sibling path that only shares an allowed prefix", () => {
    const f = fixture();
    const got = filterHarnessSkills([
      { name: "forged", filePath: path.join(`${f.platformDir}-untrusted`, "forged/SKILL.md") },
    ], {
      resolvedDir: f.resolvedDir,
      builtinDirs: [f.platformDir],
      inheritFile: f.inheritFile,
      disabledFile: f.disabledFile,
      portalDir: f.resolvedDir,
    });
    expect(got).toEqual([]);
  });
});
