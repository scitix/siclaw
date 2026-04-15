import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildKnowledgeOverview } from "./overview-generator.js";

describe("buildKnowledgeOverview", () => {
  let tmpDir: string;
  let reposDir: string;
  let docsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "overview-test-"));
    reposDir = path.join(tmpDir, "repos");
    docsDir = path.join(tmpDir, "docs");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Empty / no-content cases ---

  it("returns empty string when nothing is passed", () => {
    expect(buildKnowledgeOverview({})).toBe("");
  });

  it("returns empty string when repos/ and docs/ are both unset", () => {
    expect(buildKnowledgeOverview({})).toBe("");
  });

  // --- Code Repositories ---

  it("returns empty when repos/ doesn't exist", () => {
    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toBe("");
  });

  it("returns empty when repos/ exists but is empty", () => {
    fs.mkdirSync(reposDir);
    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toBe("");
  });

  it("shows repos section for a single repo", () => {
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "my-service");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "main.ts"), "console.log()");
    fs.writeFileSync(path.join(repo, "util.ts"), "export {}");
    fs.writeFileSync(path.join(repo, "go.mod"), "module x");

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("## Knowledge Overview");
    expect(result).toContain("### Code Repositories");
    expect(result).toContain("my-service");
    expect(result).toContain("3"); // file count
    expect(result).toContain(".ts"); // top extension
  });

  it("shows multiple repos sorted by file count", () => {
    fs.mkdirSync(reposDir);

    // Small repo
    const small = path.join(reposDir, "small-repo");
    fs.mkdirSync(small);
    fs.writeFileSync(path.join(small, "a.py"), "");

    // Large repo
    const large = path.join(reposDir, "large-repo");
    fs.mkdirSync(large);
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(large, `file${i}.go`), "");
    }

    const result = buildKnowledgeOverview({ reposDir });
    const largeIdx = result.indexOf("large-repo");
    const smallIdx = result.indexOf("small-repo");
    expect(largeIdx).toBeLessThan(smallIdx);
  });

  it("counts files recursively and detects top languages", () => {
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "nested-service");
    fs.mkdirSync(path.join(repo, "src", "utils"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "main.ts"), "");
    fs.writeFileSync(path.join(repo, "src", "app.ts"), "");
    fs.writeFileSync(path.join(repo, "src", "utils", "helper.ts"), "");
    fs.writeFileSync(path.join(repo, "README.md"), "");
    fs.writeFileSync(path.join(repo, "package.json"), "{}");

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("nested-service");
    expect(result).toContain("5"); // total files
    expect(result).toContain(".ts"); // top extension
  });

  it("skips hidden dirs and node_modules in repos", () => {
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "with-hidden");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "config"), "");
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", "index.js"), "");
    fs.writeFileSync(path.join(repo, "src.ts"), "");

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("| 1 |"); // only src.ts counted
  });

  it("follows symlinked repo directories", () => {
    fs.mkdirSync(reposDir);
    // Create actual repo outside repos/
    const realRepo = path.join(tmpDir, "real-repo");
    fs.mkdirSync(realRepo);
    fs.writeFileSync(path.join(realRepo, "index.ts"), "");
    fs.writeFileSync(path.join(realRepo, "lib.ts"), "");
    // Symlink into repos/
    fs.symlinkSync(realRepo, path.join(reposDir, "linked-repo"));

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("linked-repo");
    expect(result).toContain("2"); // file count
  });

  it("follows symlinked doc directories", () => {
    fs.mkdirSync(docsDir);
    const realDocs = path.join(tmpDir, "real-runbooks");
    fs.mkdirSync(realDocs);
    fs.writeFileSync(path.join(realDocs, "deploy.md"), "");
    fs.symlinkSync(realDocs, path.join(docsDir, "runbooks"));

    const result = buildKnowledgeOverview({ docsDir });
    expect(result).toContain("runbooks");
  });

  // --- Documentation ---

  it("returns empty when docs/ doesn't exist", () => {
    const result = buildKnowledgeOverview({ docsDir });
    expect(result).toBe("");
  });

  it("returns empty when docs/ exists but is empty", () => {
    fs.mkdirSync(docsDir);
    const result = buildKnowledgeOverview({ docsDir });
    expect(result).toBe("");
  });

  it("shows docs section with subdirectories", () => {
    fs.mkdirSync(docsDir);
    const runbooks = path.join(docsDir, "runbooks");
    fs.mkdirSync(runbooks);
    fs.writeFileSync(path.join(runbooks, "restart.md"), "# Restart");
    fs.writeFileSync(path.join(runbooks, "scale.md"), "# Scale");

    const arch = path.join(docsDir, "architecture");
    fs.mkdirSync(arch);
    fs.writeFileSync(path.join(arch, "overview.md"), "# Overview");

    const result = buildKnowledgeOverview({ docsDir });
    expect(result).toContain("### Documentation");
    expect(result).toContain("runbooks");
    expect(result).toContain("architecture");
  });

  it("lists top-level files as (root)", () => {
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, "getting-started.md"), "# Hello");
    fs.writeFileSync(path.join(docsDir, "faq.md"), "# FAQ");

    const result = buildKnowledgeOverview({ docsDir });
    expect(result).toContain("### Documentation");
    expect(result).toContain("(root)");
    expect(result).toContain("| 2 |");
  });

  // --- Mixed scenarios ---

  it("shows repos + docs together", () => {
    // repos
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "api-svc");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "main.go"), "package main");

    // docs
    fs.mkdirSync(docsDir);
    const runbooks = path.join(docsDir, "runbooks");
    fs.mkdirSync(runbooks);
    fs.writeFileSync(path.join(runbooks, "deploy.md"), "# Deploy");

    const result = buildKnowledgeOverview({ reposDir, docsDir });
    expect(result).toContain("### Code Repositories");
    expect(result).toContain("api-svc");
    expect(result).toContain("### Documentation");
    expect(result).toContain("runbooks");
    expect(result).not.toContain("### Recent Investigations");
    expect(result).not.toContain("### Accumulated Knowledge");
  });

  it("uses content-aware footer when repos or docs present", () => {
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "svc");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "x.ts"), "");

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("repos/");
    expect(result).toContain("docs/");
  });

  // --- Intentional non-injection of investigations ---

  it("never injects past investigations, even when memory/investigations/ exists", () => {
    // Simulate a past DP investigation file on disk — it must NOT appear in the overview.
    const memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(memoryDir);
    const invDir = path.join(memoryDir, "investigations");
    fs.mkdirSync(invDir);
    fs.writeFileSync(
      path.join(invDir, "2026-03-16-14-30-00.md"),
      `# Investigation: Pod CrashLoopBackOff in prod-us-west\n`,
    );

    // Also give the overview something to render so we're checking selective omission,
    // not a trivial empty-result path.
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "svc");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "main.ts"), "");

    const result = buildKnowledgeOverview({ reposDir });
    expect(result).toContain("### Code Repositories");
    expect(result).not.toContain("### Recent Investigations");
    expect(result).not.toContain("Pod CrashLoopBackOff");
    expect(result).not.toContain("Patterns:");
  });

  // --- Budget ---

  it("stays within budget with large repos + many docs", () => {
    // Large repos
    fs.mkdirSync(reposDir);
    for (let r = 0; r < 10; r++) {
      const repo = path.join(reposDir, `service-with-long-name-${r}`);
      fs.mkdirSync(repo);
      for (let f = 0; f < 20; f++) {
        fs.writeFileSync(path.join(repo, `file${f}.ts`), "");
      }
    }

    // Many docs
    fs.mkdirSync(docsDir);
    for (let d = 0; d < 10; d++) {
      const dir = path.join(docsDir, `category-with-long-name-${d}`);
      fs.mkdirSync(dir);
      for (let f = 0; f < 5; f++) {
        fs.writeFileSync(path.join(dir, `doc${f}.md`), "");
      }
    }

    const result = buildKnowledgeOverview({ reposDir, docsDir });
    expect(result.length).toBeLessThanOrEqual(1200 + 150);
  });
});
