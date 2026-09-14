import { expect, it } from "vitest";
import {
  explicitTaskConfirmation,
  selectLearningSources,
  skipLearningModel,
} from "./policy.js";
import type { MemoryLearningSource } from "../shared/private-workspace.js";

it("keeps a long original goal and latest human correction before tool volume", () => {
  const source = (
    id: string,
    role: string,
    text: string,
    n: number,
  ): MemoryLearningSource => ({
    id,
    sourceEntryId: id,
    sourceSessionId: "s",
    role,
    text,
    createdAt: 1,
    expiresAt: 2,
    sourceOrder: n,
  });
  const goal = source(
    "goal",
    "user",
    "Investigate checkout errors on version 7. " + "目标".repeat(1000),
    0,
  );
  const tools = Array.from({ length: 40 }, (_, i) =>
    source(`tool${i}`, "toolResult", `${i}:` + "output ".repeat(300), i + 1),
  );
  const correction = source(
    "correction",
    "user",
    "Only the staging cluster is in scope; preserve production.",
    42,
  );
  const all = [goal, ...tools, correction],
    batch = selectLearningSources(all, all, 24);
  expect([...batch.inputs, ...batch.context].map((v) => v.id)).toEqual(
    expect.arrayContaining(["goal", "correction"]),
  );
  expect(batch.inputs.map((v) => v.sourceOrder)).toEqual(
    batch.inputs.map((v) => v.sourceOrder).sort((a, b) => a! - b!),
  );
  expect(batch.more).toBe(true);
});
it("does not interpret a requested repair or a question as user confirmation", () => {
  for (const quote of [
    "Please fix it and confirm it is working",
    "I have not confirmed the service is working",
    "确认已经修复成功了吗？",
    "请确认修复成功",
  ])
    expect(explicitTaskConfirmation(quote)).toBe(false);
  for (const quote of [
    "I verified the service is working",
    "我验证过，修复成功，服务已经恢复正常",
  ])
    expect(explicitTaskConfirmation(quote)).toBe(true);
});
it("admits trivial no-model batches but preserves explicit targeted review", () => {
  const input: MemoryLearningSource = {
    id: "1",
    sourceEntryId: "1",
    sourceSessionId: "s",
    role: "user",
    text: "Translate this sentence",
    createdAt: 1,
    expiresAt: 2,
  };
  expect(skipLearningModel([input])).toBe(true);
  expect(
    skipLearningModel([
      {
        ...input,
        target: {
          id: "target",
          scope: "user",
          claim: "language",
          summary: "language preference",
        },
      },
    ]),
  ).toBe(false);
});

it("ignores language directives when admitting trivial input", () => {
 expect(skipLearningModel([{role: "user", text: "[System: respond in Chinese]\n谢谢"} as any])).toBe(true);
});
