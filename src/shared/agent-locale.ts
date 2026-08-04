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
 * What a conversation has revealed about its own language and clock.
 *
 * Scoped to the SESSION, not to the agent and not to a user id. An AgentBox is
 * keyed by agent alone, so one box serves everyone using that agent — an
 * agent-level default therefore answers one user in another user's language. A
 * user-level store cannot be the answer either: channel messages arrive with no
 * `userId` at all (only the binding's owner), which is exactly the surface with
 * the most people per agent.
 *
 * A session is the scope that works everywhere and needs no identity: Portal
 * sessions are per-person, a Feishu `per_user` group keys the session by sender,
 * and a Feishu `shared` group deliberately gives the whole room one session —
 * where one language for the room is the intended behaviour, not a bug.
 */
export interface SessionLocaleState {
  /** The last language DETECTED from something the user wrote here. */
  language?: string;
  /** The last timezone the client REPORTED here. */
  timezone?: string;
}

export function createSessionLocaleState(): SessionLocaleState {
  return {};
}

/**
 * Accept only what this module wrote.
 *
 * The state is read from a file that survives restarts, so treat it as
 * untrusted: a corrupt or hand-edited value must degrade to "nothing
 * remembered" rather than reach the prompt.
 */
export function normalizeSessionLocaleState(value: unknown): SessionLocaleState {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const state: SessionLocaleState = {};
  const language = typeof raw.language === "string" ? raw.language.trim() : "";
  if (language) state.language = language;
  const timezone = typeof raw.timezone === "string" ? raw.timezone.trim() : "";
  if (timezone && isValidTimezone(timezone)) state.timezone = timezone;
  return state;
}

/** This turn's live signals — what the user wrote, and what their client said. */
export interface LocaleSignals {
  /** From `detectScriptLanguage`; null when the text carries no evidence. */
  detectedLanguage?: string | null;
  /** The client's own zone (a browser reports its own), if it sent one. */
  reportedTimezone?: string | null;
}

/**
 * Fold this turn's live signals into what the session remembers.
 *
 * Returns whether anything changed, so the caller can skip a write on the
 * ordinary turn where nothing new was learned.
 *
 * Only LIVE signals are remembered. The agent's configured values are
 * deliberately never written here: recording a default as though the
 * conversation had revealed it would freeze it in place and defeat the whole
 * point — that configuration applies only until there is evidence.
 */
export function rememberLocaleSignals(
  state: SessionLocaleState,
  signals: LocaleSignals,
): boolean {
  let changed = false;
  const detected = signals.detectedLanguage?.trim();
  if (detected && state.language !== detected) {
    state.language = detected;
    changed = true;
  }
  const reported = signals.reportedTimezone?.trim();
  if (reported && isValidTimezone(reported) && state.timezone !== reported) {
    state.timezone = reported;
    changed = true;
  }
  return changed;
}

/** The agent-level defaults, which apply only where nothing better is known. */
export interface AgentLocaleDefaults {
  language?: string | null;
  timezone?: string | null;
}

/**
 * The one rule deciding what language a turn is answered in and which clock it
 * is told about.
 *
 * Both resolve the same way — strongest live signal, then what this
 * conversation already showed, then the agent's default, then a floor:
 *
 *   language: detected this turn ?? remembered ?? agent default ?? English
 *   timezone: reported this turn ?? remembered ?? agent default ?? UTC
 *
 * Language has per-turn detection and timezone has a per-turn report; otherwise
 * they are the same ladder, so they live in one function. Resolving one and
 * forgetting the other is then not something a caller can do.
 *
 * The agent default sits BELOW the conversation on purpose. It is the language a
 * conversation opens in, before anyone has written anything readable — a real
 * need (a Chinese team's agent should not open in English) with no multi-user
 * hazard, because the first readable message replaces it and it never overrides
 * a conversation already in progress.
 *
 * Every timezone candidate is validated on the way through, including the
 * remembered and configured ones: a zone that cannot be resolved is treated as
 * absent rather than passed on.
 */
export function resolveLocale(
  signals: LocaleSignals,
  remembered: SessionLocaleState | undefined,
  defaults: AgentLocaleDefaults | undefined,
): { language: string; timezone: string } {
  const language = signals.detectedLanguage?.trim()
    || remembered?.language?.trim()
    || defaults?.language?.trim()
    || "English";

  const timezone = firstUsableZone(
    signals.reportedTimezone,
    remembered?.timezone,
    defaults?.timezone,
  ) ?? "UTC";

  return { language, timezone };
}

function firstUsableZone(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const zone = candidate?.trim();
    if (zone && isValidTimezone(zone)) return zone;
  }
  return null;
}
