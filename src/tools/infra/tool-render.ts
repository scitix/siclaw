import { retainSanitizedToolOutput } from "../../core/tool-output-context.js";

/**
 * Maximum characters of tool output sent to the LLM.
 * Keeps head + tail and drops the middle, so the model sees
 * both the beginning (headers, config) and end (results, errors).
 */
const MAX_CHARS = 8000;
const HEAD_CHARS = 3000;
const TAIL_CHARS = 3000;

// ANSI escape code pattern (same regex as strip-ansi package)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

// Control characters except tab(0x09), newline(0x0A), carriage return(0x0D)
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Strip ANSI escape codes and control characters from output.
 * Keeps tabs, newlines, and carriage returns.
 */
export function sanitizeOutput(text: string): string {
  return text.replace(ANSI_RE, "").replace(CTRL_RE, "");
}

/**
 * Sanitize and truncate tool output for the LLM.
 * - Strips ANSI codes and control characters
 * - Keeps the sanitized full result in the authenticated invocation for artifact storage
 * - Keeps the first HEAD_CHARS and last TAIL_CHARS characters, drops the middle
 */
export function processToolOutput(text: string): string {
  const clean = sanitizeOutput(text);
  // Empty output is a real, unambiguous result (e.g. a grep with no match) — surface
  // it like a shell would (nothing printed) rather than an empty string, which renders
  // as a stuck "Running" card and tempts the model to assume the output was hidden
  // elsewhere and invent a file path to read.
  if (clean.trim().length === 0) return "(no output)";
  if (clean.length <= MAX_CHARS) return clean;

  const head = clean.slice(0, HEAD_CHARS);
  const tail = clean.slice(-TAIL_CHARS);
  const totalLines = clean.split("\n").length;
  const preview = `${head}\n\n... [${totalLines} lines total, output truncated]\n\n${tail}`;
  if (retainSanitizedToolOutput(preview, clean)) return preview;
  // No authenticated invocation scope: never write a shared /tmp file or claim recoverability.
  return `${head}\n\n... [${totalLines} lines total, output truncated; full output unavailable without a session scope. Rerun with narrower filters.]\n\n${tail}`;
}

/** @deprecated Use processToolOutput instead */
export const truncateOutput = processToolOutput;
