import { describe, expect, it } from "vitest";
import {
  normalizeChatSessionPreview,
  normalizeChatSessionTitle,
  truncateChatSessionTitle,
} from "./chat-session-fields.js";

describe("chat session field normalization", () => {
  it("uses the default title when title is missing or empty", () => {
    expect(normalizeChatSessionTitle(undefined)).toBe("New Session");
    expect(normalizeChatSessionTitle("")).toBe("New Session");
  });

  it("truncates title and preview to their database column limits", () => {
    expect(normalizeChatSessionTitle("t".repeat(300))).toHaveLength(255);
    expect(normalizeChatSessionPreview("p".repeat(600))).toHaveLength(500);
  });

  it("preserves explicit update-time title clearing", () => {
    expect(truncateChatSessionTitle("")).toBe("");
    expect(truncateChatSessionTitle(null)).toBeNull();
    expect(truncateChatSessionTitle(undefined)).toBeNull();
  });

  it("does not split surrogate pairs when truncating", () => {
    const title = `${"t".repeat(254)}👋extra`;
    const truncated = normalizeChatSessionTitle(title);

    expect(truncated).toBe("t".repeat(254));
    expect(truncated).toHaveLength(254);
    expect(truncated).not.toContain("\uD83D");
  });

  it("normalizes absent preview to null", () => {
    expect(normalizeChatSessionPreview(undefined)).toBeNull();
    expect(normalizeChatSessionPreview("")).toBeNull();
  });
});
