/**
 * Content-hash ID generator for .sig records.
 *
 * Produces a deterministic 12-char hex string from (file, line, template).
 * Same inputs always produce the same ID, enabling cross-version diffing.
 */

import crypto from "node:crypto";

/**
 * Compute a deterministic ID for a .sig record.
 *
 * @param file - Source file path relative to repo root
 * @param line - Line number of the log call
 * @param template - The log template / format string
 * @returns 12-character lowercase hex string (first 48 bits of SHA-256)
 */
export function computeSigId(file: string, line: number, template: string): string {
  const input = `${file}\0${line}\0${template}`;
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);
}
