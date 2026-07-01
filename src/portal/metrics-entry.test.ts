import { describe, it, expect } from "vitest";
import {
  ENTRY_MODES,
  normalizeEntry,
  actorUserColumn,
  channelColExpr,
  entrySessionPredicate,
  entryMessagePredicate,
  type EntryMode,
} from "./metrics-entry.js";

describe("actorUserColumn", () => {
  it("attributes channel rows to the sender (sender_external_id), else user_id", () => {
    const expr = actorUserColumn("s");
    expect(expr).toBe(
      "CASE WHEN s.origin = 'channel' THEN s.sender_external_id ELSE s.user_id END",
    );
  });
  it("supports an unaliased chat_sessions table", () => {
    expect(actorUserColumn("")).toBe(
      "CASE WHEN origin = 'channel' THEN sender_external_id ELSE user_id END",
    );
  });
});

describe("channelColExpr", () => {
  it("session-level (no parent) → bare aliased column", () => {
    expect(channelColExpr("channel_id", "s")).toBe("s.channel_id");
    expect(channelColExpr("sender_external_id", "")).toBe("sender_external_id");
  });
  it("message-level (parent alias) → COALESCE child→parent so delegation children inherit", () => {
    expect(channelColExpr("channel_id", "s", "parent_s")).toBe(
      "COALESCE(s.channel_id, parent_s.channel_id)",
    );
    expect(channelColExpr("sender_external_id", "s", "parent_s")).toBe(
      "COALESCE(s.sender_external_id, parent_s.sender_external_id)",
    );
  });
});

describe("normalizeEntry", () => {
  it("passes through the known entry modes", () => {
    for (const m of ENTRY_MODES) expect(normalizeEntry(m)).toBe(m);
  });
  it("maps the legacy 'interactive' source to the overview ('all')", () => {
    expect(normalizeEntry("interactive")).toBe("all");
  });
  it("accepts the raw 'task' origin as a 'scheduled' alias", () => {
    expect(normalizeEntry("task")).toBe("scheduled");
  });
  it("defaults empty / unknown to 'all'", () => {
    expect(normalizeEntry(undefined)).toBe("all");
    expect(normalizeEntry(null)).toBe("all");
    expect(normalizeEntry("")).toBe("all");
    expect(normalizeEntry("bogus")).toBe("all");
  });
});

describe("entrySessionPredicate", () => {
  const cases: Array<[EntryMode, string]> = [
    ["web", "s.origin IS NULL"],
    ["api", "s.origin = 'api'"],
    ["a2a", "s.origin = 'a2a'"],
    ["channel", "s.origin = 'channel'"],
    ["scheduled", "s.origin = 'task'"],
  ];
  it.each(cases)("%s → exact origin match", (entry, frag) => {
    expect(entrySessionPredicate(entry)).toContain(frag);
  });

  it("'all' (overview) = interactive family: excludes task + delegation", () => {
    const p = entrySessionPredicate("all");
    expect(p).toContain("s.origin IS NULL");
    expect(p).toContain("NOT IN ('task', 'delegation')");
  });

  it("honors a custom alias", () => {
    expect(entrySessionPredicate("api", "x")).toContain("x.origin = 'api'");
  });

  it("never matches delegation under a specific entry (traces excluded)", () => {
    // A specific entry like "api" is an exact origin match, so origin='delegation'
    // rows can't satisfy it — they're excluded from session-level queries.
    expect(entrySessionPredicate("api")).not.toContain("delegation");
  });
});

describe("entryMessagePredicate (delegation inheritance)", () => {
  it("emits a parent join and inherits the parent's entry for delegation rows", () => {
    const { join, predicate } = entryMessagePredicate("api");
    expect(join).toBe("LEFT JOIN chat_sessions parent_s ON s.parent_session_id = parent_s.id");
    // direct match on s OR (delegation child whose parent matches the entry)
    expect(predicate).toContain("s.origin = 'api'");
    expect(predicate).toContain("s.origin = 'delegation' AND parent_s.origin = 'api'");
  });

  it("overview inherits parent for delegation children too", () => {
    const { predicate } = entryMessagePredicate("all");
    expect(predicate).toContain("s.origin = 'delegation'");
    expect(predicate).toContain("parent_s.origin");
  });

  it("inheritance can be disabled (no join, session-level predicate only)", () => {
    const { join, predicate } = entryMessagePredicate("web", { delegationInheritance: false });
    expect(join).toBe("");
    expect(predicate).toBe(entrySessionPredicate("web"));
  });

  it("honors custom aliases", () => {
    const { join, predicate } = entryMessagePredicate("scheduled", { sAlias: "m_s", parentAlias: "p" });
    expect(join).toContain("LEFT JOIN chat_sessions p ON m_s.parent_session_id = p.id");
    expect(predicate).toContain("m_s.origin = 'task'");
    expect(predicate).toContain("m_s.origin = 'delegation' AND p.origin = 'task'");
  });
});
