import { describe, it, expect } from "vitest";
import { validateRegex } from "./redos-guard.js";

describe("validateRegex — safe patterns", () => {
  it('simple anchored string is safe', () => {
    expect(validateRegex("^hello world$")).toEqual({ safe: true });
  });

  it("static separator between groups is safe", () => {
    const result = validateRegex("^failed to connect to (.*):(\\d+)$");
    expect(result.safe).toBe(true);
  });

  it("long static separator between groups is safe", () => {
    const result = validateRegex("^pod (.*) in namespace (.*)$");
    expect(result.safe).toBe(true);
  });

  it("precise groups only are safe", () => {
    expect(validateRegex("^error: (-?\\d+)$")).toEqual({ safe: true });
  });
});

describe("validateRegex — dangerous patterns", () => {
  it("consecutive (.*)(.*) is dangerous", () => {
    const result = validateRegex("(.*)(.*)");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("catastrophic backtracking");
  });

  it("three consecutive (.*) groups is dangerous", () => {
    const result = validateRegex("(.*)(.*)(.*)");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("catastrophic backtracking");
  });

  it("consecutive (.+)(.+) is dangerous", () => {
    const result = validateRegex("(.+)(.+)");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("catastrophic backtracking");
  });

  it("single-char separator is insufficient", () => {
    const result = validateRegex("(.*):(.*)");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("catastrophic backtracking");
  });

  it("11 unbounded groups exceeds limit", () => {
    const pattern = Array.from({ length: 11 }, () => "(.*)").join("--");
    const result = validateRegex(pattern);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("too many capture groups");
  });
});

describe("validateRegex — invalid regex", () => {
  it("unclosed bracket is invalid", () => {
    const result = validateRegex("([");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("invalid regex");
  });

  it("leading quantifier is invalid", () => {
    const result = validateRegex("*invalid");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("invalid regex");
  });
});

describe("validateRegex — edge cases", () => {
  it("empty string is safe", () => {
    expect(validateRegex("")).toEqual({ safe: true });
  });

  it("^$ is safe", () => {
    expect(validateRegex("^$")).toEqual({ safe: true });
  });

  it("single (.*) group is safe", () => {
    expect(validateRegex("(.*)")).toEqual({ safe: true });
  });
});
