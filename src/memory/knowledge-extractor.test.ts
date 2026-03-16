import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractConversationKnowledge, mergeTopicFiles, type TopicEntry } from "./knowledge-extractor.js";

// ─── extractConversationKnowledge ───

// Mock global fetch for LLM API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function makeFetchResponse(toolArgs: Record<string, unknown>) {
  return {
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          tool_calls: [{
            function: { arguments: JSON.stringify(toolArgs) },
          }],
        },
      }],
    }),
  };
}

const llmConfig = { apiKey: "test-key", baseUrl: "https://api.test.com", model: "test-model" };

describe("extractConversationKnowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns extracted entries when LLM finds knowledge", async () => {
    mockFetch.mockResolvedValue(makeFetchResponse({
      should_extract: true,
      entries: [
        { topic: "environment", facts: ["Cluster gpu-east-1 has 48 A100 nodes"] },
        { topic: "commands", facts: ["Use roce-show-node-mode to check RoCE mode"] },
      ],
    }));

    const result = await extractConversationKnowledge({
      messages: [
        { role: "user", text: "What cluster are we using?" },
        { role: "assistant", text: "Cluster gpu-east-1 has 48 A100 nodes" },
      ],
      llmConfig,
    });

    expect(result).toHaveLength(2);
    expect(result[0].topic).toBe("environment");
    expect(result[0].facts).toEqual(["Cluster gpu-east-1 has 48 A100 nodes"]);
  });

  it("returns empty array when should_extract is false", async () => {
    mockFetch.mockResolvedValue(makeFetchResponse({
      should_extract: false,
    }));

    const result = await extractConversationKnowledge({
      messages: [
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi there!" },
      ],
      llmConfig,
    });

    expect(result).toEqual([]);
  });

  it("returns empty array when LLM returns no tool_calls", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "some text" } }],
      }),
    });

    const result = await extractConversationKnowledge({
      messages: [{ role: "user", text: "test" }],
      llmConfig,
    });

    expect(result).toEqual([]);
  });

  it("throws on API error", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    await expect(extractConversationKnowledge({
      messages: [{ role: "user", text: "test" }],
      llmConfig,
    })).rejects.toThrow("LLM API error 500");
  });

  it("filters out entries with empty facts", async () => {
    mockFetch.mockResolvedValue(makeFetchResponse({
      should_extract: true,
      entries: [
        { topic: "environment", facts: ["Cluster info"] },
        { topic: "commands", facts: [] },
      ],
    }));

    const result = await extractConversationKnowledge({
      messages: [{ role: "user", text: "test" }],
      llmConfig,
    });

    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe("environment");
  });

  it("rejects topics outside the allowed set (path traversal defense)", async () => {
    mockFetch.mockResolvedValue(makeFetchResponse({
      should_extract: true,
      entries: [
        { topic: "../../.env", facts: ["secret=leaked"] },
        { topic: "environment", facts: ["Cluster is prod-us-west"] },
        { topic: "invented_category", facts: ["something"] },
      ],
    }));

    const result = await extractConversationKnowledge({
      messages: [{ role: "user", text: "test" }],
      llmConfig,
    });

    expect(result).toHaveLength(1);
    expect(result[0].topic).toBe("environment");
  });

  it("truncates long messages in prompt", async () => {
    mockFetch.mockResolvedValue(makeFetchResponse({
      should_extract: false,
    }));

    const longMessage = "x".repeat(2000);
    await extractConversationKnowledge({
      messages: [{ role: "user", text: longMessage }],
      llmConfig,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    const prompt = body.messages[0].content;
    expect(prompt).toContain("...");
    // Should be truncated, not contain full 2000 chars
    expect(prompt.length).toBeLessThan(2000 + 500); // prompt overhead
  });
});

// ─── mergeTopicFiles ───

describe("mergeTopicFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates new topic file in empty directory", async () => {
    const entries: TopicEntry[] = [
      { topic: "environment", facts: ["Cluster gpu-east-1 has 48 A100 nodes", "K8s 1.29.2"] },
    ];

    const result = await mergeTopicFiles(tmpDir, entries);

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("environment.md");

    const content = fs.readFileSync(result[0], "utf-8");
    expect(content).toContain("# Environment");
    expect(content).toContain("- Cluster gpu-east-1 has 48 A100 nodes");
    expect(content).toContain("- K8s 1.29.2");
  });

  it("appends to existing topic file with new date section", async () => {
    // Pre-create a topic file with old content
    const topicsDir = path.join(tmpDir, "topics");
    fs.mkdirSync(topicsDir, { recursive: true });
    fs.writeFileSync(
      path.join(topicsDir, "environment.md"),
      "# Environment\n\n## 2026-03-14\n- Staging cluster uses k8s 1.28.5\n",
      "utf-8",
    );

    const entries: TopicEntry[] = [
      { topic: "environment", facts: ["Production cluster has 48 nodes"] },
    ];

    const result = await mergeTopicFiles(tmpDir, entries);

    expect(result).toHaveLength(1);
    const content = fs.readFileSync(result[0], "utf-8");
    expect(content).toContain("# Environment");
    expect(content).toContain("- Staging cluster uses k8s 1.28.5");
    expect(content).toContain("- Production cluster has 48 nodes");
  });

  it("deduplicates facts (case-insensitive)", async () => {
    const topicsDir = path.join(tmpDir, "topics");
    fs.mkdirSync(topicsDir, { recursive: true });
    fs.writeFileSync(
      path.join(topicsDir, "commands.md"),
      "# Commands\n\n## 2026-03-14\n- Use kubectl get pods for listing\n",
      "utf-8",
    );

    const entries: TopicEntry[] = [
      { topic: "commands", facts: ["use kubectl get pods for listing", "kubectl logs -f for streaming"] },
    ];

    const result = await mergeTopicFiles(tmpDir, entries);

    expect(result).toHaveLength(1);
    const content = fs.readFileSync(result[0], "utf-8");
    // The duplicate should be removed
    const matches = content.match(/kubectl get pods/gi);
    expect(matches).toHaveLength(1);
    // But the new unique fact should be added
    expect(content).toContain("- kubectl logs -f for streaming");
  });

  it("returns empty array when all facts are duplicates", async () => {
    const topicsDir = path.join(tmpDir, "topics");
    fs.mkdirSync(topicsDir, { recursive: true });
    fs.writeFileSync(
      path.join(topicsDir, "environment.md"),
      "# Environment\n\n## 2026-03-14\n- Cluster has 48 nodes\n",
      "utf-8",
    );

    const entries: TopicEntry[] = [
      { topic: "environment", facts: ["Cluster has 48 nodes"] },
    ];

    const result = await mergeTopicFiles(tmpDir, entries);
    expect(result).toHaveLength(0);
  });

  it("handles multiple topics in a single call", async () => {
    const entries: TopicEntry[] = [
      { topic: "environment", facts: ["Cluster gpu-east-1"] },
      { topic: "troubleshooting", facts: ["MTU mismatch causes packet drops"] },
      { topic: "commands", facts: ["roce-show-node-mode for mode check"] },
    ];

    const result = await mergeTopicFiles(tmpDir, entries);

    expect(result).toHaveLength(3);
    expect(fs.existsSync(path.join(tmpDir, "topics", "environment.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "topics", "troubleshooting.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "topics", "commands.md"))).toBe(true);
  });

  it("skips entries with empty facts after filtering", async () => {
    const entries: TopicEntry[] = [
      { topic: "environment", facts: ["", "  "] },
    ];

    const result = await mergeTopicFiles(tmpDir, entries);
    expect(result).toHaveLength(0);
  });

  it("creates topics directory if it does not exist", async () => {
    const entries: TopicEntry[] = [
      { topic: "architecture", facts: ["Service mesh with Istio"] },
    ];

    const result = await mergeTopicFiles(tmpDir, entries);

    expect(result).toHaveLength(1);
    expect(fs.existsSync(path.join(tmpDir, "topics"))).toBe(true);
  });
});
