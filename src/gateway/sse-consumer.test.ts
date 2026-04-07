import { describe, it, expect } from "vitest";
import { consumeAgentSse } from "./sse-consumer.js";
import type { AgentBoxClient } from "./agentbox/client.js";

/** Helper: create a mock AgentBoxClient whose streamEvents yields the given events */
function mockClient(events: Record<string, unknown>[]): AgentBoxClient {
  return {
    async *streamEvents() {
      for (const e of events) yield e;
    },
  } as unknown as AgentBoxClient;
}

describe("consumeAgentSse", () => {
  const baseOpts = { sessionId: "s1", userId: "u1" };

  it("extracts assistant text from message_end content", async () => {
    const client = mockClient([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_end", message: { role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: "Hello world" }] } },
      { type: "agent_end" },
    ]);
    const result = await consumeAgentSse({ ...baseOpts, client });
    expect(result.resultText).toBe("Hello world");
    expect(result.errorMessage).toBe("");
  });

  it("extracts text from message_update deltas when message_end content is empty", async () => {
    const client = mockClient([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "chunk1 " } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "chunk2" } },
      { type: "message_end", message: { role: "assistant", stopReason: "end_turn", content: [] } },
      { type: "agent_end" },
    ]);
    const result = await consumeAgentSse({ ...baseOpts, client });
    expect(result.resultText).toBe("chunk1 chunk2");
    expect(result.errorMessage).toBe("");
  });

  it("captures errorMessage when model returns stopReason=error", async () => {
    const client = mockClient([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_end", message: {
        role: "assistant",
        stopReason: "error",
        content: [],
        errorMessage: "404 error, status code 404, message: Not Found",
      }},
      { type: "agent_end" },
    ]);
    const result = await consumeAgentSse({ ...baseOpts, client });
    expect(result.errorMessage).toBe("404 error, status code 404, message: Not Found");
    expect(result.resultText).toBe("");
  });

  it("prefers task_report over free text", async () => {
    const client = mockClient([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "thinking..." } },
      { type: "tool_execution_start", toolName: "task_report", args: {} },
      { type: "tool_execution_end", toolName: "task_report", result: { content: [{ type: "text", text: "## Report\nAll good" }] } },
      { type: "message_end", message: { role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: "Done" }] } },
      { type: "agent_end" },
    ]);
    const result = await consumeAgentSse({ ...baseOpts, client });
    expect(result.resultText).toBe("## Report\nAll good");
    expect(result.taskReportText).toBe("## Report\nAll good");
  });

  it("returns empty errorMessage on successful completion", async () => {
    const client = mockClient([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_end", message: { role: "assistant", stopReason: "end_turn", content: [{ type: "text", text: "ok" }] } },
      { type: "agent_end" },
    ]);
    const result = await consumeAgentSse({ ...baseOpts, client });
    expect(result.errorMessage).toBe("");
  });

  it("preserves resultText even when errorMessage is set", async () => {
    // Some models may emit partial text before erroring
    const client = mockClient([
      { type: "message_start", message: { role: "assistant" } },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial output" } },
      { type: "message_end", message: {
        role: "assistant",
        stopReason: "error",
        content: [],
        errorMessage: "rate limit exceeded",
      }},
      { type: "agent_end" },
    ]);
    const result = await consumeAgentSse({ ...baseOpts, client });
    expect(result.errorMessage).toBe("rate limit exceeded");
    expect(result.resultText).toBe("partial output");
  });
});
