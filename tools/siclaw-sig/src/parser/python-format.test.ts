import { describe, it, expect } from "vitest";
import { parsePythonFormat } from "./python-format.js";

describe("parsePythonFormat — %-style verbs", () => {
  it("converts %s to regex that matches string", () => {
    const result = parsePythonFormat("connection to %s failed");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(1);
    expect(result.verbs[0].verb).toBe("s");
    expect(new RegExp(result.regex!).test("connection to 10.0.0.1 failed")).toBe(true);
  });

  it("converts %d to regex that matches integer", () => {
    const result = parsePythonFormat("port %d is in use");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(new RegExp(result.regex!).test("port 8080 is in use")).toBe(true);
  });

  it("converts %f to regex that matches float", () => {
    const result = parsePythonFormat("latency: %f ms");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(new RegExp(result.regex!).test("latency: 12.5 ms")).toBe(true);
  });

  it("converts %r to imprecise match", () => {
    const result = parsePythonFormat("received %r from peer");
    expect(result.verbs[0].verb).toBe("r");
    expect(result.verbs[0].precise).toBe(false);
    // Only imprecise → medium
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });

  it("converts %x to hex match", () => {
    const result = parsePythonFormat("address: 0x%x");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(new RegExp(result.regex!).test("address: 0x1a2b3c")).toBe(true);
  });

  it("treats %% as literal percent sign", () => {
    const result = parsePythonFormat("100%% complete");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(0);
    expect(new RegExp(result.regex!).test("100% complete")).toBe(true);
  });

  it("returns high confidence for mixed %s + %r", () => {
    const result = parsePythonFormat("error %s: %r");
    expect(result.confidence).toBe("high");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(2);
  });

  it("handles real Python log: Failed to connect to %s:%d", () => {
    const result = parsePythonFormat("Failed to connect to %s:%d");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(new RegExp(result.regex!).test("Failed to connect to db.local:5432")).toBe(true);
  });
});

describe("parsePythonFormat — {}-style placeholders", () => {
  it("converts {} to imprecise match (medium confidence)", () => {
    const result = parsePythonFormat("connection to {} failed");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
    expect(result.verbs[0].precise).toBe(false);
  });

  it("converts {0} positional placeholder", () => {
    const result = parsePythonFormat("error {0} on host {1}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(2);
  });

  it("converts {name} named placeholder", () => {
    const result = parsePythonFormat("user {name} logged in");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
  });

  it("converts {:.2f} to precise float match", () => {
    const result = parsePythonFormat("value: {:.2f}");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs[0].precise).toBe(true);
    expect(new RegExp(result.regex!).test("value: 3.14")).toBe(true);
  });

  it("converts {:d} to precise integer match", () => {
    const result = parsePythonFormat("count: {:d}");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(new RegExp(result.regex!).test("count: 42")).toBe(true);
  });

  it("converts {!r} to imprecise match", () => {
    const result = parsePythonFormat("received {!r}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs[0].precise).toBe(false);
  });

  it("handles real Python log: User {} logged in from {}", () => {
    const result = parsePythonFormat("User {} logged in from {}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(2);
  });
});

describe("parsePythonFormat — edge cases", () => {
  it("returns exact for pure static string", () => {
    const result = parsePythonFormat("no placeholders here");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(0);
    expect(new RegExp(result.regex!).test("no placeholders here")).toBe(true);
  });

  it("handles empty string", () => {
    const result = parsePythonFormat("");
    expect(result.regex).toBe("^$");
    expect(result.confidence).toBe("exact");
    expect(result.verbs).toHaveLength(0);
  });

  it("prefers %-style when both styles present", () => {
    const result = parsePythonFormat("error %s in {}");
    // Should parse as %-style: %s is the verb, {} is static text
    expect(result.verbs).toHaveLength(1);
    expect(result.verbs[0].verb).toBe("s");
  });

  it("downgrades consecutive %s via ReDoS guard", () => {
    const result = parsePythonFormat("%s%s%s");
    expect(result.verbs).toHaveLength(3);
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
  });
});
