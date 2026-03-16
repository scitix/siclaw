import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildKnowledgeOverview } from "./overview-generator.js";

describe("buildKnowledgeOverview", () => {
  let tmpDir: string;
  let memoryDir: string;
  let reposDir: string;
  let docsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "overview-test-"));
    memoryDir = path.join(tmpDir, "memory");
    reposDir = path.join(tmpDir, "repos");
    docsDir = path.join(tmpDir, "docs");
    fs.mkdirSync(memoryDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Backward compatibility (memoryDir only) ---

  it("returns empty string for empty memoryDir", () => {
    expect(buildKnowledgeOverview({ memoryDir })).toBe("");
  });

  it("returns empty string when topics/ and investigations/ don't exist", () => {
    fs.writeFileSync(path.join(memoryDir, "PROFILE.md"), "hello");
    expect(buildKnowledgeOverview({ memoryDir })).toBe("");
  });

  it("works with only memoryDir (backward compat, repos/docs optional)", () => {
    const topicsDir = path.join(memoryDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(
      path.join(topicsDir, "env.md"),
      `# Env\n\n## 2026-03-16\n- fact\n`,
    );

    const result = buildKnowledgeOverview({ memoryDir });
    expect(result).toContain("### Accumulated Knowledge");
    expect(result).toContain("| env | 1 | 2026-03-16 |");
    expect(result).not.toContain("### Code Repositories");
    expect(result).not.toContain("### Documentation");
  });

  // --- Topics ---

  it("shows only topics table when only topics/ exists", () => {
    const topicsDir = path.join(memoryDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(
      path.join(topicsDir, "environment.md"),
      `# Environment\n\n## 2026-03-16\n- fact one\n- fact two\n- fact three\n`,
    );

    const result = buildKnowledgeOverview({ memoryDir });
    expect(result).toContain("## Knowledge Overview");
    expect(result).toContain("### Accumulated Knowledge");
    expect(result).toContain("| environment | 3 | 2026-03-16 |");
    expect(result).not.toContain("### Recent Investigations");
    expect(result).toContain("memory_get");
  });

  it("sorts topics by last updated descending", () => {
    const topicsDir = path.join(memoryDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(
      path.join(topicsDir, "old-topic.md"),
      `# Old\n\n## 2026-01-01\n- old fact\n`,
    );
    fs.writeFileSync(
      path.join(topicsDir, "new-topic.md"),
      `# New\n\n## 2026-03-16\n- new fact\n`,
    );

    const result = buildKnowledgeOverview({ memoryDir });
    const newIdx = result.indexOf("new-topic");
    const oldIdx = result.indexOf("old-topic");
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it("picks the latest date section across multiple sections", () => {
    const topicsDir = path.join(memoryDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(
      path.join(topicsDir, "multi.md"),
      `# Multi\n\n## 2026-03-16\n- recent\n\n## 2026-01-01\n- old\n`,
    );

    const result = buildKnowledgeOverview({ memoryDir });
    expect(result).toContain("| multi | 2 | 2026-03-16 |");
  });

  it("handles empty topic files gracefully", () => {
    const topicsDir = path.join(memoryDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(path.join(topicsDir, "empty.md"), "");

    const result = buildKnowledgeOverview({ memoryDir });
    expect(result).toContain("| empty | 0 | unknown |");
  });

  // --- Investigations ---

  it("shows only investigations when only investigations/ exists", () => {
    const invDir = path.join(memoryDir, "investigations");
    fs.mkdirSync(invDir);
    fs.writeFileSync(
      path.join(invDir, "2026-03-16-14-30-00.md"),
      `# Investigation: Pod CrashLoopBackOff in prod-us-west\n\n**Date**: 2026-03-16\n`,
    );

    const result = buildKnowledgeOverview({ memoryDir });
    expect(result).toContain("## Knowledge Overview");
    expect(result).toContain("### Recent Investigations");
    expect(result).toContain("2026-03-16: Pod CrashLoopBackOff in prod-us-west");
    expect(result).not.toContain("### Accumulated Knowledge");
  });

  it("shows both sections when both exist", () => {
    const topicsDir = path.join(memoryDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(
      path.join(topicsDir, "networking.md"),
      `# Networking\n\n## 2026-03-15\n- fact a\n- fact b\n`,
    );

    const invDir = path.join(memoryDir, "investigations");
    fs.mkdirSync(invDir);
    fs.writeFileSync(
      path.join(invDir, "2026-03-08-10-00-00.md"),
      `# Investigation: RoCE network latency spike\n\n**Date**: 2026-03-08\n`,
    );

    const result = buildKnowledgeOverview({ memoryDir });
    expect(result).toContain("### Accumulated Knowledge");
    expect(result).toContain("| networking | 2 | 2026-03-15 |");
    expect(result).toContain("### Recent Investigations");
    expect(result).toContain("2026-03-08: RoCE network latency spike");
  });

  it("limits investigations to 5 and sorts descending", () => {
    const invDir = path.join(memoryDir, "investigations");
    fs.mkdirSync(invDir);
    for (let i = 1; i <= 7; i++) {
      const day = String(i).padStart(2, "0");
      fs.writeFileSync(
        path.join(invDir, `2026-03-${day}-12-00-00.md`),
        `# Investigation: Issue ${i}\n`,
      );
    }

    const result = buildKnowledgeOverview({ memoryDir });
    expect(result).toContain("Issue 7");
    expect(result).toContain("Issue 3");
    expect(result).not.toContain("Issue 1");
    expect(result).not.toContain("Issue 2");
  });

  it("handles investigation files without title gracefully", () => {
    const invDir = path.join(memoryDir, "investigations");
    fs.mkdirSync(invDir);
    fs.writeFileSync(path.join(invDir, "2026-03-10-08-00-00.md"), "no title here");

    const result = buildKnowledgeOverview({ memoryDir });
    expect(result).toContain("2026-03-10:");
  });

  // --- Code Repositories ---

  it("returns empty when repos/ doesn't exist", () => {
    const result = buildKnowledgeOverview({ memoryDir, reposDir });
    expect(result).toBe("");
  });

  it("returns empty when repos/ exists but is empty", () => {
    fs.mkdirSync(reposDir);
    const result = buildKnowledgeOverview({ memoryDir, reposDir });
    expect(result).toBe("");
  });

  it("shows repos section for a single repo", () => {
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "my-service");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "main.ts"), "console.log()");
    fs.writeFileSync(path.join(repo, "util.ts"), "export {}");
    fs.writeFileSync(path.join(repo, "go.mod"), "module x");

    const result = buildKnowledgeOverview({ memoryDir, reposDir });
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

    const result = buildKnowledgeOverview({ memoryDir, reposDir });
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

    const result = buildKnowledgeOverview({ memoryDir, reposDir });
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

    const result = buildKnowledgeOverview({ memoryDir, reposDir });
    expect(result).toContain("| 1 |"); // only src.ts counted
  });

  // --- Documentation ---

  it("returns empty when docs/ doesn't exist", () => {
    const result = buildKnowledgeOverview({ memoryDir, docsDir });
    expect(result).toBe("");
  });

  it("returns empty when docs/ exists but is empty", () => {
    fs.mkdirSync(docsDir);
    const result = buildKnowledgeOverview({ memoryDir, docsDir });
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

    const result = buildKnowledgeOverview({ memoryDir, docsDir });
    expect(result).toContain("### Documentation");
    expect(result).toContain("runbooks");
    expect(result).toContain("architecture");
  });

  it("lists top-level files as (root)", () => {
    fs.mkdirSync(docsDir);
    fs.writeFileSync(path.join(docsDir, "getting-started.md"), "# Hello");
    fs.writeFileSync(path.join(docsDir, "faq.md"), "# FAQ");

    const result = buildKnowledgeOverview({ memoryDir, docsDir });
    expect(result).toContain("### Documentation");
    expect(result).toContain("(root)");
    expect(result).toContain("| 2 |");
  });

  // --- Mixed scenarios ---

  it("shows all sections when repos + docs + topics + investigations exist", () => {
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

    // topics
    const topicsDir = path.join(memoryDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(
      path.join(topicsDir, "environment.md"),
      `# Env\n\n## 2026-03-16\n- fact 1\n- fact 2\n`,
    );

    // investigations
    const invDir = path.join(memoryDir, "investigations");
    fs.mkdirSync(invDir);
    fs.writeFileSync(
      path.join(invDir, "2026-03-16-14-30-00.md"),
      `# Investigation: Pod CrashLoopBackOff\n`,
    );

    const result = buildKnowledgeOverview({ memoryDir, reposDir, docsDir });
    expect(result).toContain("### Code Repositories");
    expect(result).toContain("api-svc");
    expect(result).toContain("### Documentation");
    expect(result).toContain("runbooks");
    expect(result).toContain("### Accumulated Knowledge");
    expect(result).toContain("| environment | 2 | 2026-03-16 |");
    expect(result).toContain("### Recent Investigations");
    expect(result).toContain("Pod CrashLoopBackOff");
  });

  it("uses workspace-aware footer when repos or docs present", () => {
    fs.mkdirSync(reposDir);
    const repo = path.join(reposDir, "svc");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "x.ts"), "");

    const result = buildKnowledgeOverview({ memoryDir, reposDir });
    expect(result).toContain("repos/");
    expect(result).toContain("docs/");
  });

  // --- Budget ---

  it("stays within budget with many topics", () => {
    const topicsDir = path.join(memoryDir, "topics");
    fs.mkdirSync(topicsDir);
    for (let i = 0; i < 50; i++) {
      const name = `topic-with-a-long-name-number-${String(i).padStart(3, "0")}`;
      fs.writeFileSync(
        path.join(topicsDir, `${name}.md`),
        `# T\n\n## 2026-03-16\n${Array(20).fill("- fact").join("\n")}\n`,
      );
    }

    const invDir = path.join(memoryDir, "investigations");
    fs.mkdirSync(invDir);
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(
        path.join(invDir, `2026-03-${String(i).padStart(2, "0")}-12-00-00.md`),
        `# Investigation: A fairly long investigation question number ${i}\n`,
      );
    }

    const result = buildKnowledgeOverview({ memoryDir });
    expect(result.length).toBeLessThanOrEqual(1800 + 150); // small slack for footer
  });

  it("stays within budget with large repos + many docs + topics + investigations", () => {
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

    // Topics
    const topicsDir = path.join(memoryDir, "topics");
    fs.mkdirSync(topicsDir);
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(
        path.join(topicsDir, `topic-${i}.md`),
        `# T\n\n## 2026-03-16\n- fact\n`,
      );
    }

    // Investigations
    const invDir = path.join(memoryDir, "investigations");
    fs.mkdirSync(invDir);
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(
        path.join(invDir, `2026-03-${String(i).padStart(2, "0")}-12-00-00.md`),
        `# Investigation: Long investigation title number ${i}\n`,
      );
    }

    const result = buildKnowledgeOverview({ memoryDir, reposDir, docsDir });
    expect(result.length).toBeLessThanOrEqual(1800 + 150);
  });
});
