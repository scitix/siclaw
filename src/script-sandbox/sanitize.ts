import { SENSITIVE_KEY_PATTERNS, redactDocument } from "../tools/infra/kubectl-sanitize.js";
import { sanitizeOutput } from "../tools/infra/tool-render.js";

/** Reuse tool output security for every connector, including text embedded in MCP JSON. */
export function sanitizeSandboxResult(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("Tool result nesting exceeds budget");
  // Preserve complete data for code. The display renderer truncates and writes
  // host temp files; neither behavior belongs on this non-model data channel.
  if (typeof value === "string") return sanitizeOutput(redactDocument(value).text);
  if (Array.isArray(value)) return value.map(v => sanitizeSandboxResult(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, SENSITIVE_KEY_PATTERNS.some(pattern => pattern.test(key)) ? "[REDACTED]" : sanitizeSandboxResult(item, depth + 1)]));
  return value;
}
