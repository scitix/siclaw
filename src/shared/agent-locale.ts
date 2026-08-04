/**
 * The agent's configured answer language and clock.
 *
 * Both are per-agent settings that reach the AgentBox with every prompt, and
 * both are applied by prepending a line to the prompt text — the only place a
 * value can be fresh on a box whose sessions live for days.
 *
 * Pure and dependency-free so the Portal can validate a timezone with exactly
 * the call that will later render it.
 */

/**
 * Whether the runtime can actually use this zone.
 *
 * Checked at WRITE time. An unusable value stored on an agent would otherwise
 * be discovered on every turn, in the one code path that must never throw.
 */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone.trim()) return false;
  try {
    new Intl.DateTimeFormat("sv-SE", { timeZone: timezone });
    return true;
  } catch {
    // RangeError for an unknown zone. Anything else is equally unusable.
    return false;
  }
}

/**
 * The `<system-reminder>` that tells the model what time it is.
 *
 * Named zone AND offset, deliberately: an SRE agent may also see a UTC
 * timestamp from a log or from `date` in its own shell, and the only way it can
 * reconcile the two is if this line says which clock it is quoting.
 *
 * The weekday is there because the questions this exists for are about
 * schedules — "who is on call", "was that before the change window" — and a
 * date alone leaves the model to compute it.
 *
 * Never throws. It runs on every turn, so a bad zone degrades to UTC rather
 * than taking the turn with it; `isValidTimezone` is what stops a bad zone
 * being stored in the first place, and this is the backstop for the value that
 * got in another way (a control plane that does not validate, a hand-edited
 * row).
 */
export function renderTimeReminder(now: Date, timezone?: string | null): string {
  const zone = timezone?.trim() && isValidTimezone(timezone) ? timezone.trim() : "UTC";
  let stamp: string;
  let offset: string;
  try {
    // Two formatters, because one cannot give both halves in the right
    // language: sv-SE is chosen for its ISO-ish `YYYY-MM-DD HH:mm` (same reason
    // the Lark card renderer picked it, and unambiguous next to a log
    // timestamp) — but its weekday name comes out in Swedish. The weekday has
    // to be English for a line the model reads as English.
    const datePart = new Intl.DateTimeFormat("sv-SE", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).format(now);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long" }).format(now);
    stamp = `${datePart} ${weekday}`;
    offset = extractOffset(now, zone);
  } catch {
    return `<system-reminder>Current date and time: ${now.toISOString().slice(0, 16).replace("T", " ")} (UTC).</system-reminder>`;
  }
  return `<system-reminder>Current date and time: ${stamp} (${zone}, ${offset}).</system-reminder>`;
}

function extractOffset(now: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "shortOffset",
  }).formatToParts(now);
  // "GMT+8" / "GMT-5" / "GMT" — say UTC, which is what the rest of the system
  // and every log line calls it.
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name.replace("GMT", "UTC") === "UTC" ? "UTC+0" : name.replace("GMT", "UTC");
}

/**
 * Which language the reply should be in.
 *
 * Detection wins where there is any: what the user actually wrote beats what an
 * operator configured months ago, so a bilingual user who switches is followed
 * rather than corrected. The configured value is the FLOOR — it decides the
 * turns detection cannot read, which is where the bug was: a bare `1` steered
 * into a Chinese conversation used to answer in English.
 */
export function resolveReplyLanguage(
  detected: string | null,
  configured?: string | null,
): string {
  return detected ?? (configured?.trim() || "English");
}
