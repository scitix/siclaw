import { describe, it, expect, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectSkillDirectoryFiles,
  normalizeSkillFiles,
  parseSingleSkillPackage,
} from "./skill-package.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function skillMd(name = "demo-skill") {
  return `---
name: ${name}
description: Demo skill
---

# ${name}
`;
}

function text(path: string, content = "x") {
  return { path, content, encoding: "utf8" as const };
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-skill-package-"));
  tmpDirs.push(dir);
  return dir;
}

describe("skill package normalization", () => {
  it("computes size and sha256 from content instead of trusting client metadata", () => {
    const content = skillMd();
    const [file] = normalizeSkillFiles([{
      path: "SKILL.md",
      content,
      encoding: "utf8",
      size: 1,
      sha256: "client-controlled",
    }]);

    expect(file.size).toBe(Buffer.byteLength(content, "utf8"));
    expect(file.sha256).toBe(crypto.createHash("sha256").update(content).digest("hex"));
  });

  it("computes binary size and sha256 from decoded base64 bytes", () => {
    const bytes = Buffer.from([0, 255, 1, 2]);
    const [file] = normalizeSkillFiles([{
      path: "assets/blob.bin",
      content: bytes.toString("base64"),
      encoding: "base64",
      size: 1,
      sha256: "client-controlled",
    }]);

    expect(file.size).toBe(bytes.length);
    expect(file.sha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
  });

  it("rejects unsafe or unsupported paths", () => {
    for (const badPath of [
      "../SKILL.md",
      "/SKILL.md",
      "references/../SKILL.md",
      ".DS_Store",
      ".git/config",
      "node_modules/pkg/index.js",
    ]) {
      expect(() => normalizeSkillFiles([text(badPath)])).toThrow();
    }
  });

  it("rejects duplicate package paths", () => {
    expect(() => normalizeSkillFiles([
      text("SKILL.md", skillMd()),
      text("SKILL.md", skillMd()),
    ])).toThrow(/Duplicate/);
  });
});

describe("single skill package parsing", () => {
  it("parses a wrapped skill directory and strips the wrapper", () => {
    const parsed = parseSingleSkillPackage([
      text("demo-skill/SKILL.md", skillMd("demo-skill")),
      text("demo-skill/references/runbook.md", "# Runbook\n"),
      text("demo-skill/scripts/check.sh", "echo ok\n"),
    ]);

    expect(parsed.name).toBe("demo-skill");
    expect(parsed.files.map(file => file.path).sort()).toEqual([
      "SKILL.md",
      "references/runbook.md",
      "scripts/check.sh",
    ].sort());
    expect(parsed.scripts).toEqual([{ name: "check.sh", content: "echo ok\n" }]);
  });

  it("requires uppercase SKILL.md", () => {
    expect(() => parseSingleSkillPackage([
      text("demo-skill/skill.md", skillMd("demo-skill")),
    ])).toThrow(/uppercase SKILL\.md/);
  });

  it("rejects a directory name that does not match frontmatter name", () => {
    expect(() => parseSingleSkillPackage([
      text("demo-skill/SKILL.md", skillMd("other-skill")),
    ])).toThrow(/does not match/);
  });

  it("rejects a multi-skill bundle when parsing a single skill package", () => {
    expect(() => parseSingleSkillPackage([
      text("alpha/SKILL.md", skillMd("alpha")),
      text("beta/SKILL.md", skillMd("beta")),
    ])).toThrow(/SKILL\.md/);
  });
});

describe("skill directory collection", () => {
  it("collects nested package files", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "references"), { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), skillMd("demo-skill"));
    fs.writeFileSync(path.join(dir, "references", "runbook.md"), "# Runbook\n");

    expect(collectSkillDirectoryFiles(dir).map(file => file.path).sort()).toEqual([
      "SKILL.md",
      "references/runbook.md",
    ].sort());
  });

  it("rejects symlinks and hidden path segments", () => {
    const symlinkDir = tempDir();
    fs.writeFileSync(path.join(symlinkDir, "SKILL.md"), skillMd("demo-skill"));
    fs.writeFileSync(path.join(symlinkDir, "target.txt"), "target");
    fs.symlinkSync(path.join(symlinkDir, "target.txt"), path.join(symlinkDir, "link.txt"));
    expect(() => collectSkillDirectoryFiles(symlinkDir)).toThrow(/Symlink/);

    const hiddenDir = tempDir();
    fs.writeFileSync(path.join(hiddenDir, "SKILL.md"), skillMd("demo-skill"));
    fs.writeFileSync(path.join(hiddenDir, ".DS_Store"), "");
    expect(() => collectSkillDirectoryFiles(hiddenDir)).toThrow(/Unsupported/);
  });

  it("rejects excessive file counts while walking the directory", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "SKILL.md"), skillMd("demo-skill"));
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(path.join(dir, `file-${i}.txt`), "x");
    }

    expect(() => collectSkillDirectoryFiles(dir)).toThrow(/exceeds 200 files/);
  });

  it("rejects excessive total bytes while walking the directory", () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "SKILL.md"), skillMd("demo-skill"));
    const chunk = Buffer.alloc(2 * 1024 * 1024 - 1, "x");
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(dir, "assets", `blob-${i}.bin`), chunk);
    }

    expect(() => collectSkillDirectoryFiles(dir)).toThrow(/exceeds 10485760 total bytes/);
  });
});
