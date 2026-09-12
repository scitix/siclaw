import { isSensitiveDataKey, redactDataDocument, REDACTION_NOTICE } from "../tools/infra/kubectl-sanitize.js";
import { sanitizeOutput } from "../tools/infra/tool-render.js";

/** Reuse tool output security for every connector, including text embedded in MCP JSON. */
export function sanitizeSandboxResult(value: unknown): unknown {
  let redacted = false;
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error("Tool result nesting exceeds budget");
    // Preserve complete data for code. The display renderer truncates and writes
    // host temp files; neither behavior belongs on this non-model data channel.
    if (typeof item === "string") {
      const safe = redactDataDocument(item);
      redacted ||= safe.redacted;
      return sanitizeOutput(safe.text);
    }
    if (Array.isArray(item)) return item.map(v => visit(v, depth + 1));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => {
      if (isSensitiveDataKey(key, child)) { redacted = true; return [key, "[REDACTED]"]; }
      return [key, visit(child, depth + 1)];
    }));
    return item;
  };
  const result = visit(value, 0);
  if (redacted && result && typeof result === "object" && !Array.isArray(result)) {
    const envelope = result as Record<string, unknown>;
    const notices = Array.isArray(envelope.notices) ? envelope.notices : [];
    envelope.notices = [...new Set([...notices, REDACTION_NOTICE.trim()])];
  }
  return result;
}
