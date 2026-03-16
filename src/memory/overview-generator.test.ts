import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildKnowledgeOverview } from "./overview-generator.js";

describe("buildKnowledgeOverview", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "overview-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty string for empty memoryDir", () => {
    expect(buildKnowledgeOverview(tmpDir)).toBe("");
  });

  it("returns empty string when topics/ and investigations/ don't exist", () => {
    // Create an unrelated file
    fs.writeFileSync(path.join(tmpDir, "PROFILE.md"), "hello");
    expect(buildKnowledgeOverview(tmpDir)).toBe("");
  });

  it("shows only topics table when only topics/ exists", () => {
    const topicsDir = path.join(tmpDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(
      path.join(topicsDir, "environment.md"),
      `# Environment\n\n## 2026-03-16\n- fact one\n- fact two\n- fact three\n`,
    );

    const result = buildKnowledgeOverview(tmpDir);
    expect(result).toContain("## Knowledge Overview");
    expect(result).toContain("### Accumulated Knowledge");
    expect(result).toContain("| environment | 3 | 2026-03-16 |");
    expect(result).not.toContain("### Recent Investigations");
    expect(result).toContain("memory_get");
  });

  it("shows only investigations when only investigations/ exists", () => {
    const invDir = path.join(tmpDir, "investigations");
    fs.mkdirSync(invDir);
    fs.writeFileSync(
      path.join(invDir, "2026-03-16-14-30-00.md"),
      `# Investigation: Pod CrashLoopBackOff in prod-us-west\n\n**Date**: 2026-03-16\n`,
    );

    const result = buildKnowledgeOverview(tmpDir);
    expect(result).toContain("## Knowledge Overview");
    expect(result).toContain("### Recent Investigations");
    expect(result).toContain("2026-03-16: Pod CrashLoopBackOff in prod-us-west");
    expect(result).not.toContain("### Accumulated Knowledge");
  });

  it("shows both sections when both exist", () => {
    const topicsDir = path.join(tmpDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(
      path.join(topicsDir, "networking.md"),
      `# Networking\n\n## 2026-03-15\n- fact a\n- fact b\n`,
    );

    const invDir = path.join(tmpDir, "investigations");
    fs.mkdirSync(invDir);
    fs.writeFileSync(
      path.join(invDir, "2026-03-08-10-00-00.md"),
      `# Investigation: RoCE network latency spike\n\n**Date**: 2026-03-08\n`,
    );

    const result = buildKnowledgeOverview(tmpDir);
    expect(result).toContain("### Accumulated Knowledge");
    expect(result).toContain("| networking | 2 | 2026-03-15 |");
    expect(result).toContain("### Recent Investigations");
    expect(result).toContain("2026-03-08: RoCE network latency spike");
  });

  it("sorts topics by last updated descending", () => {
    const topicsDir = path.join(tmpDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(
      path.join(topicsDir, "old-topic.md"),
      `# Old\n\n## 2026-01-01\n- old fact\n`,
    );
    fs.writeFileSync(
      path.join(topicsDir, "new-topic.md"),
      `# New\n\n## 2026-03-16\n- new fact\n`,
    );

    const result = buildKnowledgeOverview(tmpDir);
    const newIdx = result.indexOf("new-topic");
    const oldIdx = result.indexOf("old-topic");
    expect(newIdx).toBeLessThan(oldIdx);
  });

  it("picks the latest date section across multiple sections", () => {
    const topicsDir = path.join(tmpDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(
      path.join(topicsDir, "multi.md"),
      `# Multi\n\n## 2026-03-16\n- recent\n\n## 2026-01-01\n- old\n`,
    );

    const result = buildKnowledgeOverview(tmpDir);
    expect(result).toContain("| multi | 2 | 2026-03-16 |");
  });

  it("limits investigations to 5 and sorts descending", () => {
    const invDir = path.join(tmpDir, "investigations");
    fs.mkdirSync(invDir);
    for (let i = 1; i <= 7; i++) {
      const day = String(i).padStart(2, "0");
      fs.writeFileSync(
        path.join(invDir, `2026-03-${day}-12-00-00.md`),
        `# Investigation: Issue ${i}\n`,
      );
    }

    const result = buildKnowledgeOverview(tmpDir);
    // Should include most recent 5 (days 07, 06, 05, 04, 03)
    expect(result).toContain("Issue 7");
    expect(result).toContain("Issue 3");
    expect(result).not.toContain("Issue 1");
    expect(result).not.toContain("Issue 2");
  });

  it("stays within budget with many topics", () => {
    const topicsDir = path.join(tmpDir, "topics");
    fs.mkdirSync(topicsDir);
    for (let i = 0; i < 50; i++) {
      const name = `topic-with-a-long-name-number-${String(i).padStart(3, "0")}`;
      fs.writeFileSync(
        path.join(topicsDir, `${name}.md`),
        `# T\n\n## 2026-03-16\n${Array(20).fill("- fact").join("\n")}\n`,
      );
    }

    const invDir = path.join(tmpDir, "investigations");
    fs.mkdirSync(invDir);
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(
        path.join(invDir, `2026-03-${String(i).padStart(2, "0")}-12-00-00.md`),
        `# Investigation: A fairly long investigation question number ${i}\n`,
      );
    }

    const result = buildKnowledgeOverview(tmpDir);
    expect(result.length).toBeLessThanOrEqual(1800 + 150); // small slack for footer
  });

  it("handles empty topic files gracefully", () => {
    const topicsDir = path.join(tmpDir, "topics");
    fs.mkdirSync(topicsDir);
    fs.writeFileSync(path.join(topicsDir, "empty.md"), "");

    const result = buildKnowledgeOverview(tmpDir);
    // Empty file has 0 facts and unknown date — should still appear
    expect(result).toContain("| empty | 0 | unknown |");
  });

  it("handles investigation files without title gracefully", () => {
    const invDir = path.join(tmpDir, "investigations");
    fs.mkdirSync(invDir);
    fs.writeFileSync(path.join(invDir, "2026-03-10-08-00-00.md"), "no title here");

    const result = buildKnowledgeOverview(tmpDir);
    // Falls back to filename
    expect(result).toContain("2026-03-10:");
  });
});
