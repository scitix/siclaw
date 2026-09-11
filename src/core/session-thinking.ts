import type { SettingsManager } from "@earendil-works/pi-coding-agent";

/** Preserve Siclaw's default across Pi's deferred model binding without writing user settings. */
export function resolveSessionThinkingLevel(
  settings: SettingsManager,
  model?: { provider: string; id: string },
): NonNullable<ReturnType<SettingsManager["getDefaultThinkingLevel"]>> {
  const defaultLevel = settings.getDefaultThinkingLevel() ?? "high";
  if (settings.getDefaultThinkingLevel() === undefined) {
    // The initial model may be absent or non-reasoning, so Pi clamps the session
    // level to off. Its later setModel reads this default to recover the intended
    // effort. A create-session option alone does not survive that transition.
    settings.applyOverrides({ defaultThinkingLevel: defaultLevel });
  }
  return (model ? settings.getModelThinkingLevel(model.provider, model.id) : undefined) ?? defaultLevel;
}
