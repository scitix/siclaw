import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { OUTPUT_CHAR_BUDGET, omittedOutputBlocks, outputLineAt, outputLineStarts, sampleOutputRanges } from "./output-sampling.js";

/** The runtime owns this directory until explicit task close, including across idle rebuilds. */
export class ToolOutputStore {
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  save(text: string): string {
    // Never recreate a closed task's directory from an in-flight tool callback.
    const id = randomUUID();
    fs.writeFileSync(this.file(id), text, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return id;
  }

  file(id: string): string {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error("Invalid output_id.");
    return path.join(this.directory, `${id}.log`);
  }

  read(id: string, offset?: number, limit?: number, column = 1, blockId?: number) {
    for (const [name, value] of Object.entries({ offset, limit, column, block_id: blockId })) {
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
    }
    let text: string;
    try {
      const flags = fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
      const fd = fs.openSync(this.file(id), flags);
      try { text = fs.readFileSync(fd, "utf8"); }
      finally { fs.closeSync(fd); }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Output is unavailable in this task (unknown output_id or task already closed).");
      throw err;
    }
    const starts = outputLineStarts(text);
    const totalLines = starts.length;
    const block = blockId === undefined ? undefined : omittedOutputBlocks(sampleOutputRanges(text), starts)[blockId - 1];
    if (blockId !== undefined && !block) throw new Error(`No omitted block ${blockId} in this output.`);
    offset ??= block?.startLine ?? 1;
    if (block && (offset < block.startLine || offset > block.endLine)) {
      throw new Error(`offset must stay within block ${block.id}: lines ${block.startLine}-${block.endLine}.`);
    }
    limit ??= block ? block.endLine - offset + 1 : 100;
    if (offset > totalLines) throw new Error(`offset exceeds total_lines (${totalLines}).`);
    const lineEnd = starts[offset] ?? text.length;
    const start = starts[offset - 1] + column - 1;
    if (start > lineEnd || (offset < totalLines && start === lineEnd)) throw new Error("column exceeds the requested line.");
    // Expand complete original lines, including any partially visible boundary
    // lines. A continuation must never drift past the selected block's last line.
    const scopeEnd = block ? starts[block.endLine] ?? text.length : text.length;
    const requestedEnd = Math.min(scopeEnd, starts[Math.min(totalLines, offset - 1 + limit)] ?? text.length);
    let end = Math.min(requestedEnd, start + OUTPUT_CHAR_BUDGET);
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]) && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const nextLine = outputLineAt(starts, end);
    return {
      output_id: id, total_chars: text.length, total_lines: totalLines,
      offset, column, end_line: outputLineAt(starts, Math.max(start, end - 1)),
      ...(block ? { block: { block_id: block.id, start_line: block.startLine, end_line: block.endLine }, block_complete: end >= scopeEnd } : {}),
      output: text.slice(start, end),
      ...(end < scopeEnd ? { next: { ...(block ? { block_id: block.id } : {}), offset: nextLine, column: end - starts[nextLine - 1] + 1 } } : {}),
    };
  }

  clear(): void {
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}

// Execution-local routing avoids threading storage through every sanitizer/exec helper,
// and isolates concurrent tools/users in LocalSpawner's shared process.
const outputStoreContext = new AsyncLocalStorage<{ store: ToolOutputStore; useToolReader: boolean }>();
export function withToolOutputStore<T>(store: ToolOutputStore, run: () => T, useToolReader = true): T {
  return outputStoreContext.run({ store, useToolReader }, run);
}
export function currentToolOutputStore(): { store: ToolOutputStore; useToolReader: boolean } | undefined {
  return outputStoreContext.getStore();
}
