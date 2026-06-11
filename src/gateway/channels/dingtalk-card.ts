/**
 * DingTalk (钉钉) reply-formatting helpers.
 *
 * Phase 1 (current): the DingTalk handler replies via the temporary
 * `sessionWebhook` URL with a `markdown` message once the agent finishes.
 * This module owns the locale strings and the light markdown normalisation
 * applied before sending. It mirrors `lark-card.ts` in spirit but is much
 * smaller because DingTalk's markdown renderer is close to standard GFM.
 *
 * Phase 2 (future, not implemented): DingTalk AI streaming cards give a
 * Feishu-CardKit-like "typing" experience but require a card template
 * (`cardTemplateId`) registered in the DingTalk developer console plus the
 * AI-card update OpenAPI. The `DingTalkStreamingCard` interface below is the
 * reserved seam for that work — see the TODO at the bottom.
 */

/**
 * DingTalk is a China-domestic platform; there is no global/EN variant, so we
 * keep a single zh-CN locale. The type is kept open for symmetry with
 * `lark-card.ts` in case an English deployment is ever needed.
 */
export type DingTalkLocale = "zh-CN";

/** Shown as the card/message title and as the "thinking" placeholder. */
export const DINGTALK_TITLE = "Siclaw";

export const PLACEHOLDER_BY_LOCALE: Record<DingTalkLocale, string> = {
  "zh-CN": "🤔 正在思考...",
};

export const EMPTY_RESULT_NOTICE_BY_LOCALE: Record<DingTalkLocale, string> = {
  "zh-CN": "⚠️ Agent 未返回结果。",
};

export const DEFAULT_PLACEHOLDER = PLACEHOLDER_BY_LOCALE["zh-CN"];
export const EMPTY_RESULT_NOTICE = EMPTY_RESULT_NOTICE_BY_LOCALE["zh-CN"];

/**
 * Normalise markdown for DingTalk's `markdown` message renderer.
 *
 * DingTalk supports a broad subset of standard markdown (headings, bold,
 * italic, lists, links, images, inline code, fenced code, blockquote), so
 * unlike Feishu we pass almost everything through unchanged. The one fix-up:
 * collapse 4-6 `#` headings down to `###`, the deepest level DingTalk renders
 * distinctly — deeper levels otherwise show as plain text with stray hashes.
 *
 * Code fences are carved out first so heading syntax inside code is preserved.
 */
export function sanitizeMarkdownForDingTalk(input: string): string {
  if (!input) return input;

  const codeBlocks: string[] = [];
  let text = input.replace(/```[\s\S]*?```/g, (block) => {
    codeBlocks.push(block);
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  // Clamp #### / ##### / ###### → ### (DingTalk only styles h1-h3).
  text = text.replace(/^(\s*)#{4,6}(\s+)/gm, "$1###$2");

  text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)] ?? "");

  return text;
}

/**
 * Build the markdown message body POSTed to a DingTalk `sessionWebhook`.
 * `title` shows in notification previews; `text` is the rendered body.
 */
export function buildMarkdownMessage(
  text: string,
  title: string = DINGTALK_TITLE,
): Record<string, unknown> {
  return {
    msgtype: "markdown",
    markdown: { title, text: sanitizeMarkdownForDingTalk(text) },
  };
}

/**
 * Build a plain-text message body for the `sessionWebhook`. Used for short
 * control replies (e.g. PAIR confirmations) where markdown adds no value.
 */
export function buildTextMessage(content: string): Record<string, unknown> {
  return { msgtype: "text", text: { content } };
}

// ── Phase 2 reserved seam (NOT implemented) ───────────────────────────
//
// DingTalk AI streaming cards would replace the single markdown reply with a
// live "typing" card, matching the Feishu CardKit UX. Implementing it requires:
//   1. A card template registered in the DingTalk developer console; the
//      resulting `cardTemplateId` would become a per-channel config field.
//   2. Creating a card instance and delivering it to the conversation
//      (`/v1.0/card/instances` + `.../deliver`).
//   3. Streaming updates via the AI-card update OpenAPI as agent output
//      arrives, then a terminal "finished" update.
//
// When implemented, `openTypingCard`/`finalizeCard` here would mirror the
// lark-card contract: return `null`/`false` on failure so the handler can
// fall back to `buildMarkdownMessage` over `sessionWebhook` (the Phase 1 path).
export interface DingTalkStreamingCard {
  cardInstanceId: string;
  /** Monotonic counter for ordering streamed updates, as the API requires. */
  sequence: number;
}
