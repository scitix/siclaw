/**
 * Setup helpers for TUI mode.
 *
 * The interactive setup wizard has moved to `cli-first-run.ts` (pre-session,
 * @clack/prompts) and `core/extensions/setup.ts` (in-session /setup command).
 * This file only exports `needsSetup()` for the startup check.
 */

import { loadConfig } from "./core/config.js";

/**
 * Returns true if there is no usable LLM configuration for this session.
 *
 * Goes through `loadConfig()` rather than reading settings.json directly so a
 * Portal snapshot injected via `setPortalSnapshot()` counts as "configured"
 * even when no local settings.json file exists.
 */
export function needsSetup(): boolean {
  const cfg = loadConfig();
  const providers = Object.values(cfg.providers);
  if (providers.length === 0) return true;
  // At least one provider must carry an apiKey to be usable.
  return !providers.some((p) => p?.apiKey);
}
