/**
 * Feishu CardKit helpers — streaming-mode placeholder card UX.
 *
 * Flow:
 *  1. `openTypingCard()` creates a streaming-mode card with a "thinking"
 *     placeholder and replies to the triggering user message. This is the
 *     typing indicator — users see feedback within a second of their
 *     message, even before the agent has produced any output.
 *  2. `finalizeCard()` replaces the placeholder with the final answer
 *     (or an error message) and disables streaming mode so the card
 *     locks to its terminal state.
 *
 * Design choices:
 *  - The card uses CardKit schema "2.0" (see buildPlaceholderCard), whose
 *    `markdown` element renders ATX headings (H1-H6) and GFM pipe tables
 *    NATIVELY. We deliberately DO NOT down-convert those — the old
 *    heading→bold / table→code-block normalisation caused rendering bugs
 *    (literal `**`, table shown as a truncated monospace box) and must not
 *    be reintroduced. `sanitizeMarkdownForFeishu` now only rewrites
 *    blockquotes (`>` → `｜ `); everything else passes through. See that
 *    function's doc comment for details.
 *  - All failures return `null` / `false` so the caller can fall back
 *    to the legacy plain-text reply — we never throw into the channel
 *    message loop.
 *  - `sequence` counters are required by the CardKit streaming API so
 *    the platform can order updates; we increment inside `CardSession`.
 */

/**
 * Locale-aware placeholder + notice strings. "feishu" maps to zh-CN (the
 * domestic Feishu install base is predominantly Chinese-speaking); "lark"
 * maps to en-US (the global install base). Callers pick by passing the
 * card-channel's `config.domain`.
 */
export type LarkLocale = "zh-CN" | "en-US";

export const PLACEHOLDER_BY_LOCALE: Record<LarkLocale, string> = {
  "zh-CN": "🤔 正在思考...",
  "en-US": "🤔 Thinking...",
};

export const EMPTY_RESULT_NOTICE_BY_LOCALE: Record<LarkLocale, string> = {
  "zh-CN": "⚠️ Agent 未返回结果。",
  "en-US": "⚠️ The agent returned no response.",
};

/** Default locale — kept Chinese-first for backward compat with the original hard-coded strings. */
export const DEFAULT_PLACEHOLDER = PLACEHOLDER_BY_LOCALE["zh-CN"];
export const EMPTY_RESULT_NOTICE = EMPTY_RESULT_NOTICE_BY_LOCALE["zh-CN"];

/**
 * Map Lark SDK `domain` ("feishu" | "lark") → display locale.
 * "feishu" (China, open.feishu.cn) → zh-CN; "lark" (Global, open.larksuite.com) → en-US.
 */
export function localeForDomain(domain: string | undefined): LarkLocale {
  return domain === "lark" ? "en-US" : "zh-CN";
}

/** Primary markdown element id — shared between create and patch calls. */
const MD_ELEMENT_ID = "md_main";

/**
 * Render the Claude-tag style progress body: accumulated `channel_update`
 * milestones as a checklist, then the final conclusion on completion.
 *
 * - Streaming (finalText == null): earlier milestones render ✅ (done), the
 *   latest renders ⏳ (the current step), giving the live "✓ done / ✱ doing"
 *   look without needing a separate current-step signal.
 * - Final (finalText set): all milestones render ✅, a blank line, then the
 *   conclusion. With no milestones this is just the conclusion (legacy behavior).
 *
 * Only the most recent `maxVisible` milestones are shown (with a `…(+k)` prefix
 * for the rest) so a long SRE investigation stays within the card's size limits.
 * Milestone text passes through verbatim, so an agent writing inline code
 * (`` `cart-service` ``) gets rendered chips for free.
 */
export function buildMilestoneCardMarkdown(opts: {
  milestones: string[];
  finalText?: string | null;
  maxVisible?: number;
}): string {
  const all = opts.milestones.map((m) => (m ?? "").trim()).filter(Boolean);
  const isFinal = opts.finalText != null;
  const maxVisible = opts.maxVisible ?? 10;
  const hidden = Math.max(0, all.length - maxVisible);
  const shown = hidden > 0 ? all.slice(all.length - maxVisible) : all;
  const lines: string[] = [];
  if (hidden > 0) lines.push(`… (+${hidden})`);
  shown.forEach((m, i) => {
    const inProgress = !isFinal && i === shown.length - 1;
    lines.push(`${inProgress ? "⏳" : "✅"} ${m}`);
  });
  if (isFinal) {
    const final = opts.finalText!.trim();
    if (lines.length && final) lines.push("");
    if (final) lines.push(final);
  }
  return lines.join("\n");
}

/** Handle returned by `openTypingCard` and consumed by `finalizeCard`. */
export interface CardSession {
  cardId: string;
  elementId: string;
  /** Monotonic counter required by CardKit for ordering streamed updates. */
  sequence: number;
}

/**
 * Convert markdown to the subset Feishu's card `markdown` element renders.
 *
 * This card uses CardKit schema "2.0" (see buildPlaceholderCard), whose
 * `markdown` element renders ATX headings (`#`…`######`) and GFM pipe tables
 * NATIVELY (Feishu docs: 标题/表格 仅支持 JSON 2.0 富文本组件). We no longer
 * down-convert them — doing so was actively harmful:
 *  - heading → `**…**` produced literal `**` when the bold marker ended up
 *    wedged against adjacent CJK/emoji text (shown as raw asterisks).
 *  - table → fenced code block rendered as a truncated, line-numbered,
 *    horizontally-scrolling monospace box instead of a real table.
 * Headings and tables now pass through unchanged for native rendering.
 *
 * Blockquotes (`>`) are still rewritten to a full-width vertical bar prefix
 * `｜ ` (left as-is in this change).
 *
 * Everything else (bold, italic, strikethrough, lists, fenced code blocks,
 * inline code, links, horizontal rule, `<at>`, emoji shortcodes) is passed
 * through unchanged.
 */
export function sanitizeMarkdownForFeishu(input: string): string {
  if (!input) return input;

  // Carve out fenced code blocks before touching anything else, then restore
  // them at the end — we must not transform markdown syntax inside code.
  const codeBlocks: string[] = [];
  let text = input.replace(/```[\s\S]*?```/g, (block) => {
    codeBlocks.push(block);
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  // NOTE: ATX headings (#/##/###) and GFM pipe tables are intentionally passed
  // THROUGH — the schema-2.0 markdown element renders them natively. (They were
  // previously down-converted here; that caused the literal-`**` and
  // table-as-codeblock rendering bugs.)

  // Blockquotes → "｜ " prefix (full-width pipe keeps the indent visible
  // without relying on an unsupported tag).
  text = text.replace(/^\s*>\s?(.*)$/gm, "｜ $1");

  // Restore fenced code blocks.
  text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)] ?? "");

  return text;
}

/**
 * Build the initial streaming card JSON. The `element_id` is stable so
 * `finalizeCard` can patch the same element without recomputing it.
 */
function buildPlaceholderCard(placeholder: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      streaming_config: {
        print_frequency_ms: { default: 70 },
        print_step: { default: 1 },
        print_strategy: "fast",
      },
    },
    body: {
      elements: [
        { tag: "markdown", content: placeholder, element_id: MD_ELEMENT_ID },
      ],
    },
  };
}

/**
 * Create a streaming-mode placeholder card and reply with it to the
 * triggering message. Returns the card handle on success, or `null` if
 * anything fails (caller falls back to plain text).
 */
export async function openTypingCard(
  larkClient: any,
  messageId: string,
  placeholder: string = DEFAULT_PLACEHOLDER,
): Promise<CardSession | null> {
  try {
    const createRes = await larkClient.cardkit.v1.card.create({
      data: {
        type: "card_json",
        data: JSON.stringify(buildPlaceholderCard(placeholder)),
      },
    });
    const cardId: string | undefined = createRes?.data?.card_id;
    if (!cardId) {
      console.warn("[lark-card] create returned no card_id; falling back to text reply");
      return null;
    }

    // Posting the card into the chat. The SDK does NOT throw on a non-zero API
    // code (e.g. the app lacks the im:message send scope) — the card would be
    // created in CardKit but never appear in the chat, with no error. Surface
    // the code and fall back to a plain-text reply so the failure is visible.
    const replyRes = await larkClient.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
      },
    });
    if (replyRes && typeof replyRes.code === "number" && replyRes.code !== 0) {
      console.error(`[lark-card] posting card to chat failed for messageId=${messageId}: code=${replyRes.code} msg=${replyRes.msg} (does the app have the im:message send scope?)`);
      return null;
    }
    return { cardId, elementId: MD_ELEMENT_ID, sequence: 0 };
  } catch (err) {
    console.error(`[lark-card] openTypingCard failed for messageId=${messageId}:`, err);
    return null;
  }
}

/**
 * Update the visible markdown while keeping the card in streaming mode.
 * Used for sparse channel-visible milestones; final answers should still use
 * `finalizeCard` so the card locks to its terminal state.
 */
export async function updateCardContent(
  larkClient: any,
  session: CardSession,
  text: string,
): Promise<boolean> {
  const sanitized = sanitizeMarkdownForFeishu(text);
  try {
    await larkClient.cardkit.v1.cardElement.content({
      path: { card_id: session.cardId, element_id: session.elementId },
      data: { content: sanitized, sequence: ++session.sequence },
    });
    return true;
  } catch (err) {
    console.error(`[lark-card] element.content failed for cardId=${session.cardId}:`, err);
    return false;
  }
}

/**
 * Replace the card's markdown body with `finalText` and disable streaming
 * mode. Returns `true` iff both the content update and the settings flip
 * succeeded; `false` if either step failed (caller should log — at this
 * point the card is already visible, so a plain-text fallback would create
 * duplicate replies).
 */
export async function finalizeCard(
  larkClient: any,
  session: CardSession,
  finalText: string,
): Promise<boolean> {
  const sanitized = sanitizeMarkdownForFeishu(finalText);
  let contentOk = false;
  try {
    await larkClient.cardkit.v1.cardElement.content({
      path: { card_id: session.cardId, element_id: session.elementId },
      data: { content: sanitized, sequence: ++session.sequence },
    });
    contentOk = true;
  } catch (err) {
    console.error(`[lark-card] element.content failed for cardId=${session.cardId}:`, err);
  }

  let settingsOk = false;
  try {
    await larkClient.cardkit.v1.card.settings({
      path: { card_id: session.cardId },
      data: {
        settings: JSON.stringify({ config: { streaming_mode: false } }),
        sequence: ++session.sequence,
      },
    });
    settingsOk = true;
  } catch (err) {
    console.error(`[lark-card] card.settings(streaming_mode=false) failed for cardId=${session.cardId}:`, err);
  }

  return contentOk && settingsOk;
}
