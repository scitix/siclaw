import { describe, it, expect } from "vitest";
import { parseRustFormat } from "./rust-format.js";

describe("parseRustFormat — format macro placeholders", () => {
  it("converts {} to imprecise match (medium confidence)", () => {
    const result = parseRustFormat("listening on {}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
    expect(result.verbs[0].precise).toBe(false);
  });

  it("converts {:?} debug placeholder", () => {
    const result = parseRustFormat("connection failed: {:?}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
  });

  it("converts {:#?} pretty-debug placeholder", () => {
    const result = parseRustFormat("state: {:#?}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
  });

  it("converts {name} named parameter", () => {
    const result = parseRustFormat("hello {name}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
  });

  it("returns exact for pure static string", () => {
    const result = parseRustFormat("server started");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.verbs).toHaveLength(0);
    expect(new RegExp(result.regex!).test("server started")).toBe(true);
  });

  it("handles empty string", () => {
    const result = parseRustFormat("");
    expect(result.regex).toBe("^$");
    expect(result.confidence).toBe("exact");
  });

  it("real Rust: failed to bind to {}: {:?}", () => {
    const result = parseRustFormat("failed to bind to {}: {:?}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(2);
  });

  it("real Rust: spawned {} tasks", () => {
    const result = parseRustFormat("spawned {} tasks");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
  });

  it("handles format specifier {:x}", () => {
    const result = parseRustFormat("address: {:x}");
    expect(result.confidence).toBe("medium");
    expect(result.regex).toBeNull();
    expect(result.verbs).toHaveLength(1);
  });

  it("handles escaped braces {{ }} as literals", () => {
    const result = parseRustFormat("JSON: {{key}}");
    // {{ and }} are escaped braces — not placeholders
    expect(result.verbs).toHaveLength(0);
    expect(result.confidence).toBe("exact");
  });

  it("escapes regex special chars in static text", () => {
    const result = parseRustFormat("error in [module]");
    expect(result.confidence).toBe("exact");
    expect(result.regex).not.toBeNull();
    expect(result.regex).toContain("\\[module\\]");
    expect(new RegExp(result.regex!).test("error in [module]")).toBe(true);
  });
});
