import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveScript,
  resolveSkillScript,
  listSkillScripts,
  listAllSkillsWithScripts,
  skillExistsInBundle,
  skillExistsAsBuiltin,
} from "./script-resolver.js";

// script-resolver reads from process.cwd() + config.paths.skillsDir (".siclaw/skills")
// and process.cwd() + "skills/{core,extension}" for builtins.
// We use cwd + temp dirs to avoid polluting the real repo.

let tmpRoot: string;
let originalCwd: string;

function mkFile(p: string, content = "echo hi") {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "script-resolver-test-"));
  originalCwd = process.cwd();
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(originalCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("resolveScript — validation", () => {
  it("returns error when script is missing", () => {
    const r = resolveScript({ script: "" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("Script name is required");
  });

  it("rejects script with forward slash (path traversal)", () => {
    const r = resolveScript({ skill: "foo", script: "../etc/passwd" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("path separator");
  });

  it("rejects script with backslash", () => {
    const r = resolveScript({ skill: "foo", script: "evil\\script.sh" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("path separator");
  });

  it("returns error when skill is missing", () => {
    const r = resolveScript({ script: "check.sh" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("Skill name is required");
  });

  it("rejects skill name with path separator", () => {
    const r = resolveScript({ skill: "foo/bar", script: "check.sh" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error).toContain("path separator");
  });
});

describe("resolveSkillScript — path search precedence", () => {
  it("finds script in scope subdirectory (global)", () => {
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/my-skill/scripts/run.sh"), "echo run");
    const res = resolveSkillScript("my-skill", "run.sh");
    expect(res).not.toBeNull();
    expect(res!.scope).toBe("global");
    expect(res!.interpreter).toBe("bash");
    expect(res!.content).toBe("echo run");
  });

  it("uses python3 interpreter for .py", () => {
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/x/scripts/t.py"), "print('x')");
    const res = resolveSkillScript("x", "t.py");
    expect(res!.interpreter).toBe("python3");
  });

  it("resolved/ dir takes precedence over scope subdirs", () => {
    mkFile(path.join(tmpRoot, ".siclaw/skills/resolved/sk/scripts/a.sh"), "resolved");
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/sk/scripts/a.sh"), "scope");
    const res = resolveSkillScript("sk", "a.sh");
    expect(res!.content).toBe("resolved");
    expect(res!.scope).toBe("global");
  });

  it("falls back to skills/core builtin", () => {
    mkFile(path.join(tmpRoot, "skills/core/builtin-skill/scripts/b.sh"), "core-script");
    const res = resolveSkillScript("builtin-skill", "b.sh");
    expect(res).not.toBeNull();
    expect(res!.scope).toBe("builtin");
    expect(res!.content).toBe("core-script");
  });

  it("falls back to skills/extension builtin", () => {
    mkFile(path.join(tmpRoot, "skills/extension/ext-skill/scripts/b.sh"), "ext-script");
    const res = resolveSkillScript("ext-skill", "b.sh");
    expect(res).not.toBeNull();
    expect(res!.scope).toBe("builtin");
  });

  it("respects .disabled-builtins.json", () => {
    mkFile(path.join(tmpRoot, "skills/core/disabled-one/scripts/a.sh"), "x");
    fs.mkdirSync(path.join(tmpRoot, ".siclaw/skills"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, ".siclaw/skills/.disabled-builtins.json"),
      JSON.stringify(["disabled-one"]),
    );
    const res = resolveSkillScript("disabled-one", "a.sh");
    expect(res).toBeNull();
  });

  it("returns null for unknown skill", () => {
    expect(resolveSkillScript("nowhere", "any.sh")).toBeNull();
  });
});

describe("listSkillScripts", () => {
  it("lists .sh and .py files", () => {
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/sk/scripts/a.sh"));
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/sk/scripts/b.py"));
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/sk/scripts/readme.md"));
    const list = listSkillScripts("sk");
    expect(list.sort()).toEqual(["a.sh", "b.py"]);
  });

  it("returns empty array when skill has no scripts dir", () => {
    expect(listSkillScripts("unknown")).toEqual([]);
  });
});

describe("listAllSkillsWithScripts", () => {
  it("returns all skills + their scripts", () => {
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/sk1/scripts/a.sh"));
    mkFile(path.join(tmpRoot, ".siclaw/skills/extension/sk2/scripts/b.sh"));
    const all = listAllSkillsWithScripts();
    const names = all.map(s => s.skill).sort();
    expect(names).toContain("sk1");
    expect(names).toContain("sk2");
  });

  it("skips _lib dirs", () => {
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/_lib/scripts/common.sh"));
    const all = listAllSkillsWithScripts();
    expect(all.map(s => s.skill)).not.toContain("_lib");
  });

  it("dedups across priorities (global wins over builtin)", () => {
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/skx/scripts/new.sh"));
    mkFile(path.join(tmpRoot, "skills/core/skx/scripts/old.sh"));
    const all = listAllSkillsWithScripts();
    const entries = all.filter(s => s.skill === "skx");
    expect(entries).toHaveLength(1);
    expect(entries[0].scripts).toContain("new.sh");
  });
});

describe("skillExistsInBundle / skillExistsAsBuiltin", () => {
  it("detects bundle skill via scope subdir", () => {
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/sk/SKILL.md"));
    expect(skillExistsInBundle("sk")).toBe(true);
    expect(skillExistsInBundle("unknown")).toBe(false);
  });

  it("detects bundle skill via legacy flat layout", () => {
    fs.mkdirSync(path.join(tmpRoot, ".siclaw/skills/sk-flat"), { recursive: true });
    expect(skillExistsInBundle("sk-flat")).toBe(true);
  });

  it("detects builtin skill (core)", () => {
    fs.mkdirSync(path.join(tmpRoot, "skills/core/my-core"), { recursive: true });
    expect(skillExistsAsBuiltin("my-core")).toBe(true);
  });

  it("excludes disabled builtins", () => {
    fs.mkdirSync(path.join(tmpRoot, "skills/core/disabled"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, ".siclaw/skills"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, ".siclaw/skills/.disabled-builtins.json"),
      JSON.stringify(["disabled"]),
    );
    expect(skillExistsAsBuiltin("disabled")).toBe(false);
  });
});

describe("resolveScript — full flow", () => {
  it("returns resolved script on hit", () => {
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/sk/scripts/run.sh"), "echo hello");
    const res = resolveScript({ skill: "sk", script: "run.sh" });
    expect("error" in res).toBe(false);
    if (!("error" in res)) {
      expect(res.content).toBe("echo hello");
      expect(res.interpreter).toBe("bash");
    }
  });

  it("suggests available scripts when script not found in skill", () => {
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/sk/scripts/run.sh"));
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/sk/scripts/run2.sh"));
    const res = resolveScript({ skill: "sk", script: "missing.sh" });
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error).toContain("not found");
      expect(res.error).toContain("run.sh");
      expect(res.error).toContain("run2.sh");
    }
  });

  it("suggests other skills when target skill has no scripts", () => {
    mkFile(path.join(tmpRoot, ".siclaw/skills/global/other/scripts/x.sh"));
    const res = resolveScript({ skill: "empty-skill", script: "x.sh" });
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error).toContain("no scripts directory");
      expect(res.error).toContain("other");
    }
  });
});
