import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Text } from "@earendil-works/pi-tui";
import { OUTPUT_CHAR_BUDGET, omittedOutputBlocks, outputLineAt, outputLineStarts, sampleOutputRanges } from "./output-sampling.js";
import { currentToolOutputStore } from "./tool-output-store.js";

const PREVIEW_LINES = 5;

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
  fs.writeFileSync(filePath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return filePath;
}

/**
 * Sanitize and truncate tool output for the LLM.
 * - Strips ANSI codes and control characters
 * - Saves the full sanitized output before sampling; runtime storage is task-scoped.
 * - Distributes 8000 source characters across ceil(length / 8000) samples, then
 *   expands head/tail to at least 2000 each without reducing interior samples.
 *   The remaining omitted text forms equal gaps between the samples.
 */
export function processToolOutput(text: string): string {
  const clean = sanitizeOutput(text);
  // Empty output is a real, unambiguous result (e.g. a grep with no match) — surface
  // it like a shell would (nothing printed) rather than an empty string, which renders
  // as a stuck "Running" card and tempts the model to assume the output was hidden
  // elsewhere and invent a file path to read.
  if (clean.trim().length === 0) return "(no output)";
  if (clean.length <= OUTPUT_CHAR_BUDGET) return clean;

  const context = currentToolOutputStore();
  const outputId = context?.store.save(clean);
  const outputPath = context?.useToolReader ? undefined : context ? context.store.file(outputId!) : saveTempFile(clean);
  const readHint = context?.useToolReader
    ? `tool_output(${JSON.stringify({ output_id: outputId, offset: 1, limit: 100 })})`
    : `read(${JSON.stringify({ path: outputPath, offset: 1, limit: 100 })})`;
  const starts = outputLineStarts(clean);
  const ranges = sampleOutputRanges(clean);
  const blocks = omittedOutputBlocks(ranges, starts);
  const sampledChars = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  const parts = [`[siclaw-output ${clean.length} chars; ${starts.length} lines total; output truncated to ${sampledChars} sampled chars (8000 base budget plus head/tail minima); read selected lines with ${readHint}]`];
  let previousEnd = 0;
  let blockIndex = 0;
  for (const range of ranges) {
    if (range.start > previousEnd) {
      const block = blocks[blockIndex++];
      const expandHint = context?.useToolReader
        ? `tool_output(${JSON.stringify({ output_id: outputId, block_id: block.id })})`
        : `read(${JSON.stringify({ path: outputPath, offset: block.startLine, limit: block.endLine - block.startLine + 1 })})`;
      parts.push(`... [omitted chars ${block.start + 1}-${block.end}; lines ${block.startLine}-${block.endLine}; block ${block.id}; expand with ${expandHint}] ...`);
    }
    parts.push(`[chars ${range.start + 1}-${range.end}; lines ${outputLineAt(starts, range.start)}-${outputLineAt(starts, range.end - 1)}; boundaries may split lines]\n${clean.slice(range.start, range.end)}`);
    previousEnd = range.end;
  }
  return parts.join("\n\n");
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
