import { describe, it, expect, vi } from "vitest";
import {
  sanitizeMarkdownForFeishu,
  openTypingCard,
  finalizeCard,
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

  it("turns ATX headings into bold lines", () => {
    expect(sanitizeMarkdownForFeishu("# Title")).toBe("**Title**");
    expect(sanitizeMarkdownForFeishu("## Subtitle\nbody")).toBe("**Subtitle**\nbody");
    expect(sanitizeMarkdownForFeishu("### Sec\n### Sec2")).toBe("**Sec**\n**Sec2**");
  });

  it("wraps GFM tables in a fenced code block so columns stay aligned", () => {
    const input = [
      "| col1 | col2 |",
      "|------|------|",
      "| a    | b    |",
      "| c    | d    |",
    ].join("\n") + "\n";
    const out = sanitizeMarkdownForFeishu(input);
    expect(out.startsWith("```\n")).toBe(true);
    expect(out).toContain("| col1 | col2 |");
    expect(out).toContain("|------|------|");
    expect(out).toContain("| a    | b    |");
    expect(out.trim().endsWith("```")).toBe(true);
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
    // Outside transformed
    expect(out).toContain("**outside**");
    // Inside preserved verbatim
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
  it("updates element content with sanitized markdown, then disables streaming_mode; increments sequence", async () => {
    const { client, contentSpy, settingsSpy } = makeLarkClient();
    const session = { cardId: "CARD-1", elementId: "md_main", sequence: 0 };

    const ok = await finalizeCard(client as any, session, "# Heading\ntext **bold**");
    expect(ok).toBe(true);

    // content call gets sanitized text (heading → bold line)
    const contentArg = contentSpy.mock.calls[0][0];
    expect(contentArg.path).toEqual({ card_id: "CARD-1", element_id: "md_main" });
    expect(contentArg.data.content).toBe("**Heading**\ntext **bold**");
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
