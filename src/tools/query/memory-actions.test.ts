import { expect, it, vi } from "vitest";
import {
  createPrivateMemoryGetTool,
  resetMemoryContext,
  runMemoryAction,
} from "./private-memory.js";
import { updateRegistration, feedbackRegistration } from "./memory-actions.js";
import { memoryContextExtension } from "../../memory/context.js";
const path = `memory/${"a".repeat(64)}.md`;
const parse = (v: any) => JSON.parse(v.content[0].text);
it("shares the context ceiling with catalog injection and checks before mutation", async () => {
  const turn = { current: 0 },
    source = {
      search: vi.fn(),
      read: vi.fn(async () => ({
        path,
        found: true,
        content: "x".repeat(6800),
        start_line_number: 1,
        truncated: false,
      })),
      note: vi.fn(),
      validateExecution: vi.fn(),
    };
  const get = createPrivateMemoryGetTool(source, turn);
  for (let i = 0; i < 10; i++) {
    turn.current = i;
    await get.execute("read", { path });
  }
  // Fill the remaining small space, then ensure an update cannot silently apply.
  while (
    !parse(
      await runMemoryAction(source, turn, 512, async () => ({
        content: "x".repeat(300),
      })),
    ).budget_reached
  ) {}
  const before = source.read.mock.calls.length;
  expect(parse(await get.execute("read", { path })).budget_reached).toBe(true);
  expect(source.read).toHaveBeenCalledTimes(before);
  const update = updateRegistration.create({
    privateMemory: source,
    turnRef: turn,
  } as any);
  expect(
    parse(
      await update.execute("write", {
        action: "remember",
        quote: "Remember this convention.",
      }),
    ).budget_reached,
  ).toBe(true);
  expect(source.note).not.toHaveBeenCalled();
  resetMemoryContext(source, turn);
  expect(parse(await get.execute("read", { path })).found).toBe(true);
});
it("counts repeated citations once without a model feedback round trip", async () => {
  const source = {
      search: vi.fn(),
      read: vi.fn(),
      feedback: vi.fn().mockResolvedValue({ ok: true }),
    },
    turn = { current: 1 };
  const tool = feedbackRegistration.create({
    privateMemory: source,
    turnRef: turn,
  } as any);
  await expect(tool.execute("f1", { path, outcome: "used" })).rejects.toThrow();
  const handlers = new Map<string, Function>();
  memoryContextExtension(
    { on: (name: string, fn: Function) => handlers.set(name, fn) } as any,
    source,
    turn,
  );
  const event = {
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: `Source ${path}` }],
      },
    ],
  };
  await handlers.get("agent_end")!(event);
  await handlers.get("agent_end")!(event);
  expect(source.feedback).toHaveBeenCalledOnce();
  turn.current++;
  await tool.execute("f3", { path, outcome: "incorrect" });
  expect(source.feedback).toHaveBeenCalledTimes(2);
});

it("does not turn an unused remember path into an unrelated target", async () => {
  const source = { note: vi.fn().mockResolvedValue({ status: "accepted" }) };
  const tool = updateRegistration.create({ privateMemory: source, turnRef: { current: 1 } } as any);
  await tool.execute("remember", { action: "remember", path: `memory/${"0".repeat(64)}.md`, quote: "Remember this project convention." });
  expect(source.note).toHaveBeenCalledWith(expect.objectContaining({ action: "remember", quote: "Remember this project convention." }));
  expect(source.note.mock.calls[0][0]).not.toHaveProperty("path");
  await expect(tool.execute("correct", { action: "correct", path: "", quote: "Correct this project convention." })).rejects.toThrow();
  expect(source.note).toHaveBeenCalledOnce();
});
