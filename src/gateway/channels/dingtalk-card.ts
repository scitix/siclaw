/**
 * DingTalk (钉钉) reply-formatting helpers.
 *
 * Markdown helpers remain the fallback reply path. AI card network operations
 * live in `dingtalk-card-api.ts`, while this module owns shared locale strings,
 * markdown normalization, and the card lifecycle handle.
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

/**
 * Shown when the agent run fails. Intentionally generic: the raw error often
 * carries internal endpoints / infra details, and the chat (group or 1:1) is
 * not a trusted audience — the real error is written to the Runtime log only.
 */
export const AGENT_ERROR_NOTICE_BY_LOCALE: Record<DingTalkLocale, string> = {
  "zh-CN": "❌ 处理失败，请稍后重试。如持续失败，请联系管理员查看服务日志。",
};

export const DEFAULT_PLACEHOLDER = PLACEHOLDER_BY_LOCALE["zh-CN"];
export const EMPTY_RESULT_NOTICE = EMPTY_RESULT_NOTICE_BY_LOCALE["zh-CN"];
export const AGENT_ERROR_NOTICE = AGENT_ERROR_NOTICE_BY_LOCALE["zh-CN"];

/** Structured content contract consumed by the DingTalk AI Card v2 template. */
export type DingTalkCardBlock =
  | { type: 0; markdown: string }
  | { type: 1; markdown: string }
  | { type: 2; markdown: string }
  | { type: 3; mediaId: string; text?: string };

export type DingTalkToolOutcome = "success" | "error" | "blocked";

interface DingTalkCardTimelineEntry {
  kind: "progress" | "tool" | "image";
  text: string;
  mediaId?: string;
}

export interface DingTalkCardTimeline {
  addProgress(text: string): void;
  startTool(name: string): void;
  finishTool(name: string, outcome: DingTalkToolOutcome): void;
  addImage(mediaId: string, text?: string): void;
  render(answer: string): DingTalkCardBlock[];
}

const PROCESS_BLOCK_FONT_SIZE_TOKEN = "common_footnote_text_style__font_size";
const PROCESS_BLOCK_FONT_COLOR_TOKEN = "common_level2_base_color";
const MAX_PROCESS_BLOCK_CHARS = 500;

function normalizeProcessBlockText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .trim()
    .slice(0, MAX_PROCESS_BLOCK_CHARS);
}

function renderProcessBlock(text: string): string {
  return normalizeProcessBlockText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `> <font sizeToken=${PROCESS_BLOCK_FONT_SIZE_TOKEN} colorTokenV2=${PROCESS_BLOCK_FONT_COLOR_TOKEN}>${line}</font>`)
    .join("\n");
}

/**
 * Build a safe card timeline from user-visible progress, tool lifecycle events,
 * the final answer, and images already uploaded to DingTalk. Tool inputs and
 * results are deliberately excluded because they may contain credentials or
 * verbose infrastructure output.
 */
export function createDingTalkCardTimeline(): DingTalkCardTimeline {
  const entries: DingTalkCardTimelineEntry[] = [];
  const pendingTools = new Map<string, number[]>();

  const safeToolName = (name: string): string => normalizeProcessBlockText(name || "tool").slice(0, 80) || "tool";

  return {
    addProgress(text: string): void {
      const normalized = normalizeProcessBlockText(text);
      if (!normalized) return;
      const previous = entries.at(-1);
      if (previous?.kind === "progress" && previous.text === normalized) return;
      entries.push({ kind: "progress", text: normalized });
    },

    startTool(name: string): void {
      const normalizedName = safeToolName(name);
      const index = entries.push({ kind: "tool", text: `正在执行 ${normalizedName}` }) - 1;
      const queue = pendingTools.get(normalizedName) ?? [];
      queue.push(index);
      pendingTools.set(normalizedName, queue);
    },

    finishTool(name: string, outcome: DingTalkToolOutcome): void {
      const normalizedName = safeToolName(name);
      const queue = pendingTools.get(normalizedName);
      const index = queue?.shift();
      if (queue?.length === 0) pendingTools.delete(normalizedName);
      const label = outcome === "success"
        ? `已完成 ${normalizedName}`
        : outcome === "blocked"
          ? `已阻止 ${normalizedName}`
          : `执行失败 ${normalizedName}`;
      if (index !== undefined && entries[index]?.kind === "tool") {
        entries[index] = { kind: "tool", text: label };
      } else {
        entries.push({ kind: "tool", text: label });
      }
    },

    addImage(mediaId: string, text?: string): void {
      const normalizedMediaId = mediaId.trim();
      if (!normalizedMediaId) return;
      entries.push({
        kind: "image",
        mediaId: normalizedMediaId,
        text: text ? normalizeProcessBlockText(text).slice(0, 120) : "",
      });
    },

    render(answer: string): DingTalkCardBlock[] {
      const blocks: DingTalkCardBlock[] = [];
      const images: DingTalkCardBlock[] = [];
      for (const entry of entries) {
        if (entry.kind === "image") {
          if (entry.mediaId) {
            images.push({ type: 3, mediaId: entry.mediaId, ...(entry.text ? { text: entry.text } : {}) });
          }
          continue;
        }
        const markdown = renderProcessBlock(entry.text);
        if (!markdown) continue;
        blocks.push({ type: entry.kind === "progress" ? 1 : 2, markdown });
      }
      if (answer.trim()) blocks.push({ type: 0, markdown: answer });
      return [...blocks, ...images];
    },
  };
}

/**
 * Normalise markdown for DingTalk's `markdown` message renderer.
 *
 * DingTalk supports a broad subset of standard markdown (headings, bold,
 * italic, lists, links, inline code, fenced code, blockquote), so unlike
 * Feishu we pass almost everything through unchanged. Two fix-ups:
 *  1. Collapse 4-6 `#` headings down to `###`, the deepest level DingTalk
 *     renders distinctly — deeper levels otherwise show as plain text with
 *     stray hashes.
 *  2. Strip image syntax (`![alt](url)` → its alt text). Agent output is
 *     untrusted; an inline image makes DingTalk clients auto-fetch an external
 *     URL, which a prompt-injected agent could abuse to exfiltrate data. We
 *     keep the alt text so a legitimate caption survives but no fetch fires.
 *
 * Code fences are carved out first so heading/image syntax inside code is
 * preserved.
 */
export function sanitizeMarkdownForDingTalk(input: string): string {
  if (!input) return input;

  const codeBlocks: string[] = [];
  let text = input.replace(/```[\s\S]*?```/g, (block) => {
    codeBlocks.push(block);
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  // Neutralise images: keep the alt text, drop the URL so no auto-fetch fires.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Clamp #### / ##### / ###### → ### (DingTalk only styles h1-h3).
  text = text.replace(/^(\s*)#{4,6}(\s+)/gm, "$1###$2");

  text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, i: string) => codeBlocks[Number(i)] ?? "");

  return text;
}

/**
 * Derive a notification-preview title from the reply body. DingTalk requires
 * `markdown.title` and uses it ONLY for push notifications and the
 * conversation-list preview (it is never rendered in the chat bubble) — a
 * static title means every preview reads "Siclaw" with no hint of content.
 *
 * Takes the first non-empty line, strips markdown decoration, and truncates.
 */
export function deriveTitleFromText(text: string, maxChars = 60): string {
  const firstLine = (text ?? "")
    .split("\n")
    .map((l) => l
      // headings / blockquotes / list bullets
      .replace(/^\s*(?:#{1,6}|>|[-*+]|\d+\.)\s+/, "")
      // emphasis and inline code markers
      .replace(/(\*\*|__|\*|_|`|~~)/g, "")
      .trim())
    .find((l) => l.length > 0);
  if (!firstLine) return DINGTALK_TITLE;
  return firstLine.length > maxChars ? `${firstLine.slice(0, maxChars)}…` : firstLine;
}

/**
 * Build the markdown message body POSTed to a DingTalk `sessionWebhook`.
 * `title` shows in notification previews; `text` is the rendered body.
 * When no explicit title is given, it is derived from the body so the
 * conversation-list preview shows actual content instead of a static name.
 */
export function buildMarkdownMessage(
  text: string,
  title?: string,
): Record<string, unknown> {
  return {
    msgtype: "markdown",
    markdown: { title: title ?? deriveTitleFromText(text), text: sanitizeMarkdownForDingTalk(text) },
  };
}

/**
 * Build a plain-text message body for the `sessionWebhook`. Used for short
 * control replies (e.g. PAIR confirmations) where markdown adds no value.
 */
export function buildTextMessage(content: string): Record<string, unknown> {
  return { msgtype: "text", text: { content } };
}

// ── AI card lifecycle handle ──────────────────────────────────────────
//
// Network operations live in `dingtalk-card-api.ts`; this module remains the
// owner of card-facing text formatting and the shared lifecycle handle.
export interface DingTalkStreamingCard {
  /** Stable caller-generated identifier used by all card update APIs. */
  outTrackId: string;
  /** Platform card instance id, when returned by createAndDeliver. */
  cardInstanceId?: string;
  /** Delivery tracking key used for future recall/quote support. */
  processQueryKey?: string;
}
