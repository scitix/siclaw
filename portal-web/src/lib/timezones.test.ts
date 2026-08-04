import { describe, it, expect } from "vitest"
import {
  allTimezones,
  browserTimezone,
  filterTimezones,
  timezoneClockLabel,
  timezoneOffsetLabel,
} from "./timezones"

describe("allTimezones", () => {
  it("returns the browser's IANA list", () => {
    const zones = allTimezones()
    expect(zones.length).toBeGreaterThan(100)
    expect(zones).toContain("Asia/Shanghai")
  })

  // The browser list is canonical zones only — it contains neither "UTC" nor
  // any "Etc/*" link. Left alone, the one zone the runtime falls back to and
  // names in its own reminder would be the one zone nobody could select, and
  // "unset" could not be told apart from "UTC, deliberately".
  it("offers UTC, which the browser list omits", () => {
    expect(Intl.supportedValuesOf("timeZone")).not.toContain("UTC")
    expect(allTimezones()).toContain("UTC")
    expect(allTimezones()[0]).toBe("UTC")
  })

  it("offers only zones the runtime can resolve", () => {
    // Same call the backend validates with; a row that cannot be formatted
    // would be a pickable value the API then rejects with a 400.
    for (const zone of [allTimezones()[0], "Asia/Shanghai", "America/New_York"]) {
      expect(() => new Intl.DateTimeFormat("sv-SE", { timeZone: zone })).not.toThrow()
    }
  })
})

describe("browserTimezone", () => {
  it("names a zone the picker can actually offer", () => {
    // The suggestion row hands this straight to onChange, so it has to be a
    // value the backend will accept — not a display string.
    const here = browserTimezone()
    expect(here).not.toBe("")
    expect(allTimezones()).toContain(here)
  })
})

describe("filterTimezones", () => {
  const zones = ["America/Los_Angeles", "Asia/Shanghai", "Europe/London", "UTC"]

  // The reason a search box exists over a 400-entry list: people type the city
  // the way they say it, not the way IANA punctuates it.
  it("matches a city typed with spaces instead of / and _", () => {
    expect(filterTimezones(zones, "los angeles")).toEqual(["America/Los_Angeles"])
    expect(filterTimezones(zones, "america los")).toEqual(["America/Los_Angeles"])
  })

  it("is case-insensitive and matches a bare substring", () => {
    expect(filterTimezones(zones, "SHANG")).toEqual(["Asia/Shanghai"])
    expect(filterTimezones(zones, "europe")).toEqual(["Europe/London"])
  })

  it("returns everything for an empty or whitespace query", () => {
    expect(filterTimezones(zones, "")).toEqual(zones)
    expect(filterTimezones(zones, "   ")).toEqual(zones)
  })

  it("returns nothing for a term that matches no zone", () => {
    expect(filterTimezones(zones, "mars")).toEqual([])
  })

  // Each rendered row runs two Intl.DateTimeFormat calls, so an unfiltered list
  // is the expensive case — the cap is what keeps clearing the box cheap.
  it("caps the result", () => {
    expect(filterTimezones(allTimezones(), "", 10)).toHaveLength(10)
    expect(filterTimezones(allTimezones(), "a", 5)).toHaveLength(5)
  })
})

describe("timezoneOffsetLabel", () => {
  it("says UTC, not GMT — the word the rest of the system uses", () => {
    const at = new Date("2026-08-02T08:00:00Z")
    expect(timezoneOffsetLabel("Asia/Shanghai", at)).toBe("UTC+8")
    expect(timezoneOffsetLabel("UTC", at)).toBe("UTC+0")
  })

  it("tracks daylight saving rather than quoting a fixed offset", () => {
    // Same zone, two dates: a row labelled with the standard offset all year
    // would be wrong for half of it.
    expect(timezoneOffsetLabel("America/New_York", new Date("2026-01-15T12:00:00Z"))).toBe("UTC-5")
    expect(timezoneOffsetLabel("America/New_York", new Date("2026-07-15T12:00:00Z"))).toBe("UTC-4")
  })

  it("degrades to an empty label on an unusable zone instead of throwing", () => {
    // This runs once per rendered row; one bad value must not blank the picker.
    expect(timezoneOffsetLabel("Mars/Olympus_Mons", new Date())).toBe("")
  })
})

describe("timezoneClockLabel", () => {
  it("shows 24-hour local time in the zone", () => {
    const at = new Date("2026-08-02T08:00:00Z")
    expect(timezoneClockLabel("Asia/Shanghai", at)).toBe("16:00")
    expect(timezoneClockLabel("UTC", at)).toBe("08:00")
  })

  it("degrades to an empty label on an unusable zone", () => {
    expect(timezoneClockLabel("Mars/Olympus_Mons", new Date())).toBe("")
  })
})
