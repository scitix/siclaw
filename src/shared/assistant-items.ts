/** Public assistant output identity. Never contains private reasoning blocks. */
export type AssistantPhase = "commentary" | "final_answer";
export interface AssistantItem {
  id: string;
  messageId: string;
  contentIndex: number;
  text: string;
  phase?: AssistantPhase;
  textSignature?: string;
  api?: string;
  provider?: string;
  model?: string;
  sequence: number;
}

export function textPhase(signature: unknown): AssistantPhase | undefined {
  if (typeof signature !== "string" || !signature.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(signature);
    return value.v === 1 && (value.phase === "commentary" || value.phase === "final_answer") ? value.phase : undefined;
  } catch { return undefined; }
}

/** Extract only public text and its replay identity, preserving provider block order. */
export function assistantTextBlocks(message: Record<string, unknown>): Array<{ index: number; text: string; textSignature?: string; phase?: AssistantPhase }> {
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block, index) => {
    if (block?.type !== "text" || typeof block.text !== "string") return [];
    const textSignature = typeof block.textSignature === "string" ? block.textSignature : undefined;
    return [{ index, text: block.text, ...(textSignature ? { textSignature } : {}), phase: textPhase(textSignature) }];
  });
}
