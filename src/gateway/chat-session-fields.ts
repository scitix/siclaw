const CHAT_SESSION_TITLE_MAX_CHARS = 255;

function truncateField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;

  let truncated = "";
  for (const char of value) {
    if (truncated.length + char.length > maxChars) break;
    truncated += char;
  }
  return truncated;
}

export function normalizeChatSessionTitle(title: string | undefined): string | undefined {
  if (typeof title !== "string") return undefined;
  return truncateField(title, CHAT_SESSION_TITLE_MAX_CHARS);
}
