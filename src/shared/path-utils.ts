/**
 * Shared path traversal validation utility.
 *
 * Used by resource handlers, credential manager, and http-server to ensure
 * resolved paths stay within a designated base directory.
 */

import path from "node:path";

/**
 * Resolve a path under a base directory, throwing if it escapes.
 *
 * @param base - The trusted base directory (must be an absolute, resolved path)
 * @param segments - Untrusted path segments to join under base
 * @returns The resolved absolute path guaranteed to be under base
 * @throws Error if the resolved path escapes the base directory
 */
export function resolveUnderDir(base: string, ...segments: string[]): string {
  const resolved = path.resolve(base, ...segments);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path escapes base directory: ${resolved}`);
  }
  return resolved;
}
