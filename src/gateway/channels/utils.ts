/**
 * Convert standard markdown to Feishu card-compatible markdown.
 *
 * Feishu card `{ tag: "markdown" }` only supports: **bold**, *italic*,
 * ~~strikethrough~~, [links](url), and <text_color> tags.
 *
 * Unsupported syntax (headers, code blocks, inline code, lists,
 * blockquotes, tables, etc.) is converted to plain-text equivalents.
 */
export function markdownToFeishu(md: string): string {
  // 1. Convert fenced code blocks (```lang\n...\n```) to indented plain text
  let result = md.replace(/```[\s\S]*?```/g, (block) => {
    const inner = block.replace(/^```[^\n]*\n?/, "").replace(/\n?```$/, "");
    return inner
      .split("\n")
      .map((line) => "  " + line)
      .join("\n");
  });

  // 2. Convert inline code (`code`) — strip backticks
  result = result.replace(/`([^`]+)`/g, "$1");

  // 3. Convert headers (# ... ######) to bold text
  result = result.replace(/^(#{1,6})\s+(.+)$/gm, "**$2**");

  // 4. Convert unordered list items (-, *, +) to bullet character
  result = result.replace(/^[ \t]*[-*+]\s+/gm, "• ");

  // 5. Convert blockquotes (> ...) — strip the > prefix
  result = result.replace(/^>\s?/gm, "");

  // 6. Convert horizontal rules (---, ***, ___) to separator line
  result = result.replace(/^[-*_]{3,}$/gm, "────────────");

  // 7. Convert images ![alt](url) to just [alt](url)
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "[$1]($2)");

  return result;
}

/**
 * Convert standard markdown to Telegram-safe HTML.
 *
 * Telegram's "HTML" parse mode supports: <b>, <i>, <u>, <s>, <code>, <pre>,
 * <a href="...">, <tg-spoiler>.  Everything else must be escaped.
 *
 * Reference: openclaw's markdownToTelegramHtmlChunks pattern.
 */
export function markdownToTelegramHtml(md: string): string {
  // Escape HTML entities first (must happen before we introduce our own tags)
  let result = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Fenced code blocks: ```lang\n...\n``` → <pre>...</pre>
  result = result.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code) => `<pre>${code}</pre>`);

  // Inline code: `code` → <code>code</code>
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold: **text** → <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // Italic: *text* → <i>text</i>  (but not inside <b> tags already converted)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");

  // Strikethrough: ~~text~~ → <s>text</s>
  result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links: [text](url) → <a href="url">text</a>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Headers: # ... → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  return result;
}

/**
 * Convert standard markdown to Slack mrkdwn format.
 *
 * Slack's mrkdwn syntax differs from standard markdown:
 * - Bold: *text* (not **text**)
 * - Italic: _text_ (not *text*)
 * - Links: <url|text> (not [text](url))
 * - Code and code blocks stay the same.
 */
export function markdownToSlackMrkdwn(md: string): string {
  let result = md;

  // Links first (before bold/italic conversion): [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Bold: **text** → *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Italic: *text* → _text_  (single asterisks that aren't part of bold)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "_$1_");

  // Strikethrough: ~~text~~ → ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Headers: # ... → bold
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  return result;
}

/**
 * Split a long message into chunks that respect a maximum length.
 * Tries to split at newlines, then spaces, then hard-splits.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx <= 0) {
      // Fall back to space
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx <= 0) {
      // Hard split
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}
