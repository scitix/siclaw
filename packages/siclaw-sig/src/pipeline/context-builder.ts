/**
 * Context builder — reads Go source files and extracts package name,
 * enclosing function name, and surrounding source lines.
 *
 * Phase 4, Plan 01: The only new algorithmic component in the CLI pipeline.
 * Semgrep provides file + line but not package/function context.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

/** Source context for a log call site, matching SigRecord.context shape. */
export interface SourceContext {
  package: string;
  function: string;
  source_lines: string[];
  line_range: [number, number];
}

/** Builds source context from Go source files with per-file caching. */
export class ContextBuilder {
  private fileCache = new Map<string, string[]>();

  constructor(private readonly srcPath: string) {}

  /**
   * Build full source context for a log call at the given file and line.
   *
   * @param relativeFile - File path relative to srcPath
   * @param line - 1-based line number of the log call
   */
  async build(relativeFile: string, line: number): Promise<SourceContext> {
    const lines = await this.readLines(relativeFile);
    const pkg = this.extractPackage(lines);
    const fn = this.findEnclosingFunction(lines, line);
    const { source_lines, line_range } = this.captureSourceLines(lines, line);

    return { package: pkg, function: fn, source_lines, line_range };
  }

  private async readLines(relativeFile: string): Promise<string[]> {
    const cached = this.fileCache.get(relativeFile);
    if (cached) return cached;

    const absPath = path.join(this.srcPath, relativeFile);
    let content: string;
    try {
      content = await readFile(absPath, "utf-8");
    } catch {
      throw new Error(`Source file not found: ${absPath}`);
    }

    const lines = content.split("\n");
    this.fileCache.set(relativeFile, lines);
    return lines;
  }

  private extractPackage(lines: string[]): string {
    for (const line of lines) {
      const m = line.match(/^package\s+(\w+)/);
      if (m) return m[1];
    }
    return "unknown";
  }

  private findEnclosingFunction(lines: string[], matchLine: number): string {
    // matchLine is 1-based; scan backward from the line before the match
    for (let i = matchLine - 1; i >= 0; i--) {
      const m = lines[i].match(/^func\s+(?:\([^)]+\)\s+)?(\w+)\s*\(/);
      if (m) return m[1];
    }
    return "unknown";
  }

  private captureSourceLines(
    lines: string[],
    matchLine: number,
    windowBefore: number = 2,
    windowAfter: number = 2,
  ): { source_lines: string[]; line_range: [number, number] } {
    const startLine = Math.max(1, matchLine - windowBefore);
    const endLine = Math.min(lines.length, matchLine + windowAfter);
    const source_lines = lines.slice(startLine - 1, endLine);
    return { source_lines, line_range: [startLine, endLine] };
  }
}
