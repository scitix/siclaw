import { describe, it, expect } from "vitest";
import {
  ENTRY_MODES,
  normalizeEntry,
  actorUserColumn,
  channelColExpr,
  entrySessionPredicate,
  entryPromptPredicate,
  entryMessagePredicate,
  type EntryMode,
} from "./metrics-entry.js";
import { TRACE_ORIGINS, parentAttributedOriginPredicate } from "./session-origin.js";

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

  it("'all' (overview) = interactive family: excludes every trace origin", () => {
    const p = entrySessionPredicate("all");
    expect(p).toContain("s.origin IS NULL");
    // Asserted against the registry, not a pinned string: a new trace origin
    // must be excluded here automatically, which is exactly what 'subagent'
    // was not for a month.
    for (const origin of TRACE_ORIGINS) expect(p).toContain(`'${origin}'`);
    expect(p).toContain("NOT IN");
  });

  it("excludes sub-agent children from the overview (regression)", () => {
    // origin='subagent' shipped before this axis existed and was omitted from
    // every hardcoded exclusion list: sub-agent children counted as top-level
    // sessions in the overview.
    expect(entrySessionPredicate("all")).toContain("'subagent'");
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

describe("entryPromptPredicate (no parent attribution)", () => {
  it("excludes trace sessions without inheriting the parent's entry", () => {
    // A role='user' count answers "how many requests did people make". A trace
    // child's opening user row is the task text its PARENT wrote — a sub-agent
    // briefing or a delegated instruction — so attributing it to the parent's
    // entry counts one human request twice.
    const p = entryPromptPredicate("api", "s");
    expect(p).toContain("s.origin = 'api'");
    expect(p).not.toContain("parent_s");
    expect(p).not.toContain("'subagent'");
  });

  it("overview excludes every trace origin and never attributes to a parent", () => {
    const p = entryPromptPredicate("all", "s");
    for (const origin of TRACE_ORIGINS) expect(p).toContain(`'${origin}'`);
    expect(p).toContain("NOT IN");
    expect(p).not.toContain("parent_s");
  });

  it("differs from entryMessagePredicate — the two are not interchangeable", () => {
    // Pins the distinction the bug erased: tool telemetry inherits the parent,
    // prompt counts do not.
    const prompt = entryPromptPredicate("api", "s");
    const { predicate: message } = entryMessagePredicate("api");
    expect(prompt).not.toBe(message);
    expect(message).toContain("parent_s");
  });
});

describe("entryMessagePredicate (parent attribution)", () => {
  it("emits a parent join and inherits the parent's entry for attributed rows", () => {
    const { join, predicate } = entryMessagePredicate("api");
    expect(join).toBe("LEFT JOIN chat_sessions parent_s ON s.parent_session_id = parent_s.id");
    // direct match on s OR (attributed child with a PRESENT parent matching the entry)
    expect(predicate).toContain("s.origin = 'api'");
    expect(predicate).toContain(
      `${parentAttributedOriginPredicate("s")} AND parent_s.id IS NOT NULL AND parent_s.origin = 'api'`,
    );
  });

  it("requires a present parent, so orphan traces fall out of every bucket", () => {
    // An unmatched LEFT JOIN NULLs every parent column, and a NULL origin
    // SATISFIES the two buckets that test for it: `web` is `origin IS NULL`,
    // and `all` opens with the same disjunct. Without the guard, a delegation
    // persisted with a NULL parent (never an unverified ref) or a child whose
    // parent was deleted/pruned would count as Web/Overview traffic.
    for (const entry of ["web", "all"] as const) {
      expect(entryMessagePredicate(entry).predicate).toContain("parent_s.id IS NOT NULL");
    }
  });

  it("guards the parent branch under a custom parent alias too", () => {
    const { predicate } = entryMessagePredicate("web", { sAlias: "m_s", parentAlias: "p" });
    expect(predicate).toContain("p.id IS NOT NULL");
  });

  it("attributes BOTH delegation and sub-agent children to the parent", () => {
    // The two are different mechanisms — a delegated peer runs under its own
    // config, a sub-agent is the parent's own context isolation — but both do
    // work on behalf of a parent turn, so both inherit its entry.
    const { predicate } = entryMessagePredicate("api");
    expect(predicate).toContain("'delegation'");
    expect(predicate).toContain("'subagent'");
  });

  it("overview inherits parent for attributed children too", () => {
    const { predicate } = entryMessagePredicate("all");
    expect(predicate).toContain(parentAttributedOriginPredicate("s"));
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
    expect(predicate).toContain(
      `${parentAttributedOriginPredicate("m_s")} AND p.id IS NOT NULL AND p.origin = 'task'`,
    );
  });
});
