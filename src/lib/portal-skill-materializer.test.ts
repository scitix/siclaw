import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializePortalSkills, cleanupPortalSkills } from "./portal-skill-materializer.js";
import type { CliSnapshotSkill } from "../portal/cli-snapshot-api.js";

function skill(name: string, specs: string, scripts: Array<{ name: string; content: string }> = []): CliSnapshotSkill {
  return { name, description: "desc", labels: [], specs, scripts };
}

describe("materializePortalSkills", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-skill-test-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  it("writes SKILL.md for each skill and returns accurate counts", () => {
    const out = path.join(tmpRoot, "skills");
    const result = materializePortalSkills(
      [skill("alpha", "# alpha"), skill("beta", "# beta")],
      out,
    );
    expect(result.count).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(fs.readFileSync(path.join(out, "alpha", "SKILL.md"), "utf-8")).toBe("# alpha");
    expect(fs.readFileSync(path.join(out, "beta", "SKILL.md"), "utf-8")).toBe("# beta");
  });

  it("writes companion scripts with executable permission", () => {
    const out = path.join(tmpRoot, "skills");
    materializePortalSkills(
      [skill("has-scripts", "# s", [{ name: "run.sh", content: "#!/bin/bash\necho ok\n" }])],
      out,
    );
    const scriptPath = path.join(out, "has-scripts", "scripts", "run.sh");
    expect(fs.readFileSync(scriptPath, "utf-8")).toBe("#!/bin/bash\necho ok\n");
    const mode = fs.statSync(scriptPath).mode & 0o777;
    // On POSIX we expect 0755; on non-POSIX chmod is best-effort so permit a less-strict baseline.
    expect(mode & 0o100).toBe(0o100);  // owner-executable at minimum
  });

  it("skips skills with directory-traversal names", () => {
    const out = path.join(tmpRoot, "skills");
    const result = materializePortalSkills(
      [skill("..", "bad"), skill("legit", "good"), skill("has/slash", "also-bad")],
      out,
    );
    expect(result.count).toBe(1);
    expect(result.skipped).toContain("..");
    expect(result.skipped).toContain("has/slash");
    expect(fs.existsSync(path.join(out, "legit", "SKILL.md"))).toBe(true);
  });

  it("wipes outDir on re-materialize so stale skills from a prior session don't linger", () => {
    const out = path.join(tmpRoot, "skills");
    materializePortalSkills([skill("old-skill", "# old")], out);
    expect(fs.existsSync(path.join(out, "old-skill"))).toBe(true);
    materializePortalSkills([skill("new-skill", "# new")], out);
    expect(fs.existsSync(path.join(out, "old-skill"))).toBe(false);
    expect(fs.existsSync(path.join(out, "new-skill"))).toBe(true);
  });

  it("cleanupPortalSkills removes the dir and is safe to call twice", () => {
    const out = path.join(tmpRoot, "skills");
    materializePortalSkills([skill("x", "y")], out);
    cleanupPortalSkills(out);
    expect(fs.existsSync(out)).toBe(false);
    cleanupPortalSkills(out);  // second call shouldn't throw
  });
});
