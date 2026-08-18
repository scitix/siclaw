import { describe, expect, it } from "vitest";
import { registration } from "./knowledge-cite.js";

describe("knowledge_cite registration", () => {
  const tool = { name: "knowledge_cite" } as any;

  it("requires both the per-session tool and an event delivery sink", () => {
    expect(registration.available?.({ knowledgeCitationTool: tool } as any)).toBe(false);
    expect(registration.available?.({
      knowledgeCitationTool: tool,
      sessionEventEmitter: () => {},
    } as any)).toBe(true);
  });
});
