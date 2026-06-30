/**
 * The agentbox prepends a `[System: respond in <Language>]` directive to the user's
 * prompt text (see agentbox/http-server.ts) so the model follows the user's input
 * language. That directive is an internal model-control token: it must reach the
 * model, but it must NEVER be shown or persisted as the user's message.
 *
 * The runtime's own gateway persists the original (pre-injection) text, so siclaw's
 * Web UI is clean. But other portals on the runtime↔portal protocol (e.g. sicore)
 * receive the user turn via the agentbox→portal append channel, where the brain's
 * recorded turn carries the injected directive — leaking it into their chat UI.
 * This strips it at the persistence boundary so every consumer sees the clean text.
 *
 * The directive is injected either at the very start of the text, or immediately
 * after a single leading Deep-Investigation marker line (e.g. `[Deep Investigation]\n`).
 * We only strip it in those positions so a user who literally types the phrase mid
 * message isn't mangled.
 */
const LEADING_DIRECTIVE_RE = /^(\[[^\]\n]*\]\n)?\[System: respond in [^\]\n]+\]\n/;

export function stripLanguageDirective(text: string): string {
  if (!text) return text;
  const m = text.match(LEADING_DIRECTIVE_RE);
  if (!m) return text;
  const keep = m[1] ?? ""; // preserve a leading DP marker line if present
  return keep + text.slice(m[0].length);
}
