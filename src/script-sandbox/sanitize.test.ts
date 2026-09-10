import { expect, it } from "vitest";
import { sanitizeSandboxResult } from "./sanitize.js";
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
