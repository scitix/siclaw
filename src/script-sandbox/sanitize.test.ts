import { expect, it } from "vitest";
import { sanitizeSandboxResult } from "./sanitize.js";
it("preserves JSON booleans and NDJSON records while redacting real credentials and reporting edits", () => {
  const rows = [false, true].map(automountServiceAccountToken => ({ spec: { automountServiceAccountToken }, password: 123456 }));
  const value = sanitizeSandboxResult({ text: rows.map(row => JSON.stringify(row)).join("\n") }) as any;
  const decoded = value.text.split("\n").map(JSON.parse);
  expect(decoded.map((row: any) => row.spec.automountServiceAccountToken)).toEqual([false, true]);
  expect(JSON.stringify(value)).not.toContain("123456");
  expect(value.notices).toHaveLength(1);
  expect((sanitizeSandboxResult(rows) as any[])[0].spec.automountServiceAccountToken).toBe(false);
});
it("sanitizes structured and text outputs from every connector", () => {
  const result = sanitizeSandboxResult({ password: "bad-pass", content: [{ type: "text", text: "token: bad-token\nhealthy" }],
    nested: { client_secret: "bad-secret", os: "Linux" }, key: "-----BEGIN PRIVATE KEY-----\nbad-pem\n-----END PRIVATE KEY-----" });
  expect(JSON.stringify(result)).not.toMatch(/bad-pass|bad-token|bad-secret|bad-pem/);
  expect(JSON.stringify(result)).toContain("Linux");
  expect(JSON.stringify(result)).toContain("healthy");
});
it("keeps complete sanitized data without display truncation or host file references", () => {
  const result = sanitizeSandboxResult({ text: "healthy\n".repeat(40_000) + "token: private-value\nlast-line" }) as any;
  expect(result.text.startsWith("healthy\n".repeat(40_000))).toBe(true);
  expect(result.text).not.toMatch(/private-value|siclaw-output|output truncated/);
  expect(result.text).toContain("last-line");
});
it("preserves JSON syntax while retaining document redaction inside values and arrays", () => {
  const payload = { password: 871234, message: "password: embedded-value\nhealthy", values: [
    "-----BEGIN PRIVATE KEY-----\nprivate-pem\n-----END PRIVATE KEY-----", "ghp_testvalue", "healthy",
  ] };
  const result = sanitizeSandboxResult({ text: JSON.stringify(payload, null, 2) }) as { text: string };
  expect(JSON.parse(result.text).values[2]).toBe("healthy");
  expect(result.text).not.toMatch(/871234|embedded-value|private-pem|ghp_testvalue/);
});
