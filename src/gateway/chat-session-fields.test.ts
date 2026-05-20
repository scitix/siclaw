import { describe, expect, it } from "vitest";
import { normalizeChatSessionTitle } from "./chat-session-fields.js";

describe("chat session field normalization", () => {
  it("leaves absent titles absent so the upstream default still applies", () => {
    expect(normalizeChatSessionTitle(undefined)).toBeUndefined();
  });

  it("truncates titles before sending them to upstream storage", () => {
    expect(normalizeChatSessionTitle("t".repeat(300))).toHaveLength(255);
  });

  it("does not split surrogate pairs when truncating", () => {
    const title = `${"t".repeat(254)}👋extra`;
    const truncated = normalizeChatSessionTitle(title);

    expect(truncated).toBe("t".repeat(254));
    expect(truncated).not.toContain("\uD83D");
  });
});
