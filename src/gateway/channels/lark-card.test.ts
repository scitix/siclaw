import { describe, it, expect, vi } from "vitest";
import {
  sanitizeMarkdownForFeishu,
  openTypingCard,
  updateCardContent,
  finalizeCard,
  buildMilestoneCardMarkdown,
  DEFAULT_PLACEHOLDER,
  EMPTY_RESULT_NOTICE,
  PLACEHOLDER_BY_LOCALE,
  EMPTY_RESULT_NOTICE_BY_LOCALE,
  localeForDomain,
} from "./lark-card.js";

// ── sanitizeMarkdownForFeishu ──────────────────────────────────

describe("sanitizeMarkdownForFeishu", () => {
  it("passes supported markdown through unchanged (bold, italic, code, links, lists)", () => {
    const md = [
      "**bold** and *italic* and `inline code`",
      "",
      "- item 1",
      "- item 2",
      "",
      "```python",
      "print('hi')",
      "```",
      "",
      "[link](https://example.com)",
    ].join("\n");
    expect(sanitizeMarkdownForFeishu(md)).toBe(md);
  });

  it("passes ATX headings through unchanged (schema-2.0 markdown renders them natively)", () => {
    expect(sanitizeMarkdownForFeishu("# Title")).toBe("# Title");
    expect(sanitizeMarkdownForFeishu("## Subtitle\nbody")).toBe("## Subtitle\nbody");
    expect(sanitizeMarkdownForFeishu("### Sec\n### Sec2")).toBe("### Sec\n### Sec2");
    // A heading with a leading emoji must NOT become `**…**` (that produced
    // literal asterisks when the bold marker glued onto the emoji).
    expect(sanitizeMarkdownForFeishu("### 🔴 Issue 1: disk full")).toBe("### 🔴 Issue 1: disk full");
  });

  it("passes GFM tables through unchanged (schema-2.0 markdown renders them natively)", () => {
    const input = [
      "| col1 | col2 |",
      "|------|------|",
      "| a    | b    |",
      "| c    | d    |",
    ].join("\n") + "\n";
    const out = sanitizeMarkdownForFeishu(input);
    // No longer wrapped in a fenced code block — passed through verbatim so the
    // 2.0 markdown element renders a real table (not a monospace code box).
    expect(out).toBe(input);
    expect(out.startsWith("```")).toBe(false);
  });

  it("prefixes blockquotes with a full-width pipe", () => {
    expect(sanitizeMarkdownForFeishu("> quoted")).toBe("｜ quoted");
    expect(sanitizeMarkdownForFeishu("> line 1\n> line 2")).toBe("｜ line 1\n｜ line 2");
  });

  it("does NOT rewrite headings / tables / blockquotes inside a fenced code block", () => {
    const md = [
      "real heading:",
      "# outside",
      "",
      "```",
      "# inside code block — MUST be left alone",
      "| col | col |",
      "|-----|-----|",
      "> not a real quote",
      "```",
    ].join("\n");
    const out = sanitizeMarkdownForFeishu(md);
    // Outside heading passes through unchanged (rendered natively by 2.0).
    expect(out).toContain("# outside");
    expect(out).not.toContain("**outside**");
    // Inside the fenced code block, everything is preserved verbatim — the
    // carve-out/restore must still protect code contents.
    expect(out).toContain("# inside code block — MUST be left alone");
    expect(out).toContain("| col | col |");
    expect(out).toContain("> not a real quote");
  });

  it("returns empty string unchanged", () => {
    expect(sanitizeMarkdownForFeishu("")).toBe("");
  });
});

// ── Locale selection ───────────────────────────────────────────

describe("localeForDomain", () => {
  it("maps the global 'lark' domain to en-US", () => {
    expect(localeForDomain("lark")).toBe("en-US");
  });

  it("maps 'feishu' (and any other/unset value) to zh-CN", () => {
    expect(localeForDomain("feishu")).toBe("zh-CN");
    expect(localeForDomain(undefined)).toBe("zh-CN");
    expect(localeForDomain("")).toBe("zh-CN");
  });
});

describe("PLACEHOLDER_BY_LOCALE / EMPTY_RESULT_NOTICE_BY_LOCALE", () => {
  it("returns Chinese strings for zh-CN (the default locale)", () => {
    expect(PLACEHOLDER_BY_LOCALE["zh-CN"]).toContain("正在思考");
    expect(EMPTY_RESULT_NOTICE_BY_LOCALE["zh-CN"]).toContain("未返回");
    expect(DEFAULT_PLACEHOLDER).toBe(PLACEHOLDER_BY_LOCALE["zh-CN"]);
    expect(EMPTY_RESULT_NOTICE).toBe(EMPTY_RESULT_NOTICE_BY_LOCALE["zh-CN"]);
  });

  it("returns English strings for en-US (global Lark domain)", () => {
    expect(PLACEHOLDER_BY_LOCALE["en-US"]).toContain("Thinking");
    expect(EMPTY_RESULT_NOTICE_BY_LOCALE["en-US"]).toMatch(/agent|response/i);
  });
});

// ── openTypingCard ──────────────────────────────────────────────

function makeLarkClient(overrides: Partial<{
  createRes: unknown;
  createThrows: Error;
  replyThrows: Error;
  contentThrows: Error;
  settingsThrows: Error;
}> = {}) {
  const createSpy = vi.fn(async () =>
    overrides.createThrows ? Promise.reject(overrides.createThrows) : overrides.createRes ?? { data: { card_id: "CARD-1" } },
  );
  const replySpy = vi.fn(async () =>
    overrides.replyThrows ? Promise.reject(overrides.replyThrows) : ({ code: 0 }),
  );
  const contentSpy = vi.fn(async () =>
    overrides.contentThrows ? Promise.reject(overrides.contentThrows) : ({ code: 0 }),
  );
  const settingsSpy = vi.fn(async () =>
    overrides.settingsThrows ? Promise.reject(overrides.settingsThrows) : ({ code: 0 }),
  );
  return {
    client: {
      cardkit: {
        v1: {
          card: { create: createSpy, settings: settingsSpy },
          cardElement: { content: contentSpy },
        },
      },
      im: {
        message: { reply: replySpy },
      },
    },
    createSpy,
    replySpy,
    contentSpy,
    settingsSpy,
  };
}

describe("openTypingCard", () => {
  it("creates a streaming card with default placeholder, then replies with its card_id", async () => {
    const { client, createSpy, replySpy } = makeLarkClient();
    vi.spyOn(console, "error").mockImplementation(() => {});

    const session = await openTypingCard(client as any, "msg-7");
    expect(session).not.toBeNull();
    expect(session!.cardId).toBe("CARD-1");
    expect(session!.elementId).toBe("md_main");
    expect(session!.sequence).toBe(0);

    // create received a JSON string with streaming_mode=true and placeholder text.
    const createArg = createSpy.mock.calls[0][0];
    expect(createArg.data.type).toBe("card_json");
    const cardJson = JSON.parse(createArg.data.data);
    expect(cardJson.config.streaming_mode).toBe(true);
    expect(cardJson.body.elements[0].tag).toBe("markdown");
    expect(cardJson.body.elements[0].content).toBe(DEFAULT_PLACEHOLDER);
    expect(cardJson.body.elements[0].element_id).toBe("md_main");

    // reply received the created card_id inside interactive msg content.
    expect(replySpy).toHaveBeenCalledTimes(1);
    const replyArg = replySpy.mock.calls[0][0];
    expect(replyArg.path.message_id).toBe("msg-7");
    expect(replyArg.data.msg_type).toBe("interactive");
    const replyContent = JSON.parse(replyArg.data.content);
    expect(replyContent).toEqual({ type: "card", data: { card_id: "CARD-1" } });
  });

  it("accepts a custom placeholder string", async () => {
    const { client, createSpy } = makeLarkClient();
    await openTypingCard(client as any, "msg-1", "Running tools…");
    const cardJson = JSON.parse(createSpy.mock.calls[0][0].data.data);
    expect(cardJson.body.elements[0].content).toBe("Running tools…");
  });

  it("returns null when card.create throws — caller should fall back", async () => {
    const { client } = makeLarkClient({ createThrows: new Error("boom") });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const session = await openTypingCard(client as any, "msg-1");
    expect(session).toBeNull();
  });

  it("returns null when the response has no card_id", async () => {
    const { client } = makeLarkClient({ createRes: { data: {} } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const session = await openTypingCard(client as any, "msg-1");
    expect(session).toBeNull();
  });

  it("returns null when the reply call throws (card exists but user never saw it)", async () => {
    const { client } = makeLarkClient({ replyThrows: new Error("403") });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const session = await openTypingCard(client as any, "msg-1");
    expect(session).toBeNull();
  });
});

// ── finalizeCard ───────────────────────────────────────────────

describe("finalizeCard", () => {
  it("updateCardContent refreshes markdown without disabling streaming", async () => {
    const { client, contentSpy, settingsSpy } = makeLarkClient();
    const session = { cardId: "CARD-1", elementId: "md_main", sequence: 0 };

    const ok = await updateCardContent(client as any, session, "> milestone");
    expect(ok).toBe(true);

    expect(contentSpy).toHaveBeenCalledTimes(1);
    expect(contentSpy.mock.calls[0][0]).toMatchObject({
      path: { card_id: "CARD-1", element_id: "md_main" },
      data: { content: "｜ milestone", sequence: 1 },
    });
    expect(settingsSpy).not.toHaveBeenCalled();
    expect(session.sequence).toBe(1);
  });

  it("updates element content with sanitized markdown, then disables streaming_mode; increments sequence", async () => {
    const { client, contentSpy, settingsSpy } = makeLarkClient();
    const session = { cardId: "CARD-1", elementId: "md_main", sequence: 0 };

    const ok = await finalizeCard(client as any, session, "# Heading\ntext **bold**");
    expect(ok).toBe(true);

    // content call gets sanitized text (heading passes through unchanged now)
    const contentArg = contentSpy.mock.calls[0][0];
    expect(contentArg.path).toEqual({ card_id: "CARD-1", element_id: "md_main" });
    expect(contentArg.data.content).toBe("# Heading\ntext **bold**");
    expect(contentArg.data.sequence).toBe(1);

    // settings flips streaming_mode off with a later sequence
    const settingsArg = settingsSpy.mock.calls[0][0];
    expect(settingsArg.path).toEqual({ card_id: "CARD-1" });
    const settingsJson = JSON.parse(settingsArg.data.settings);
    expect(settingsJson.config.streaming_mode).toBe(false);
    expect(settingsArg.data.sequence).toBe(2);

    // Session's sequence is mutated so follow-ups stay monotonic
    expect(session.sequence).toBe(2);
  });

  it("returns false when element.content fails but still attempts to disable streaming", async () => {
    const { client, contentSpy, settingsSpy } = makeLarkClient({ contentThrows: new Error("rate limited") });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const session = { cardId: "CARD-1", elementId: "md_main", sequence: 0 };
    const ok = await finalizeCard(client as any, session, "final text");
    expect(ok).toBe(false);
    expect(contentSpy).toHaveBeenCalledTimes(1);
    // Still tries settings so the card doesn't stay visually stuck in "streaming" state.
    expect(settingsSpy).toHaveBeenCalledTimes(1);
  });

  it("returns false when card.settings fails (content did succeed)", async () => {
    const { client } = makeLarkClient({ settingsThrows: new Error("500") });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const session = { cardId: "C", elementId: "md_main", sequence: 0 };
    const ok = await finalizeCard(client as any, session, "x");
    expect(ok).toBe(false);
  });

  it("passes the empty-result notice through untouched (no heading/table transforms hit it)", async () => {
    const { client, contentSpy } = makeLarkClient();
    await finalizeCard(client as any, { cardId: "C", elementId: "md_main", sequence: 0 }, EMPTY_RESULT_NOTICE);
    expect(contentSpy.mock.calls[0][0].data.content).toBe(EMPTY_RESULT_NOTICE);
  });
});

describe("buildMilestoneCardMarkdown", () => {
  it("marks earlier milestones done (✅) and the latest in progress (⏳) while streaming", () => {
    const md = buildMilestoneCardMarkdown({ milestones: ["pulled diff", "queried datadog", "writing summary"] });
    const lines = md.split("\n");
    expect(lines).toEqual([
      "✅ pulled diff",
      "✅ queried datadog",
      "⏳ writing summary",
    ]);
  });

  it("renders all milestones done + a blank line + the conclusion when final", () => {
    const md = buildMilestoneCardMarkdown({ milestones: ["step 1", "step 2"], finalText: "Root cause: X. Roll back #4821." });
    expect(md).toBe("✅ step 1\n✅ step 2\n\nRoot cause: X. Roll back #4821.");
  });

  it("is just the conclusion when there are no milestones (legacy behavior)", () => {
    expect(buildMilestoneCardMarkdown({ milestones: [], finalText: "done." })).toBe("done.");
  });

  it("ignores blank milestone entries", () => {
    const md = buildMilestoneCardMarkdown({ milestones: ["  ", "real step", ""] });
    expect(md).toBe("⏳ real step");
  });

  it("preserves inline code so chips render", () => {
    const md = buildMilestoneCardMarkdown({ milestones: ["502s isolated to `cart-service`"] });
    expect(md).toContain("`cart-service`");
  });

  it("caps to the most recent maxVisible with a (+k) overflow prefix", () => {
    const milestones = Array.from({ length: 14 }, (_, i) => `step ${i + 1}`);
    const md = buildMilestoneCardMarkdown({ milestones, maxVisible: 10 });
    const lines = md.split("\n");
    expect(lines[0]).toBe("… (+4)"); // 14 - 10 hidden
    expect(lines).toHaveLength(11); // overflow line + 10 shown
    expect(md).toContain("step 14"); // newest kept
    expect(md).not.toContain("✅ step 1\n"); // oldest dropped
  });
});
