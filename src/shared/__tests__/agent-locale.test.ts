import { describe, it, expect } from "vitest";
import {
  createSessionLocaleState,
  isValidTimezone,
  normalizeSessionLocaleState,
  rememberLocaleSignals,
  renderTimeReminder,
  resolveLocale,
} from "../agent-locale.js";

describe("isValidTimezone", () => {
  it.each(["Asia/Shanghai", "UTC", "America/Los_Angeles", "Europe/London"])("accepts %s", (tz) => {
    expect(isValidTimezone(tz)).toBe(true);
  });

  it.each(["", "   ", "Not/AZone", "Asia/Shangai", "UTC+8", "GMT+0800"])("rejects %j", (tz) => {
    expect(isValidTimezone(tz)).toBe(false);
  });
});

describe("renderTimeReminder", () => {
  // The case the whole feature exists for: at this instant UTC and Shanghai are
  // on DIFFERENT DAYS. An agent answering "今天几号" from the box's own UTC
  // clock would be a day behind for every user in the evening.
  it("crosses the date line into the configured zone", () => {
    const at1700Utc = new Date("2026-08-02T17:00:00Z");
    expect(renderTimeReminder(at1700Utc, "UTC")).toContain("2026-08-02");
    expect(renderTimeReminder(at1700Utc, "Asia/Shanghai")).toContain("2026-08-03");
  });

  it("names the zone and its offset", () => {
    const r = renderTimeReminder(new Date("2026-08-02T08:00:00Z"), "Asia/Shanghai");
    // Both, deliberately: the agent may also see a UTC timestamp from a log or
    // from `date`, and this line is how it reconciles them.
    expect(r).toContain("Asia/Shanghai");
    expect(r).toContain("UTC+8");
    expect(r).toContain("16:00");
  });

  // The questions this serves are about schedules — "who is on call", "was that
  // before the change window" — so the weekday is spelled out rather than left
  // for the model to compute. In ENGLISH: the ISO-ish date comes from a sv-SE
  // formatter, whose own weekday name would be Swedish.
  it("spells the weekday out, in English", () => {
    const r = renderTimeReminder(new Date("2026-08-02T08:00:00Z"), "UTC");
    expect(r).toContain("Sunday");
    expect(r).not.toContain("söndag");
  });

  it("falls back to UTC when no zone is configured", () => {
    for (const tz of [undefined, null, "", "   "]) {
      const r = renderTimeReminder(new Date("2026-08-02T08:00:00Z"), tz);
      expect(r).toContain("UTC");
      expect(r).toContain("2026-08-02");
    }
  });

  // This runs on every turn. A zone that got stored without validation — a
  // control plane that does not check, a hand-edited row — must cost the user a
  // wrong timezone, not the whole reply.
  it("degrades to UTC on an unusable zone instead of throwing", () => {
    const r = renderTimeReminder(new Date("2026-08-02T08:00:00Z"), "Mars/Olympus_Mons");
    expect(r).toContain("UTC");
    expect(r).toContain("2026-08-02");
  });

  it("is wrapped so the model reads it as system context", () => {
    // prompt.ts already tells the model how to treat <system-reminder>; the
    // wrapper is what opts this line into that contract.
    const r = renderTimeReminder(new Date(), "UTC");
    expect(r.startsWith("<system-reminder>")).toBe(true);
    expect(r.endsWith("</system-reminder>")).toBe(true);
  });
});

describe("normalizeSessionLocaleState", () => {
  it("keeps what this module wrote", () => {
    expect(normalizeSessionLocaleState({ language: "Chinese", timezone: "Asia/Shanghai" }))
      .toEqual({ language: "Chinese", timezone: "Asia/Shanghai" })
  })

  // Read from a file that outlives the pod, so it is untrusted input: a
  // hand-edited or corrupt value must degrade to "nothing remembered" rather
  // than reach the prompt.
  it.each([null, undefined, 42, "Chinese", [], { language: 7 }])("degrades %j to empty", (raw) => {
    expect(normalizeSessionLocaleState(raw)).toEqual({});
  });

  it("drops a stored zone the runtime cannot resolve", () => {
    expect(normalizeSessionLocaleState({ language: "Chinese", timezone: "Mars/Olympus_Mons" }))
      .toEqual({ language: "Chinese" });
  });

  it("trims and drops blanks", () => {
    expect(normalizeSessionLocaleState({ language: "  Chinese  ", timezone: "   " }))
      .toEqual({ language: "Chinese" });
  });
});

describe("rememberLocaleSignals", () => {
  it("remembers a detected language and reports the change", () => {
    const state = createSessionLocaleState();
    expect(rememberLocaleSignals(state, { detectedLanguage: "Chinese" })).toBe(true);
    expect(state).toEqual({ language: "Chinese" });
  });

  // The caller writes to disk only when this returns true, so an ordinary turn
  // in an established conversation must cost no I/O.
  it("reports no change when the turn taught it nothing new", () => {
    const state = { language: "Chinese", timezone: "Asia/Shanghai" };
    expect(rememberLocaleSignals(state, {
      detectedLanguage: "Chinese",
      reportedTimezone: "Asia/Shanghai",
    })).toBe(false);
  });

  it("moves with a user who switches language", () => {
    const state = { language: "Chinese" };
    expect(rememberLocaleSignals(state, { detectedLanguage: "English" })).toBe(true);
    expect(state.language).toBe("English");
  });

  // An unreadable turn must not erase what the conversation already showed —
  // that is the whole thing the memory exists to survive.
  it("keeps the remembered language when a turn detects nothing", () => {
    const state = { language: "Chinese" };
    expect(rememberLocaleSignals(state, { detectedLanguage: null })).toBe(false);
    expect(state.language).toBe("Chinese");
  });

  it("ignores a reported zone the runtime cannot resolve", () => {
    const state = { timezone: "Asia/Shanghai" };
    expect(rememberLocaleSignals(state, { reportedTimezone: "Mars/Olympus_Mons" })).toBe(false);
    expect(state.timezone).toBe("Asia/Shanghai");
  });
});

describe("resolveLocale", () => {
  const agent = { language: "Chinese", timezone: "Asia/Shanghai" };

  it("follows what the user wrote over everything below it", () => {
    const r = resolveLocale({ detectedLanguage: "English" }, { language: "Chinese" }, agent);
    expect(r.language).toBe("English");
  });

  // THE case this redesign exists for. One AgentBox serves every user of an
  // agent, so an agent configured Chinese used to answer an English speaker's
  // `ok` in Chinese. The conversation's own history is what prevents that.
  it("keeps an English conversation English even when the agent says Chinese", () => {
    const r = resolveLocale({ detectedLanguage: null }, { language: "English" }, agent);
    expect(r.language).toBe("English");
  });

  // The other half of the same rule: the original bug. A Chinese conversation
  // must not flip on a bare "1".
  it("keeps a Chinese conversation Chinese on an unreadable turn", () => {
    const r = resolveLocale({ detectedLanguage: null }, { language: "Chinese" }, { language: "English" });
    expect(r.language).toBe("Chinese");
  });

  it("uses the agent default only when the conversation has shown nothing", () => {
    expect(resolveLocale({ detectedLanguage: null }, {}, agent).language).toBe("Chinese");
    expect(resolveLocale({ detectedLanguage: null }, undefined, agent).language).toBe("Chinese");
  });

  it("floors at English and UTC", () => {
    const r = resolveLocale({ detectedLanguage: null }, undefined, undefined);
    expect(r).toEqual({ language: "English", timezone: "UTC" });
  });

  it("prefers the zone the client reported this turn", () => {
    const r = resolveLocale(
      { detectedLanguage: null, reportedTimezone: "America/New_York" },
      { timezone: "Asia/Shanghai" },
      agent,
    );
    expect(r.timezone).toBe("America/New_York");
  });

  it("falls through the timezone ladder in order", () => {
    expect(resolveLocale({}, { timezone: "Europe/London" }, agent).timezone).toBe("Europe/London");
    expect(resolveLocale({}, {}, agent).timezone).toBe("Asia/Shanghai");
    expect(resolveLocale({}, {}, {}).timezone).toBe("UTC");
  });

  // Every candidate is validated on the way through, not just the reported one:
  // a bad value anywhere must be treated as absent rather than passed on to a
  // formatter that would then have to cope with it.
  it("skips an unusable zone at any level of the ladder", () => {
    expect(resolveLocale({ reportedTimezone: "Not/AZone" }, { timezone: "Europe/London" }, agent).timezone)
      .toBe("Europe/London");
    expect(resolveLocale({}, { timezone: "Not/AZone" }, agent).timezone).toBe("Asia/Shanghai");
    expect(resolveLocale({}, {}, { timezone: "Not/AZone" }).timezone).toBe("UTC");
  });

  it("ignores blank values rather than treating them as a choice", () => {
    expect(resolveLocale({ detectedLanguage: "  " }, { language: "Chinese" }, agent).language).toBe("Chinese");
    expect(resolveLocale({}, { language: "   " }, { language: "Japanese" }).language).toBe("Japanese");
  });
});
