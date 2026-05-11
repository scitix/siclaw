const CHAT_SESSION_TITLE_MAX_CHARS = 255;
const CHAT_SESSION_PREVIEW_MAX_CHARS = 500;

function truncateField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;

  let truncated = "";
  for (const char of value) {
    if (truncated.length + char.length > maxChars) break;
    truncated += char;
  }
  return truncated;
}

export function normalizeChatSessionTitle(title: unknown): string {
  const value = typeof title === "string" && title.length > 0 ? title : "New Session";
  return truncateField(value, CHAT_SESSION_TITLE_MAX_CHARS);
}

export function truncateChatSessionTitle(title: unknown): string | null {
  if (typeof title !== "string") return null;
  return truncateField(title, CHAT_SESSION_TITLE_MAX_CHARS);
}

export function normalizeChatSessionPreview(preview: unknown): string | null {
  if (typeof preview !== "string" || preview.length === 0) return null;
  return truncateField(preview, CHAT_SESSION_PREVIEW_MAX_CHARS);
}
