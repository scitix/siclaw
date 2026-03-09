/**
 * Setup helpers for TUI mode.
 *
 * The interactive setup wizard has moved to `cli-first-run.ts` (pre-session,
 * @clack/prompts) and `core/extensions/setup.ts` (in-session /setup command).
 * This file only exports `needsSetup()` for the startup check.
 */

import fs from "node:fs";
import { getConfigPath } from "./core/config.js";

/**
 * Returns true if the user has no usable LLM configuration in settings.json.
 */
export function needsSetup(): boolean {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return true;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const providers = raw.providers;
    if (!providers || typeof providers !== "object" || Object.keys(providers).length === 0) {
      return true;
    }
    // Check that at least one provider has an apiKey
    for (const p of Object.values(providers) as any[]) {
      if (p.apiKey) return false;
    }
    return true;
  } catch {
    return true;
  }
}
