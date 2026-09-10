import { randomUUID } from "node:crypto";
import type { BrainSession } from "../core/brain-session.js";
import type { ToolResultArtifactStore } from "../core/tool-result-artifact.js";

const TICKET_SOURCE = "internal:subagent-session";
export interface SubagentTicket {
  childSessionId: string;
  userId: string;
  subagentType: string;
}

/** Tickets are runtime-issued artifacts: same parent scope, private files, integrity and expiry. */
export async function createSubagentTickets(store: ToolResultArtifactStore, userId: string, subagentType: string, count: number) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error("A subagent launch needs at least one target");
  const tickets: SubagentTicket[] = Array.from({ length: count }, () => ({ childSessionId: randomUUID(), userId, subagentType }));
  // One immutable artifact per batch, rather than consuming the artifact quota once per target.
  const saved = await store.capture({ toolName: TICKET_SOURCE, toolCallId: tickets[0].childSessionId, text: JSON.stringify(tickets) });
  if (!("reference" in saved)) throw new Error(`Cannot create resumable subagent: ${saved.failure.reason}`);
  return tickets.map((ticket, index) => ({ ...ticket, resumeHandle: `${saved.reference.id}:${index}` }));
}

export async function createSubagentTicket(store: ToolResultArtifactStore, userId: string, subagentType: string) {
  return (await createSubagentTickets(store, userId, subagentType, 1))[0];
}

export async function readSubagentTicket(store: ToolResultArtifactStore, handle: string, userId: string): Promise<SubagentTicket> {
  const match = /^(tra_[a-f0-9]{32}):(0|[1-9][0-9]*)$/.exec(handle);
  if (!match) throw new Error("Invalid subagent handle");
  const result = await store.readFull(match[1]);
  if (result.toolName !== TICKET_SOURCE) throw new Error("Not a runtime-issued subagent handle");
  const tickets = JSON.parse(result.text) as SubagentTicket[];
  const ticket = tickets[Number(match[2])];
  if (!ticket || ticket.userId !== userId || !/^[a-f0-9-]{36}$/.test(ticket.childSessionId)) {
    throw new Error("Subagent handle does not belong to this caller");
  }
  return ticket;
}

/** One live run, including time queued for a slot. No other session can acquire its ticket. */
export class SubagentMailbox {
  private brain?: BrainSession;
  private reviewing = false;
  private accepting = true;
  private pending: string[] = [];
  private updates: string[] = [];
  private unrecorded: string[] = [];
  private combinedGuidance = new Map<string, string[]>();
  private delivery: Promise<void> = Promise.resolve();

  attach(brain: BrainSession) { this.brain = brain; }
  setReviewing(value: boolean) { this.reviewing = value; }
  assignment(initial: string) { return [initial, ...this.updates.map(text => `Caller guidance:\n${text}`)].join("\n\n"); }
  async send(text: string): Promise<void> {
    if (!this.accepting) throw new Error("Subagent is finishing; retry the follow-up after its result arrives");
    if (this.updates.length >= 32) throw new Error("This run has reached its guidance limit; wait for its result before following up");
    this.updates.push(text);
    this.unrecorded.push(text);
    this.pending.push(text);
    this.delivery = this.delivery.then(async () => {
      if (!this.brain || this.reviewing || !this.accepting) return;
      try {
        await this.brain.steer(text);
        const index = this.pending.indexOf(text);
        if (index >= 0) this.pending.splice(index, 1);
      } catch { /* A model repair may hold the brain. Deliver at the next prompt boundary. */ }
    });
    await this.delivery;
  }
  async takePending(): Promise<string | undefined> {
    await this.delivery;
    const queued = this.brain?.clearQueue();
    const messages = [...(queued?.steering ?? []), ...(queued?.followUp ?? []), ...this.pending];
    this.pending = [];
    if (!messages.length) return undefined;
    const prompt = messages.join("\n\n");
    this.combinedGuidance.set(prompt, messages);
    return prompt;
  }
  /** Only caller guidance observed in a consumed native user message is audited.
   * Pending/repair guidance may be combined into a prompt; repeated lifecycle
   * events must not duplicate it, and internal assessment prompts never call this. */
  consumeGuidance(prompt: string): string[] {
    // Match exact native steering or a batch attached by runSubagentToAcceptance.
    // A substring in the original assignment is not proof of guidance delivery.
    const batch = [...this.combinedGuidance.keys()].find(text =>
      prompt === text || prompt.endsWith(`\n\nCaller guidance:\n${text}`));
    const delivered = batch === undefined ? [prompt] : this.combinedGuidance.get(batch)!;
    if (batch !== undefined) this.combinedGuidance.delete(batch);
    const consumed: string[] = [];
    for (const text of delivered) {
      const index = this.unrecorded.indexOf(text);
      if (index < 0) continue;
      this.unrecorded.splice(index, 1);
      consumed.push(text);
    }
    return consumed;
  }
  /** Synchronous seal after checking pending updates: no acknowledgement can race past completion. */
  seal(): boolean {
    if (this.pending.length) return false;
    this.accepting = false;
    return true;
  }
  close() { this.accepting = false; }
}
