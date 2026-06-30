import { describe, it, expect } from "vitest";
import { stripUserDirectiveFromEvent } from "../http-server.js";

// The injected `[System: respond in X]` directive must not surface in the user
// message rendered/streamed to consumers. These cover the live brain-event shapes
// the agentbox forwards via writeEvent.

describe("stripUserDirectiveFromEvent", () => {
  it("strips the directive from a user message with array content", () => {
    const out = stripUserDirectiveFromEvent({
      type: "message_end",
      message: { role: "user", content: [{ type: "text", text: "[System: respond in Chinese]\n你好" }] },
    }) as any;
    expect(out.message.content[0].text).toBe("你好");
    expect(out.type).toBe("message_end");
  });

  it("strips the directive from a user message with string content", () => {
    const out = stripUserDirectiveFromEvent({
      type: "message_start",
      message: { role: "user", content: "[System: respond in Chinese]\n你好" },
    }) as any;
    expect(out.message.content).toBe("你好");
  });

  it("preserves a leading Deep-Investigation marker, stripping only the directive", () => {
    const out = stripUserDirectiveFromEvent({
      message: { role: "user", content: [{ type: "text", text: "[Deep Investigation]\n[System: respond in Chinese]\n你好" }] },
    }) as any;
    expect(out.message.content[0].text).toBe("[Deep Investigation]\n你好");
  });

  it("leaves assistant / non-user message events untouched", () => {
    const assistant = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } };
    expect(stripUserDirectiveFromEvent(assistant)).toBe(assistant);
  });

  it("leaves directive-free user messages and non-message events untouched (same reference)", () => {
    const clean = { message: { role: "user", content: "你好" } };
    expect(stripUserDirectiveFromEvent(clean)).toBe(clean);
    const tool = { type: "tool_execution_start", toolName: "bash" };
    expect(stripUserDirectiveFromEvent(tool)).toBe(tool);
  });
});
