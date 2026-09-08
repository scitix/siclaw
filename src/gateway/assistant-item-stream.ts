import { randomUUID } from "node:crypto";
import { assistantTextBlocks, type AssistantItem } from "../shared/assistant-items.js";

/** Adapts pi text blocks to the same item lifecycle used by Codex's app server. */
export class AssistantItemStream {
  private messageId = randomUUID();
  private closed = false;
  private items = new Map<number, AssistantItem>();

  begin(): void {
    this.messageId = randomUUID();
    this.items.clear();
    this.closed = false;
  }

  snapshot(): AssistantItem[] { return [...this.items.values()].sort((a, b) => a.contentIndex - b.contentIndex).map(item => ({ ...item })); }

  update(event: Record<string, unknown>): { item: AssistantItem; delta?: string; completed?: boolean } | undefined {
    const kind = event.type;
    if (kind !== "text_start" && kind !== "text_delta" && kind !== "text_end") return;
    if (this.closed) this.begin();
    const index = typeof event.contentIndex === "number" ? event.contentIndex : 0;
    const current = this.get(index);
    const partial = event.partial as Record<string, unknown> | undefined;
    const block = partial && assistantTextBlocks(partial).find(part => part.index === index);
    if (kind === "text_delta") current.text += typeof event.delta === "string" ? event.delta : "";
    if (kind === "text_end") current.text = typeof event.content === "string" ? event.content : block?.text ?? current.text;
    this.identify(current, partial, block);
    current.sequence++;
    return { item: { ...current }, ...(kind === "text_delta" ? { delta: String(event.delta ?? "") } : {}), completed: kind === "text_end" };
  }

  complete(message: Record<string, unknown>): AssistantItem[] {
    if (this.closed) this.begin();
    const blocks = assistantTextBlocks(message);
    if (blocks.length > 0) {
      // message_end 是这条消息的权威版本,按它重建。流式 item 与最终块**不在同一个
      // 下标空间**:块下标数的是 content 数组里的位置(thinking / toolCall 块会把它
      // 顶开),而 text_delta 的 contentIndex 有的 provider 根本不带、缺省成 0。按
      // 下标对齐会让同一段文本既作为流式 item、又作为最终块各留一份,落库就是两行
      // 一模一样的回复。所以按**顺序**配对:第 n 个流式 item 就是第 n 个文本块,
      // id 沿用流式那份 —— 前端在流式阶段已经拿这个 id 开了气泡。
      const streamed = this.snapshot();
      this.items.clear();
      blocks.forEach((block, order) => {
        const previous = streamed[order];
        const item: AssistantItem = previous
          ? { ...previous, contentIndex: block.index, text: block.text }
          : { id: `${this.messageId}:${block.index}`, messageId: this.messageId, contentIndex: block.index, text: block.text, sequence: 0 };
        this.items.set(block.index, item);
        this.identify(item, message, block);
      });
    }
    this.closed = true;
    const completedAt = new Date().toISOString();
    for (const item of this.items.values()) item.completedAt = completedAt;
    return this.snapshot().filter(item => item.text.trim()).map(item => ({ ...item, sequence: item.sequence + 1 }));
  }

  private get(index: number): AssistantItem {
    let item = this.items.get(index);
    if (!item) {
      item = { id: `${this.messageId}:${index}`, messageId: this.messageId, contentIndex: index, text: "", sequence: 0 };
      this.items.set(index, item);
    }
    return item;
  }

  private identify(item: AssistantItem, message?: Record<string, unknown>, block?: { textSignature?: string; phase?: AssistantItem["phase"] }): void {
    if (block?.textSignature) item.textSignature = block.textSignature;
    if (block?.phase) item.phase = block.phase;
    for (const key of ["api", "provider", "model"] as const) {
      if (typeof message?.[key] === "string") item[key] = message[key] as string;
    }
  }
}
