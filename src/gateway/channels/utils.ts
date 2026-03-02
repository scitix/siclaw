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
