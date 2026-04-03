import { describe, it, expect } from "vitest";
import { findPendingSteerIndex, removePendingAt, extractUserMessageText } from "./steer-pending.js";

describe("findPendingSteerIndex", () => {
  it("finds exact match", () => {
    const pending = ["check pod A", "look at logs"];
    expect(findPendingSteerIndex(pending, "check pod A")).toBe(0);
    expect(findPendingSteerIndex(pending, "look at logs")).toBe(1);
  });

  it("matches with leading/trailing whitespace tolerance", () => {
    const pending = ["check pod A"];
    expect(findPendingSteerIndex(pending, "  check pod A  ")).toBe(0);
  });

  it("matches when pending has whitespace", () => {
    const pending = ["  check pod A  "];
    expect(findPendingSteerIndex(pending, "check pod A")).toBe(0);
  });

  it("returns -1 for non-matching text", () => {
    const pending = ["check pod A"];
    expect(findPendingSteerIndex(pending, "check pod B")).toBe(-1);
  });

  it("returns -1 for empty incoming text", () => {
    const pending = ["check pod A"];
    expect(findPendingSteerIndex(pending, "")).toBe(-1);
    expect(findPendingSteerIndex(pending, "   ")).toBe(-1);
  });

  it("returns -1 for empty pending array", () => {
    expect(findPendingSteerIndex([], "anything")).toBe(-1);
  });

  it("finds first match when duplicates exist", () => {
    const pending = ["retry", "other", "retry"];
    expect(findPendingSteerIndex(pending, "retry")).toBe(0);
  });
});

describe("removePendingAt", () => {
  it("removes at given index", () => {
    const pending = ["a", "b", "c"];
    expect(removePendingAt(pending, 1)).toEqual(["a", "c"]);
  });

  it("removes first element", () => {
    const pending = ["a", "b", "c"];
    expect(removePendingAt(pending, 0)).toEqual(["b", "c"]);
  });

  it("removes last element", () => {
    const pending = ["a", "b", "c"];
    expect(removePendingAt(pending, 2)).toEqual(["a", "b"]);
  });

  it("returns copy when index is out of bounds", () => {
    const pending = ["a", "b"];
    expect(removePendingAt(pending, -1)).toEqual(["a", "b"]);
    expect(removePendingAt(pending, 5)).toEqual(["a", "b"]);
  });

  it("does not mutate the original array", () => {
    const pending = ["a", "b", "c"];
    removePendingAt(pending, 1);
    expect(pending).toEqual(["a", "b", "c"]);
  });

  it("handles single-element array", () => {
    expect(removePendingAt(["only"], 0)).toEqual([]);
  });
});

describe("steer pending integration scenarios", () => {
  it("correctly processes sequential steer consumption", () => {
    let pending = ["msg1", "msg2", "msg3"];

    // message_start arrives for msg1
    const idx1 = findPendingSteerIndex(pending, "msg1");
    expect(idx1).toBe(0);
    pending = removePendingAt(pending, idx1);
    expect(pending).toEqual(["msg2", "msg3"]);

    // message_start arrives for msg3 (out of order)
    const idx3 = findPendingSteerIndex(pending, "msg3");
    expect(idx3).toBe(1);
    pending = removePendingAt(pending, idx3);
    expect(pending).toEqual(["msg2"]);

    // message_start arrives for msg2
    const idx2 = findPendingSteerIndex(pending, "msg2");
    expect(idx2).toBe(0);
    pending = removePendingAt(pending, idx2);
    expect(pending).toEqual([]);
  });

  it("non-steer message_start does not affect pending", () => {
    const pending = ["steer msg"];
    // A normal user message (initial prompt) echoed back — not in pending
    const idx = findPendingSteerIndex(pending, "initial prompt text");
    expect(idx).toBe(-1);
    // pending unchanged
    expect(pending).toEqual(["steer msg"]);
  });

  it("duplicate steer messages are consumed one at a time", () => {
    let pending = ["retry", "retry"];

    // First message_start for "retry" — consumes index 0
    const idx1 = findPendingSteerIndex(pending, "retry");
    expect(idx1).toBe(0);
    pending = removePendingAt(pending, idx1);
    expect(pending).toEqual(["retry"]);

    // Second message_start for "retry" — consumes the remaining one
    const idx2 = findPendingSteerIndex(pending, "retry");
    expect(idx2).toBe(0);
    pending = removePendingAt(pending, idx2);
    expect(pending).toEqual([]);
  });

  it("simulates removePendingMessage (user deletes index 1 of 3)", () => {
    const pending = ["msg1", "msg2", "msg3"];
    // User removes msg2 (index 1) — capture remaining for re-steer
    const remaining = removePendingAt(pending, 1);
    expect(remaining).toEqual(["msg1", "msg3"]);
    // remaining is used to re-steer in order: msg1, msg3
  });
});

describe("extractUserMessageText", () => {
  it("extracts from TextContent array", () => {
    expect(extractUserMessageText([
      { type: "text", text: "hello" },
      { type: "text", text: " world" },
    ])).toBe("hello world");
  });

  it("extracts from plain string", () => {
    expect(extractUserMessageText("hello world")).toBe("hello world");
  });

  it("filters out non-text content blocks", () => {
    expect(extractUserMessageText([
      { type: "text", text: "hello" },
      { type: "image", data: "base64..." },
    ])).toBe("hello");
  });

  it("returns empty for undefined/null", () => {
    expect(extractUserMessageText(undefined)).toBe("");
    expect(extractUserMessageText(null)).toBe("");
  });

  it("returns empty for empty array", () => {
    expect(extractUserMessageText([])).toBe("");
  });

  it("handles missing text field gracefully", () => {
    expect(extractUserMessageText([{ type: "text" }])).toBe("");
  });
});
