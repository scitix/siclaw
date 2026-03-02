import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Text } from "@mariozechner/pi-tui";

const PREVIEW_LINES = 5;

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
 * Save text to a temporary file, return the file path.
 */
function saveTempFile(text: string): string {
  const id = randomBytes(4).toString("hex");
  const filePath = path.join(os.tmpdir(), `siclaw-output-${id}.log`);
  fs.writeFileSync(filePath, text, "utf-8");
  return filePath;
}

/**
 * Sanitize and truncate tool output for the LLM.
 * - Strips ANSI codes and control characters
 * - When truncated, saves full output to a temp file and tells the LLM the path
 * - Keeps the first HEAD_CHARS and last TAIL_CHARS characters, drops the middle
 */
export function processToolOutput(text: string): string {
  const clean = sanitizeOutput(text);
  if (clean.length <= MAX_CHARS) return clean;

  const fullPath = saveTempFile(clean);
  const head = clean.slice(0, HEAD_CHARS);
  const tail = clean.slice(-TAIL_CHARS);
  const totalLines = clean.split("\n").length;
  return `${head}\n\n... [${totalLines} lines total, output truncated. Full output saved to: ${fullPath}]\n\n${tail}`;
}

/** @deprecated Use processToolOutput instead */
export const truncateOutput = processToolOutput;

/**
 * Shared renderResult for custom tools.
 * Shows last PREVIEW_LINES when collapsed; all lines when expanded (ctrl+o).
 */
export function renderTextResult(
  result: any,
  options: any,
  theme: any,
) {
  const textBlocks = (result.content || []).filter(
    (c: any) => c.type === "text",
  );
  const output: string = textBlocks
    .map((c: any) => c.text || "")
    .join("\n")
    .trim();
  if (!output) return new Text("", 0, 0);

  const lines = output.split("\n");
  const styled = lines.map((l: string) => theme.fg("toolOutput", l));

  if (options.expanded || lines.length <= PREVIEW_LINES) {
    return new Text("\n" + styled.join("\n"), 0, 0);
  }

  const preview = styled.slice(-PREVIEW_LINES);
  const skipped = lines.length - PREVIEW_LINES;
  const hint = theme.fg(
    "muted",
    `... (${skipped} earlier lines, ctrl+o to expand)`,
  );
  return new Text("\n" + hint + "\n" + preview.join("\n"), 0, 0);
}
