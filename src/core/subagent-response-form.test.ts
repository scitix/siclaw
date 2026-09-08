import { describe, expect, it } from "vitest";
import { buildResponseFormPrompt, parseResponseForm, validateResponseForm, SUBAGENT_RESPONSE_INSTRUCTIONS } from "./subagent-response-form.js";

const form = [
  { name: "原因", question: "故障原因？", options: { A: "上游服务错误", B: "证据不足" } },
  { name: "证据", question: "精确时间、错误和覆盖范围？" },
];

describe("sub-agent response form", () => {
  it("expands a choice to its meaning while preserving multiline evidence and colon-containing data", () => {
    const evidence = "12:00:00Z HTTP 429\nhttps://example.test/log\n覆盖:\n部分窗口";
    expect(parseResponseForm(form, `原因:\nA\n\n证据:\n${evidence}`)).toEqual({
      valid: true, text: `原因:\n上游服务错误\n\n证据:\n${evidence}`,
    });
  });

  it("accepts CRLF and regex metacharacters in declared field names", () => {
    expect(parseResponseForm([{ name: "evidence[1]", question: "What?" }], "evidence[1]:\r\n429")).toEqual({
      valid: true, text: "evidence[1]:\n429",
    });
  });

  it("does not clip later fields after 1800 or 6000 characters", () => {
    const evidence = "x".repeat(7000) + "\nLAST EVIDENCE";
    expect(parseResponseForm(form, `原因:\nA\n证据:\n${evidence}`).text).toContain(evidence);
  });

  it.each([
    "原因:\nC\n证据:\n429", // unlisted choice
    "原因:\nA", // missing field
    "原因:\nA\n原因:\nB\n证据:\n429", // ambiguous duplicate
    "原因: A\n证据: 429", // not colon + newline
    "原因:\\nA\\n证据:\\n429", // literal backslash-n
    '```visual-card\n{"conclusion":"429"}\n```',
  ])("marks malformed answers incomplete without guessing: %s", (raw) => {
    const result = parseResponseForm(form, raw);
    expect(result.valid).toBe(false);
    expect(result.text).toContain("Response form incomplete:");
  });

  it("preserves valid answers when another field is missing", () => {
    expect(parseResponseForm(form, "原因:\nA").text).toContain("原因:\n上游服务错误");
  });

  it.each([undefined, [], [{ name: "bad:name", question: "?" }], [form[0], form[0]],
    [{ name: "x", question: "" }], [{ name: "x", question: "?", options: {} }],
    [{ name: "x", question: "?", options: { A: "" } }],
  ])("rejects invalid parent configuration before spawning", (value) => {
    expect(validateResponseForm(value)).toBeTypeOf("string");
  });

  it("instructs the child to fill the form instead of applying report-card skills", () => {
    expect(validateResponseForm(form)).toBeUndefined();
    const prompt = buildResponseFormPrompt(form);
    expect(prompt).toContain("A: 上游服务错误");
    expect(prompt).toContain("原因:\n<answer>");
    expect(SUBAGENT_RESPONSE_INSTRUCTIONS).toContain("overrides presentation/report-card skills");
  });
});
