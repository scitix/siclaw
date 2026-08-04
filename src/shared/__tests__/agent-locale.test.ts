import { describe, it, expect } from "vitest";
import { isValidTimezone, renderTimeReminder, resolveReplyLanguage } from "../agent-locale.js";

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

describe("resolveReplyLanguage", () => {
  it("follows what the user wrote over what was configured", () => {
    // A bilingual user who switches is followed, not corrected.
    expect(resolveReplyLanguage("English", "Chinese")).toBe("English");
    expect(resolveReplyLanguage("Chinese", "English")).toBe("Chinese");
  });

  it("uses the configured language when the text says nothing", () => {
    // The reported bug: steering a bare `1` into a Chinese conversation.
    expect(resolveReplyLanguage(null, "Chinese")).toBe("Chinese");
  });

  it.each([undefined, null, "", "  "])("falls back to English when configured is %j", (cfg) => {
    expect(resolveReplyLanguage(null, cfg)).toBe("English");
  });
});
