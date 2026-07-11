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

// ── 👍/👎 feedback buttons ──────────────────────────────────────────
//
// The final answer card carries a feedback row. Clicks arrive as a
// `card.action.trigger` callback over the SAME long connection as messages;
// the button's `value` payload is self-contained (session/card/channel), so
// persistence never needs a Feishu-message-id → session mapping.

/** Discriminator inside `action.value` so unrelated card actions are ignored. */
export const FEEDBACK_ACTION_KIND = "siclaw_feedback";

/** Stable element id of the feedback row (needed for the post-click echo). */
const FEEDBACK_ELEMENT_ID = "fb_row";

export type FeedbackRating = "up" | "down";

export interface FeedbackContext {
  sessionId: string;
  channelId: string;
}

/** Payload embedded in each button; comes back verbatim in the callback. */
export interface FeedbackActionValue {
  kind: typeof FEEDBACK_ACTION_KIND;
  rating: FeedbackRating;
  session_id: string;
  card_id: string;
  channel_id: string;
  locale: LarkLocale;
}

const FEEDBACK_LABELS: Record<LarkLocale, Record<FeedbackRating, { idle: string; selected: string }>> = {
  "zh-CN": {
    up: { idle: "👍 有帮助", selected: "👍 已反馈" },
    down: { idle: "👎 没帮助", selected: "👎 已反馈" },
  },
  "en-US": {
    up: { idle: "👍 Helpful", selected: "👍 Thanks!" },
    down: { idle: "👎 Not helpful", selected: "👎 Thanks!" },
  },
};

/** Schema-2.0 feedback row: two callback buttons side by side. */
function buildFeedbackRow(
  cardId: string,
  ctx: FeedbackContext,
  locale: LarkLocale,
  selected?: FeedbackRating,
): Record<string, unknown> {
  const button = (rating: FeedbackRating) => {
    const label = FEEDBACK_LABELS[locale][rating];
    const value: FeedbackActionValue = {
      kind: FEEDBACK_ACTION_KIND,
      rating,
      session_id: ctx.sessionId,
      card_id: cardId,
      channel_id: ctx.channelId,
      locale,
    };
    return {
      tag: "button",
      element_id: `fb_${rating}`,
      text: { tag: "plain_text", content: selected === rating ? label.selected : label.idle },
      type: selected === rating ? "primary" : "default",
      behaviors: [{ type: "callback", value }],
    };
  };
  return {
    tag: "column_set",
    element_id: FEEDBACK_ELEMENT_ID,
    columns: [
      { tag: "column", width: "auto", elements: [button("up")] },
      { tag: "column", width: "auto", elements: [button("down")] },
    ],
  };
}

// Cards whose feedback row we can still edit (sequence must keep increasing
// per card, and CardKit gives no way to read it back). Only the CardSession is
// remembered — everything else the echo needs comes back verbatim in the
// button's self-contained action.value. In-memory and bounded: after a gateway
// restart the click still persists + toasts, only the visual button-state echo
// is skipped.
const FEEDBACK_ECHO_CAP = 500;
const feedbackEchoSessions = new Map<string, CardSession>();

function rememberFeedbackCard(session: CardSession): void {
  if (feedbackEchoSessions.size >= FEEDBACK_ECHO_CAP) {
    const oldest = feedbackEchoSessions.keys().next().value;
    if (oldest !== undefined) feedbackEchoSessions.delete(oldest);
  }
  feedbackEchoSessions.set(session.cardId, session);
}

/** Test hook — echo state is process-global. */
export function resetFeedbackEchoForTest(): void {
  feedbackEchoSessions.clear();
}

// ── Group context-mode switch card ───────────────────────────────

export type GroupContextMode = "shared" | "per_user";

export const MODE_ACTION_KIND = "siclaw_ctx_mode";

/** Self-contained payload on each mode button (comes back verbatim in the
 *  callback, mirroring the feedback buttons — no server-side card mapping). */
export interface ModeActionValue {
  kind: typeof MODE_ACTION_KIND;
  channel_id: string;
  route_key: string;
  mode: GroupContextMode;
  locale: LarkLocale;
}

const MODE_CARD_COPY: Record<LarkLocale, {
  title: (m: GroupContextMode) => string;
  hint: string;
  shared: string;
  perUser: string;
}> = {
  "zh-CN": {
    title: (m) => `**本群上下文模式:当前为「${m === "shared" ? "团队模式" : "个人模式"}」**`,
    hint: "团队模式:全群共用一个对话,机器人跟进全群讨论(故障/支持群)。\n个人模式:每个人各自独立对话,互不影响(大群/混合群)。\n切换后是一段新对话。",
    shared: "团队模式",
    perUser: "个人模式",
  },
  "en-US": {
    title: (m) => `**Group context mode: currently ${m === "shared" ? "Team (shared)" : "Personal (per-user)"}**`,
    hint: "Team: everyone shares one conversation; the bot follows the whole group (incident / support rooms).\nPersonal: each person talks to the bot privately (large / mixed groups).\nSwitching starts a fresh conversation.",
    shared: "Team (shared)",
    perUser: "Personal (per-user)",
  },
};

/** Schema-2.0 card: current mode + two callback buttons (current one primary). */
export function buildModeCard(
  currentMode: GroupContextMode,
  channelId: string,
  routeKey: string,
  locale: LarkLocale,
): Record<string, unknown> {
  const copy = MODE_CARD_COPY[locale];
  const button = (mode: GroupContextMode, label: string) => {
    const value: ModeActionValue = { kind: MODE_ACTION_KIND, channel_id: channelId, route_key: routeKey, mode, locale };
    const isCurrent = mode === currentMode;
    return {
      tag: "button",
      element_id: `mode_${mode}`,
      text: { tag: "plain_text", content: isCurrent ? `✓ ${label}` : label },
      type: isCurrent ? "primary" : "default",
      behaviors: [{ type: "callback", value }],
    };
  };
  return {
    schema: "2.0",
    body: {
      elements: [
        { tag: "markdown", content: copy.title(currentMode) },
        { tag: "markdown", content: copy.hint },
        {
          tag: "column_set",
          columns: [
            { tag: "column", width: "auto", elements: [button("shared", copy.shared)] },
            { tag: "column", width: "auto", elements: [button("per_user", copy.perUser)] },
          ],
        },
      ],
    },
  };
}

/** Post the mode-switch card as a reply. Returns false on any failure so the
 *  caller can fall back to a plain-text mode notice. */
export async function sendModeCard(
  larkClient: any,
  messageId: string,
  currentMode: GroupContextMode,
  channelId: string,
  routeKey: string,
  locale: LarkLocale,
): Promise<boolean> {
  try {
    const createRes = await larkClient.cardkit.v1.card.create({
      data: { type: "card_json", data: JSON.stringify(buildModeCard(currentMode, channelId, routeKey, locale)) },
    });
    const cardId: string | undefined = createRes?.data?.card_id;
    if (!cardId) {
      console.warn("[lark-card] mode card create returned no card_id");
      return false;
    }
    const replyRes = await larkClient.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: cardId } }) },
    });
    if (replyRes && typeof replyRes.code === "number" && replyRes.code !== 0) {
      console.error(`[lark-card] posting mode card failed: code=${replyRes.code} msg=${replyRes.msg}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[lark-card] sendModeCard failed:", err);
    return false;
  }
}

/** The Lark SDK does NOT throw on a non-zero API code — check explicitly. */
function cardApiFailed(res: unknown): boolean {
  const code = (res as { code?: unknown } | undefined)?.code;
  return typeof code === "number" && code !== 0;
}

/**
 * Append the feedback row to a finalized card. Best-effort: a failure only
 * loses the buttons, never the answer. Only a verified success registers the
 * card for the post-click echo — a rejected append must not leave a phantom
 * fb_row registration behind.
 */
async function appendFeedbackRow(
  larkClient: any,
  session: CardSession,
  ctx: FeedbackContext,
  locale: LarkLocale,
): Promise<void> {
  try {
    const res = await larkClient.cardkit.v1.cardElement.create({
      path: { card_id: session.cardId },
      data: {
        type: "append",
        sequence: ++session.sequence,
        elements: JSON.stringify([buildFeedbackRow(session.cardId, ctx, locale)]),
      },
    });
    if (cardApiFailed(res)) {
      console.warn(`[lark-card] appending feedback buttons rejected for cardId=${session.cardId}: code=${(res as any).code} msg=${(res as any).msg}`);
      return;
    }
    rememberFeedbackCard(session);
  } catch (err) {
    console.warn(`[lark-card] appending feedback buttons failed for cardId=${session.cardId}:`, err);
  }
}

/**
 * Post-click echo: re-render the feedback row with the chosen button
 * highlighted, rebuilt entirely from the callback's own value payload (the
 * single source of truth). Note the echo reflects the LATEST click — on a
 * shared group card another member's later vote replaces the highlight; the
 * DB keeps one row per person regardless. Returns false when this process no
 * longer knows the card's sequence (e.g. after a restart) — the caller's
 * toast is then the only confirmation, which is acceptable.
 */
export async function applyFeedbackSelection(
  larkClient: any,
  value: Pick<FeedbackActionValue, "card_id" | "session_id" | "channel_id" | "locale">,
  rating: FeedbackRating,
): Promise<boolean> {
  const session = feedbackEchoSessions.get(value.card_id);
  if (!session) return false;
  const locale: LarkLocale = value.locale === "en-US" ? "en-US" : "zh-CN";
  try {
    const res = await larkClient.cardkit.v1.cardElement.update({
      path: { card_id: value.card_id, element_id: FEEDBACK_ELEMENT_ID },
      data: {
        element: JSON.stringify(buildFeedbackRow(
          value.card_id,
          { sessionId: value.session_id, channelId: value.channel_id },
          locale,
          rating,
        )),
        sequence: ++session.sequence,
      },
    });
    if (cardApiFailed(res)) {
      console.warn(`[lark-card] feedback echo rejected for cardId=${value.card_id}: code=${(res as any).code} msg=${(res as any).msg}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[lark-card] feedback echo failed for cardId=${value.card_id}:`, err);
    return false;
  }
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
 *
 * When `feedback` is passed, a 👍/👎 button row is appended after the final
 * content (best-effort — losing the buttons never fails the finalize).
 */
export async function finalizeCard(
  larkClient: any,
  session: CardSession,
  finalText: string,
  feedback?: { ctx: FeedbackContext; locale: LarkLocale },
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

  // Buttons go in AFTER streaming mode is off: structural element ops on a
  // streaming card risk rejection, and this keeps the user-visible finalize
  // (content + settings) off the extra round-trip.
  if (feedback && contentOk && settingsOk) {
    await appendFeedbackRow(larkClient, session, feedback.ctx, feedback.locale);
  }

  return contentOk && settingsOk;
}
