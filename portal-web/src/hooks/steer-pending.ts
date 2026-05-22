/**
 * Extract text from a pi-ai UserMessage content field.
 * content can be a plain string or an array of TextContent/ImageContent blocks.
 */
export function extractUserMessageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return (content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("")
}
