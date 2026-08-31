/** One model dispatch: the ordered tool calls emitted by one assistant message. */
export interface ToolsetEnvelope {
  version: 1;
  llm_round: number;
  tool_calls: Array<{
    tool_call_id: string;
    position: number;
    tool_name: string;
    /** Exact JSON text presented on the tool start event, before persistence redaction. */
    tool_input: string;
  }>;
}

export interface CapturedToolCall {
  toolCallId: string;
  toolset: ToolsetEnvelope;
}

function toolInputText(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
}

/**
 * Associates tool execution events with their canonical assistant-message batch.
 *
 * Deliberately does not infer a batch from timestamps or tool names. Events without
 * an invocation id, or starts not preceded by the assistant tool-call message, stay
 * ungrouped instead of creating analytically false relationships.
 */
export class ToolsetCapture {
  private readonly byToolCallId = new Map<string, ToolsetEnvelope>();
  private llmRound = 0;

  observe(event: Record<string, any>): void {
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    this.llmRound++;
    const blocks = Array.isArray(event.message.content) ? event.message.content : [];
    const calls: ToolsetEnvelope["tool_calls"] = [];
    for (const block of blocks) {
      if (block?.type !== "toolCall") continue;
      const id = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "";
      if (!id || !name) continue;
      const args = block.arguments ?? block.args ?? {};
      calls.push({
        tool_call_id: id,
        position: calls.length,
        tool_name: name,
        tool_input: toolInputText(args),
      });
    }
    if (calls.length === 0) return;
    const toolset: ToolsetEnvelope = { version: 1, llm_round: this.llmRound, tool_calls: calls };
    for (const call of calls) this.byToolCallId.set(call.tool_call_id, toolset);
  }

  match(event: Record<string, any>): CapturedToolCall | null {
    const rawId = event.toolCallId ?? event.toolUseID;
    const toolCallId = typeof rawId === "string" ? rawId : "";
    if (!toolCallId) return null;
    const toolset = this.byToolCallId.get(toolCallId);
    return toolset ? { toolCallId, toolset } : null;
  }

  finish(toolCallId: string): void {
    this.byToolCallId.delete(toolCallId);
  }
}

export function redactToolset(
  toolset: ToolsetEnvelope,
  redact: (value: string) => string,
): ToolsetEnvelope {
  return {
    ...toolset,
    tool_calls: toolset.tool_calls.map((call) => ({ ...call, tool_input: redact(call.tool_input) })),
  };
}
