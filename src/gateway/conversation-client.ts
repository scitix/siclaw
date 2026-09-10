import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { PromptOptions, PromptResponse } from "./agentbox/client.js";

/** An older standalone Portal can still run local turns, without handoff. A
 * transport failure is not a capability answer and must never launch a second
 * local execution after an uncertain remote request. */
export async function supportsConversations(frontend: FrontendWsClient): Promise<boolean> {
  try {
    return (await frontend.request("conversation.capabilities"))?.handoff === true;
  } catch (error) {
    if (/unknown (method|rpc)|method not found|not supported/i.test(String(error))) return false;
    throw error;
  }
}

/** Observe a logical request at the control plane. This client never starts a
 * destination AgentBox locally and never receives the destination's credentials. */
export class ConversationClient {
  /** Events already processed by the destination runtime, including citations. */
  readonly conversationEvents = true;
  private events: unknown[] = [];
  private wake?: () => void;
  private ended = false;
  private failure?: Error;
  private unsubscribe?: () => void;
  private deadline?: ReturnType<typeof setTimeout>;
  private connectionWatch?: ReturnType<typeof setInterval>;

  constructor(private frontend: FrontendWsClient, private entry: {
    agentId: string; userId: string; sessionId: string; userMessageId: string;
    origin: "channel" | "task";
  }) {}

  async prompt(options: PromptOptions): Promise<PromptResponse> {
    if (this.unsubscribe) throw new Error("Conversation request already started");
    this.unsubscribe = this.frontend.subscribe("conversation.event", (data) => {
      const frame = data as { sessionId?: string; requestId?: string; event?: Record<string, unknown> };
      if (frame.sessionId !== this.entry.sessionId || frame.requestId !== this.entry.userMessageId || !frame.event) return;
      if (this.ended) return;
      if (this.events.length >= 4096) { this.fail(new Error("Conversation event buffer exceeded; result delivery is incomplete")); return; }
      this.events.push(frame.event);
      if (frame.event.type === "prompt_done" || frame.event.type === "done") this.ended = true;
      this.wake?.();
    });
    this.deadline = setTimeout(() => this.fail(new Error("Conversation result delivery timed out")), 30 * 60_000);
    this.deadline.unref?.();
    this.connectionWatch = setInterval(() => {
      if (!this.frontend.connected) this.fail(new Error("Control-plane connection lost; execution status is unknown"));
    }, 1000);
    this.connectionWatch.unref?.();
    try {
      const result = await this.frontend.request("conversation.start", {
        ...this.entry, text: options.text, images: options.images, files: options.files,
      });
      return { ...result, ok: true, sessionId: this.entry.sessionId };
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async *streamEvents(sessionId: string): AsyncIterable<unknown> {
    if (sessionId !== this.entry.sessionId) throw new Error("Conversation session mismatch");
    try {
      while (true) {
        if (this.failure) throw this.failure;
        const event = this.events.shift() as Record<string, unknown> | undefined;
        if (event) {
          if (event.type === "stream_error") throw new Error("Conversation execution failed; inspect its trace for details");
          yield event;
          continue;
        }
        if (this.ended) return;
        await new Promise<void>((resolve) => { this.wake = resolve; });
        this.wake = undefined;
      }
    } finally { this.close(); }
  }

  async abort(): Promise<void> {
    await this.frontend.request("conversation.abort", this.entry);
    this.fail(new Error("Conversation canceled"));
  }
  close(): void {
    this.unsubscribe?.(); this.unsubscribe = undefined;
    if (this.deadline) clearTimeout(this.deadline);
    if (this.connectionWatch) clearInterval(this.connectionWatch);
    this.ended = true; this.wake?.();
  }
  private fail(error: Error): void {
    this.failure = error; this.close();
  }
}
