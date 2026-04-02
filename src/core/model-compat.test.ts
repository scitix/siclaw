import { describe, it, expect } from "vitest";
import { inferModelCompat, mergeCompat } from "./model-compat.js";

describe("inferModelCompat", () => {
  it("detects Kimi by model ID", () => {
    const compat = inferModelCompat("moonshotai/Kimi-K2.5", "https://api.siflow.cn/model-api");
    expect(compat.thinkingFormat).toBe("qwen");
    expect(compat.maxTokensField).toBe("max_tokens");
  });

  it("detects Moonshot by URL", () => {
    const compat = inferModelCompat("some-model", "https://api.moonshot.cn/v1");
    expect(compat.thinkingFormat).toBe("qwen");
  });

  it("detects Qwen by model ID", () => {
    const compat = inferModelCompat("Qwen/Qwen3-235B-A22B", "https://some-api.com");
    expect(compat.thinkingFormat).toBe("qwen");
  });

  it("detects Qwen by DashScope URL", () => {
    const compat = inferModelCompat("some-model", "https://dashscope.aliyuncs.com/v1");
    expect(compat.thinkingFormat).toBe("qwen");
  });

  it("detects DeepSeek by model ID", () => {
    const compat = inferModelCompat("deepseek-r1", "https://api.example.com");
    expect(compat.thinkingFormat).toBe("openai");
  });

  it("detects DeepSeek by URL", () => {
    const compat = inferModelCompat("some-model", "https://api.deepseek.com/v1");
    expect(compat.thinkingFormat).toBe("openai");
  });

  it("returns empty for unknown model", () => {
    const compat = inferModelCompat("claude-3-opus", "https://api.anthropic.com");
    expect(compat.thinkingFormat).toBeUndefined();
  });
});

describe("mergeCompat", () => {
  it("fills missing fields from inference", () => {
    const merged = mergeCompat({}, "moonshotai/Kimi-K2.5", "https://api.siflow.cn");
    expect(merged.thinkingFormat).toBe("qwen");
  });

  it("does not override explicit DB values", () => {
    const merged = mergeCompat(
      { thinkingFormat: "openai" },
      "moonshotai/Kimi-K2.5",
      "https://api.siflow.cn",
    );
    expect(merged.thinkingFormat).toBe("openai"); // DB wins
  });

  it("preserves unrelated explicit fields", () => {
    const merged = mergeCompat(
      { supportsToolUse: true },
      "moonshotai/Kimi-K2.5",
      "https://api.siflow.cn",
    );
    expect(merged.supportsToolUse).toBe(true);
    expect(merged.thinkingFormat).toBe("qwen");
  });
});
