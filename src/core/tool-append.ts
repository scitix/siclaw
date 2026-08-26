import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Append externally-created framework tools (currently file I/O) to the resolved tool list,
 * applying the same name-based `allowedTools` whitelist that `ToolRegistry.resolve()`
 * applies to registered tools.
 *
 * These tools live outside `ToolRegistry` (file I/O tools are framework
 * factories injected after resolve), so they bypass `resolve()`.
 * This helper is the single chokepoint that keeps them under the same availability
 * axis — without it they would be silently exempt from the whitelist.
 *
 * Semantics mirror `resolve()`:
 *  - `null`/`undefined` allowedTools → every tool passes (the default; whitelist off).
 *  - an array → only tools whose `name` is listed pass; no exemptions.
 *
 * The appended tools carry no `mode`/`available` metadata (universal across
 * modes, no ref dependency), so `allowedTools` is their sole availability gate.
 * Configured MCP deliberately does not pass through this helper: it is a
 * separate resource-binding axis resolved before dynamic discovery.
 */
export function appendAllowedTools(
  target: ToolDefinition[],
  tools: ToolDefinition[],
  allowedTools: string[] | null | undefined,
): void {
  if (Array.isArray(allowedTools)) {
    const allowed = new Set(allowedTools);
    target.push(...tools.filter((t) => allowed.has(t.name)));
  } else {
    target.push(...tools);
  }
}
