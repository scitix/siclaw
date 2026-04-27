import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { shouldConsolidate, consolidateTopicFile, triggerConsolidationIfNeeded } from "./topic-consolidator.js";

// Mock llmCompleteWithTool to avoid real API calls
vi.mock("../core/llm-tool-call.js", () => ({
  llmCompleteWithTool: vi.fn(),
}));

import { llmCompleteWithTool } from "../core/llm-tool-call.js";

const mockLlmComplete = vi.mocked(llmCompleteWithTool);

describe("shouldConsolidate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "consolidator-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns false for non-existent file", () => {
    expect(shouldConsolidate(path.join(tmpDir, "nope.md"))).toBe(false);
  });

  it("returns false for file below thresholds", () => {
    const file = path.join(tmpDir, "env.md");
    fs.writeFileSync(file, `# Env\n\n## 2026-03-17\n- fact one\n- fact two\n`);
    expect(shouldConsolidate(file)).toBe(false);
  });

  it("returns true when date sections >= 5", () => {
    const file = path.join(tmpDir, "env.md");
    fs.writeFileSync(file, [
      "# Env",
      "",
      "## 2026-03-17",
      "- fact a",
      "",
      "## 2026-03-16",
      "- fact b",
      "",
      "## 2026-03-15",
      "- fact c",
      "",
      "## 2026-03-14",
      "- fact d",
      "",
      "## 2026-03-13",
      "- fact e",
    ].join("\n"));
    expect(shouldConsolidate(file)).toBe(true);
  });

  it("returns false when date sections < 5", () => {
    const file = path.join(tmpDir, "env.md");
    fs.writeFileSync(file, [
      "# Env",
      "",
      "## 2026-03-17",
      "- fact a",
      "",
      "## 2026-03-16",
      "- fact b",
      "",
      "## 2026-03-15",
      "- fact c",
    ].join("\n"));
    expect(shouldConsolidate(file)).toBe(false);
  });

  it("returns true when fact lines >= 20", () => {
    const file = path.join(tmpDir, "env.md");
    const facts = Array.from({ length: 20 }, (_, i) => `- fact ${i}`).join("\n");
    fs.writeFileSync(file, `# Env\n\n## 2026-03-17\n${facts}\n`);
    expect(shouldConsolidate(file)).toBe(true);
  });

  it("skips files consolidated today", () => {
    const file = path.join(tmpDir, "env.md");
    const today = new Date().toISOString().slice(0, 10);
    const facts = Array.from({ length: 25 }, (_, i) => `- fact ${i}`).join("\n");
    fs.writeFileSync(file, `Last consolidated: ${today}\n# Env\n\n${facts}\n`);
    expect(shouldConsolidate(file)).toBe(false);
  });

  it("does not skip files consolidated on a different day", () => {
    const file = path.join(tmpDir, "env.md");
    const facts = Array.from({ length: 25 }, (_, i) => `- fact ${i}`).join("\n");
    fs.writeFileSync(file, `Last consolidated: 2026-01-01\n# Env\n\n${facts}\n`);
    expect(shouldConsolidate(file)).toBe(true);
  });
});

describe("consolidateTopicFile", () => {
  let tmpDir: string;
  const llmConfig = { apiKey: "test", baseUrl: "http://localhost", model: "test-model" };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "consolidator-test-"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewrites file with consolidated facts and header", async () => {
    const file = path.join(tmpDir, "environment.md");
    fs.writeFileSync(file, [
      "# Environment",
      "",
      "## 2026-03-17",
      "- Cluster has 64 A100 nodes",
      "- K8s 1.29.2",
      "",
      "## 2026-03-16",
      "- Cluster has 48 A100 nodes",
      "- K8s 1.29.2",
    ].join("\n"));

    mockLlmComplete.mockResolvedValueOnce({
      toolArgs: {
        consolidated_facts: [
          "Cluster has 64 A100 nodes",
          "K8s 1.29.2",
        ],
        changes_summary: "merged 1 duplicate, resolved 1 contradiction (node count 48→64)",
      },
      textContent: "",
    });

    await consolidateTopicFile(file, llmConfig);

    const result = fs.readFileSync(file, "utf-8");
    const today = new Date().toISOString().slice(0, 10);
    expect(result).toContain(`Last consolidated: ${today}`);
    expect(result).toContain("# Environment");
    expect(result).toContain("- Cluster has 64 A100 nodes");
    expect(result).toContain("- K8s 1.29.2");
    // Old date sections should be gone
    expect(result).not.toContain("## 2026-03-17");
    expect(result).not.toContain("## 2026-03-16");
    expect(result).not.toContain("48 A100");
  });

  it("preserves file when LLM returns empty result", async () => {
    const file = path.join(tmpDir, "env.md");
    const original = "# Env\n\n## 2026-03-17\n- fact\n";
    fs.writeFileSync(file, original);

    mockLlmComplete.mockResolvedValueOnce({
      toolArgs: null,
      textContent: "",
    });

    await consolidateTopicFile(file, llmConfig);
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });

  it("skips write when file modified during consolidation", async () => {
    const file = path.join(tmpDir, "env.md");
    const original = "# Env\n\n## 2026-03-17\n- fact\n";
    fs.writeFileSync(file, original);

    mockLlmComplete.mockImplementation(async () => {
      // Simulate concurrent modification
      fs.writeFileSync(file, original + "\n- new concurrent fact\n");
      return {
        toolArgs: {
          consolidated_facts: ["fact"],
          changes_summary: "no changes",
        },
        textContent: "",
      };
    });

    await consolidateTopicFile(file, llmConfig);
    // File should have the concurrent modification, not the consolidation
    expect(fs.readFileSync(file, "utf-8")).toContain("new concurrent fact");
  });

  it("LLM failure does not corrupt file", async () => {
    const file = path.join(tmpDir, "env.md");
    const original = "# Env\n\n## 2026-03-17\n- fact\n";
    fs.writeFileSync(file, original);

    mockLlmComplete.mockRejectedValueOnce(new Error("API timeout"));

    await expect(consolidateTopicFile(file, llmConfig)).rejects.toThrow("API timeout");
    expect(fs.readFileSync(file, "utf-8")).toBe(original);
  });
});

describe("triggerConsolidationIfNeeded", () => {
  let tmpDir: string;
  let memoryDir: string;
  const llmConfig = { apiKey: "test", baseUrl: "http://localhost", model: "test-model" };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "consolidator-test-"));
    memoryDir = path.join(tmpDir, "memory");
    fs.mkdirSync(path.join(memoryDir, "topics"), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("consolidates files that meet thresholds", async () => {
    const file = path.join(memoryDir, "topics", "env.md");
    const facts = Array.from({ length: 25 }, (_, i) => `- fact ${i}`).join("\n");
    fs.writeFileSync(file, `# Env\n\n## 2026-03-17\n${facts}\n`);

    mockLlmComplete.mockResolvedValueOnce({
      toolArgs: {
        consolidated_facts: ["fact 0", "fact 1"],
        changes_summary: "merged duplicates",
      },
      textContent: "",
    });

    await triggerConsolidationIfNeeded(memoryDir, [file], llmConfig);
    expect(mockLlmComplete).toHaveBeenCalledTimes(1);
  });

  it("skips files below thresholds", async () => {
    const file = path.join(memoryDir, "topics", "env.md");
    fs.writeFileSync(file, `# Env\n\n## 2026-03-17\n- one fact\n`);

    await triggerConsolidationIfNeeded(memoryDir, [file], llmConfig);
    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  it("skips files outside topics/", async () => {
    const file = path.join(memoryDir, "PROFILE.md");
    fs.writeFileSync(file, "# Profile\n");

    await triggerConsolidationIfNeeded(memoryDir, [file], llmConfig);
    expect(mockLlmComplete).not.toHaveBeenCalled();
  });

  // Removed: "mergeTopicFiles can append to consolidated file" was a hollow test
  // that only wrote a file and read it back, without exercising any module behavior.
  // Actual mergeTopicFiles coverage belongs in knowledge-extractor.test.ts.
});
