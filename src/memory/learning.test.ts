import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryLearner, createMemoryClassifier } from "./learning.js";
import type {
  MemoryLearningBatch,
  MemoryLearningBackend,
} from "../shared/private-workspace.js";

const batch = (): MemoryLearningBatch => ({
  token: "batch",
  generation: 0,
  revision: 1,
  hints: [],
  more: false,
  inputs: [
    {
      id: "u",
      sourceEntryId: "u",
      sourceSessionId: "s",
      role: "user",
      text: "Harbor reports should start with impact.",
      createdAt: 1,
      expiresAt: 2,
    },
  ],
});
const empty = (): MemoryLearningBatch => ({
  ...batch(),
  token: "",
  inputs: [],
});
function fixture() {
  const backend = {
    prepareLearning: vi
      .fn()
      .mockResolvedValueOnce(batch())
      .mockResolvedValue(empty()),
    publishLearning: vi.fn().mockResolvedValue({ count: 1, more: false }),
    failLearning: vi.fn().mockResolvedValue(undefined),
  } satisfies MemoryLearningBackend;
  const classify = vi.fn(async (b: MemoryLearningBatch) =>
    b.inputs.map((v) => ({
      entryId: v.sourceEntryId,
      kind: "ignore" as const,
    })),
  );
  return { backend, classify, learner: new MemoryLearner(backend, classify) };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("durable background memory scheduling", () => {
  it("bounds shutdown even when source transport stalls, without publishing late work", async () => {
    vi.useFakeTimers();
    const { backend, classify, learner } = fixture();
    let finish!: (v: MemoryLearningBatch) => void;
    backend.prepareLearning.mockReset().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    learner.wake();
    const closing = learner.close();
    await vi.advanceTimersByTimeAsync(30_000);
    await closing;
    finish(batch()); await learner.drain();
    expect(classify).not.toHaveBeenCalled();
    expect(backend.publishLearning).not.toHaveBeenCalled();
    expect(backend.failLearning).toHaveBeenCalledWith("batch");
  });
  it.each([null, { inputs: [] }, { ...batch(), inputs: [] }, { ...batch(), retryAfterMs: -1 }])("retries malformed prepare responses instead of accepting an idle result: %j", async (response) => {
    vi.useFakeTimers();
    const { backend, classify, learner } = fixture();
    backend.prepareLearning.mockReset().mockResolvedValueOnce(response).mockResolvedValue(empty());
    learner.wake(); await learner.drain();
    expect(classify).not.toHaveBeenCalled();
    expect(backend.publishLearning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(backend.prepareLearning).toHaveBeenCalledTimes(2);
    await learner.close();
  });
  it("retries malformed publication acknowledgements with the original submission", async () => {
    const { backend, classify, learner } = fixture();
    backend.publishLearning.mockResolvedValueOnce({ ok: true } as any);
    learner.wake(); await learner.drain();
    expect(classify).toHaveBeenCalledOnce();
    expect(backend.publishLearning).toHaveBeenCalledTimes(2);
    expect(backend.publishLearning.mock.calls[0][0]).toEqual(backend.publishLearning.mock.calls[1][0]);
    expect(backend.failLearning).not.toHaveBeenCalled();
    await learner.close();
  });
  it("retries a failed model without another user prompt and stops when idle", async () => {
    vi.useFakeTimers();
    const { backend, classify, learner } = fixture();
    backend.prepareLearning.mockReset().mockResolvedValue(batch());
    classify.mockRejectedValueOnce(new Error("outage"));
    learner.wake();
    await learner.drain();
    expect(backend.failLearning).toHaveBeenCalledWith("batch");
    await vi.advanceTimersByTimeAsync(5000);
    await learner.drain();
    expect(classify).toHaveBeenCalledTimes(2);
    expect(backend.publishLearning).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300000);
    expect(classify).toHaveBeenCalledTimes(2);
    await learner.close();
  });
  it("reuses the exact submission after an ambiguous publish", async () => {
    const { backend, classify, learner } = fixture();
    backend.publishLearning.mockRejectedValueOnce(new Error("lost response"));
    learner.wake();
    await learner.drain();
    expect(classify).toHaveBeenCalledOnce();
    expect(backend.publishLearning.mock.calls[0][0]).toEqual(
      backend.publishLearning.mock.calls[1][0],
    );
    await learner.close();
  });
  it("coalesces wakeups and drains only one in-flight model on close", async () => {
    const { backend, classify, learner } = fixture();
    let finish!: () => void;
    classify.mockImplementationOnce(async () => {
      await new Promise<void>((r) => {
        finish = r;
      });
      return [];
    });
    learner.wake();
    await Promise.resolve();
    learner.wake();
    learner.wake();
    let closed = false;
    const closing = learner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(classify).toHaveBeenCalledOnce();
    expect(backend.prepareLearning).toHaveBeenCalledOnce();
    learner.wake();
    expect(classify).toHaveBeenCalledOnce();
  });
  it("defers to the durable quota timer without idle polling", async () => {
    vi.useFakeTimers();
    const { backend, classify, learner } = fixture();
    backend.prepareLearning
      .mockReset()
      .mockResolvedValueOnce({ ...empty(), retryAfterMs: 60000 })
      .mockResolvedValue(empty());
    learner.wake();
    await learner.drain();
    await vi.advanceTimersByTimeAsync(59999);
    expect(backend.prepareLearning).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.prepareLearning).toHaveBeenCalledTimes(2);
    expect(classify).not.toHaveBeenCalled();
    await learner.close();
  });
  it.each([
    "计算 2 + 2，只输出结果",
    "Translate this sentence into English.",
    "谢谢",
  ])("skips trivial user/assistant exchanges: %s", async (text) => {
    const { backend, classify, learner } = fixture();
    const b = batch();
    b.inputs[0].text = text;
    b.inputs.push({
      ...b.inputs[0],
      id: "a",
      sourceEntryId: "a",
      role: "assistant",
      text: "Done",
    });
    backend.prepareLearning.mockReset().mockResolvedValue(b);
    learner.wake();
    await learner.drain();
    expect(classify).not.toHaveBeenCalled();
    expect(backend.publishLearning.mock.calls[0][0].decisions).toHaveLength(2);
    await learner.close();
  });
  it("passes roles and targets to the model with no executable tools", async () => {
    const completeSimple = vi
      .fn()
      .mockResolvedValue({
        stopReason: "stop",
        content: [{ type: "text", text: '{"decisions":[]}' }],
        usage: { input: 1, output: 1 },
      });
    const classifier = createMemoryClassifier(
      { completeSimple } as any,
      () => ({ id: "model" }) as any,
    );
    await classifier(batch(), new AbortController().signal);
    const [, context, options] = completeSimple.mock.calls[0];
    expect(context.tools).toBeUndefined();
    expect(options.maxTokens).toBe(8192);
    expect(JSON.parse(context.messages[0].content).inputs[0].role).toBe("user");
  });
});
