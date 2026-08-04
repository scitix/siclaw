/**
 * Timezone list and labels for the agent's Timezone picker.
 *
 * Separate from the component because this is the part with rules in it —
 * which zones exist, how a search term matches one, how a row is labelled —
 * and portal-web has no DOM test environment, so logic left inside a component
 * can only be checked through rendered HTML.
 */

/**
 * Every IANA zone this browser knows.
 *
 * Taken from the browser rather than a curated list: it is the same tzdata the
 * agent's runtime resolves against, it tracks zone renames without anyone
 * maintaining it, and a short list always misses the one zone someone needs.
 *
 * UTC is prepended because the browser list does NOT contain it: the spec
 * returns canonical zones only, so `UTC` and every `Etc/*` link are dropped
 * (418 entries here, none of them UTC). Without this the one zone the runtime
 * falls back to, names in its own reminder, and accepts from the API would be
 * the one zone an operator could not pick — and "unset" could not be told
 * apart from "UTC, deliberately".
 *
 * Empty on a pre-2022 engine, which the picker treats as "no list to offer".
 */
export function allTimezones(): string[] {
  try {
    return ["UTC", ...Intl.supportedValuesOf("timeZone")]
  } catch {
    return []
  }
}

/** This browser's own zone, offered as a one-click starting point. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ""
  } catch {
    return ""
  }
}

/**
 * "UTC+8" — deliberately the same wording the agent gets in its own reminder,
 * so what the operator picked and what the model was told read alike.
 */
export function timezoneOffsetLabel(zone: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    }).formatToParts(at)
    const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT"
    const utc = name.replace("GMT", "UTC")
    return utc === "UTC" ? "UTC+0" : utc
  } catch {
    return ""
  }
}

/** Local wall-clock time in that zone, so a row is recognizable at a glance. */
export function timezoneClockLabel(zone: string, at: Date): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(at)
  } catch {
    return ""
  }
}

/**
 * Filter the zone list by what the operator typed.
 *
 * `/` and `_` are treated as spaces so people can type a city the way they say
 * it — "los angeles" finds `America/Los_Angeles`, which is the whole point of a
 * search box over a 400-entry list.
 *
 * Capped because the list is long and every rendered row runs two
 * `Intl.DateTimeFormat` calls; an empty query would otherwise format ~400 rows
 * on each keystroke that clears the box.
 */
export function filterTimezones(zones: string[], query: string, limit = 300): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return zones.slice(0, limit)
  const normalized = (zone: string) => zone.toLowerCase().replace(/[/_]/g, " ")
  return zones.filter((z) => normalized(z).includes(q)).slice(0, limit)
}
