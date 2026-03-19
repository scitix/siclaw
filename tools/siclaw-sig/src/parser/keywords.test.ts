import { describe, it, expect } from "vitest";
import { extractKeywords } from "./keywords.js";

describe("extractKeywords — basic extraction", () => {
  it("extracts static words from a format string with %s and %d", () => {
    const result = extractKeywords("failed to connect to %s:%d");
    expect(result).toContain("failed");
    expect(result).toContain("connect");
    expect(result).not.toContain("to");
  });

  it("extracts keywords from a multi-placeholder template", () => {
    const result = extractKeywords("error creating pod %s in namespace %s");
    expect(result).toContain("error");
    expect(result).toContain("creating");
    expect(result).toContain("pod");
    expect(result).toContain("namespace");
    expect(result).not.toContain("in");
  });

  it("filters short words from %v template", () => {
    const result = extractKeywords("timeout waiting for %v");
    expect(result).toContain("timeout");
    expect(result).toContain("waiting");
    expect(result).toContain("for"); // "for" has length 3, passes MIN_KEYWORD_LENGTH filter
  });
});

describe("extractKeywords — short token filtering", () => {
  it("returns empty array when all tokens are shorter than 3 chars", () => {
    const result = extractKeywords("a]b[c d to in at is of");
    expect(result).toEqual([]);
  });

  it("filters tokens with length < 3 but keeps length >= 3", () => {
    const result = extractKeywords("pod IP not ready");
    expect(result).toContain("pod");
    expect(result).toContain("not");
    expect(result).toContain("ready");
    expect(result).not.toContain("IP");
  });
});

describe("extractKeywords — namespace preservation", () => {
  it("preserves k8s.io/client-go as one token", () => {
    const result = extractKeywords("error in k8s.io/client-go");
    expect(result).toContain("error");
    expect(result).toContain("k8s.io/client-go");
  });

  it("preserves file paths as one token", () => {
    const result = extractKeywords("pkg/server/handler.go");
    expect(result).toContain("pkg/server/handler.go");
  });
});

describe("extractKeywords — format placeholder stripping", () => {
  it("returns empty array when template is all placeholders", () => {
    const result = extractKeywords("%s %d %v %f %x %q");
    expect(result).toEqual([]);
  });

  it("strips literal %% and keeps surrounding text", () => {
    const result = extractKeywords("%%percent%%");
    expect(result).toContain("percent");
  });
});

describe("extractKeywords — deduplication and case", () => {
  it("deduplicates same word in different cases", () => {
    const result = extractKeywords("Error error ERROR");
    expect(result).toEqual(["error"]);
  });

  it("deduplicates Pod/pod/POD to single entry", () => {
    const result = extractKeywords("Pod pod POD");
    expect(result).toEqual(["pod"]);
  });
});

describe("extractKeywords — edge cases", () => {
  it("returns empty array for empty string", () => {
    expect(extractKeywords("")).toEqual([]);
  });

  it("returns empty array for whitespace-only string", () => {
    expect(extractKeywords("   ")).toEqual([]);
  });

  it("returns single keyword for single word", () => {
    expect(extractKeywords("hello")).toEqual(["hello"]);
  });

  it("returns sorted array for multiple words", () => {
    const result = extractKeywords("abc def ghi");
    expect(result).toEqual(["abc", "def", "ghi"]);
  });
});

describe("extractKeywords — punctuation splitting", () => {
  it("splits on equals, comma, colon", () => {
    const result = extractKeywords("key=value, status: running");
    expect(result).toContain("key");
    expect(result).toContain("value");
    expect(result).toContain("status");
    expect(result).toContain("running");
  });

  it("splits on parentheses and brackets", () => {
    const result = extractKeywords("(error) [warning]");
    expect(result).toContain("error");
    expect(result).toContain("warning");
  });
});
