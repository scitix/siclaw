import { expect, it, vi } from "vitest";
import { memoryContextExtension } from "./context.js";
const path = `memory/${"a".repeat(64)}.md`;
const item = {
  path,
  kind: "preference",
  scope: "user",
  claim: "language",
  content: "I prefer Chinese responses.",
  content_start_line_number: 1,
  truncated: false,
  matched_queries: [],
  source_session_id: "s",
  source_entry_id: "u",
  created_at: 1,
  expires_at: 2,
};
it("does not install automatic recall without the selected memory read capability", () => {
  const api = { on: vi.fn() },
    source = { search: vi.fn(), read: vi.fn(), brief: vi.fn() };
  memoryContextExtension(api as any, source, { current: 1 }, [
    { name: "read" },
  ]);
  expect(api.on).not.toHaveBeenCalled();
});
it("rechecks the authority, avoids repeated context and resets only after compaction", async () => {
  const handlers = new Map<string, Function>(),
    turn = { current: 1 };
  const source = {
    search: vi.fn(),
    read: vi.fn(),
    brief: vi.fn(async () => ({ generation: 0, items: [item] })),
  };
  memoryContextExtension(
    { on: (n: string, f: Function) => handlers.set(n, f) } as any,
    source,
    turn,
  );
  const before = handlers.get("before_agent_start")!;
  expect(
    (await before({ prompt: "Prepare an incident report." })).message.content,
  ).toContain(item.content);
  turn.current++;
  expect(
    (await before({ prompt: "Continue the report.", systemPrompt: "Base" }))
      .message,
  ).toBeUndefined();
  expect(source.brief).toHaveBeenCalledTimes(2);
  await handlers.get("session_compact")!();
  turn.current++;
  expect(
    (await before({ prompt: "Continue the report." })).message.content,
  ).toContain(item.content);
  turn.current++;
  await before({ prompt: "Translate this sentence." });
  expect(source.brief).toHaveBeenCalledTimes(3);
});

it("bounds optional foreground recall and never records a late result as delivered", async () => {
 vi.useFakeTimers();
 try {
  const handlers = new Map<string, Function>(), turn = {current: 1};
  let resolve: (v: any) => void = () => {};
  const source = {search: vi.fn(), read: vi.fn(), brief: vi.fn().mockImplementationOnce(() => new Promise(r => {resolve = r;})).mockResolvedValue({generation: 0, items: [item]})};
  memoryContextExtension({on: (n: string, f: Function) => handlers.set(n, f)} as any, source, turn);
  const before = handlers.get("before_agent_start")!;
  const pending = before({prompt: "Prepare an incident report.", systemPrompt: "Base"});
  await vi.advanceTimersByTimeAsync(1500);
  expect((await pending).message).toBeUndefined();
  resolve({generation: 0, items: [item]});
  await Promise.resolve();
  turn.current++;
  expect((await before({prompt: "Continue the report.", systemPrompt: "Base"})).message.content).toContain(item.content);
 } finally {vi.useRealTimers();}
});
