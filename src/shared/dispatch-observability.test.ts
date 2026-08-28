import { describe, expect, it } from "vitest";
import { compactDispatchLogMessage } from "./dispatch-observability.js";

describe("dispatch observability", () => {
  it("makes error messages single-line and bounded", () => {
    const compact = compactDispatchLogMessage(`first\nsecond ${"x".repeat(600)}`);
    expect(compact).not.toContain("\n");
    expect(compact.endsWith("…")).toBe(true);
    expect(compact.length).toBeLessThanOrEqual(513);
  });
});
