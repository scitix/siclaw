import { describe, it, expect } from "vitest";
import {
  applyResultBudget,
  clipHeadTail,
  clipTail,
  utf8Bytes,
  FINDINGS_FLOOR_BYTES,
  RESULT_BUDGET_BYTES,
} from "./delegation-result-budget.js";

/**
 * The contract's §8a exists because "32 KiB across the result fields" has several readings. These
 * tests pin the ones that differ observably, so the other side can check its implementation against
 * the same assertions rather than against prose.
 */

const ASCII = "a";
const CJK = "汉"; // 3 UTF-8 bytes, 1 UTF-16 unit — the whole reason the unit matters
const EMOJI = "🙂"; // 4 UTF-8 bytes, 2 UTF-16 units (surrogate pair)

describe("the unit is UTF-8 bytes, not characters", () => {
  it("counts CJK at 3 bytes and an astral emoji at 4", () => {
    expect(utf8Bytes(ASCII)).toBe(1);
    expect(utf8Bytes(CJK)).toBe(3);
    expect(utf8Bytes(EMOJI)).toBe(4);
    // The mistake this guards: .length would say 1, 1, 2 — so a "character budget" hands a Chinese
    // result a third of the room and an emoji-heavy one a half.
    expect(CJK.length).toBe(1);
  });
});

describe("no cut splits a character", () => {
  it("keeps CJK whole rather than filling the budget exactly", () => {
    // 10 CJK = 30 bytes. A budget of 20 cannot hold 6 whole characters (18) plus part of a 7th.
    const clipped = clipTail(CJK.repeat(10), 20);
    expect(utf8Bytes(clipped)).toBeLessThanOrEqual(20);
    // Decodes cleanly — no replacement characters anywhere.
    expect(clipped).not.toContain("�");
  });

  it("keeps an astral emoji whole — the surrogate-pair case", () => {
    const clipped = clipTail(EMOJI.repeat(10), 15);
    expect(utf8Bytes(clipped)).toBeLessThanOrEqual(15);
    expect(clipped).not.toContain("�");
    // Every kept emoji is intact: no lone surrogate survived.
    expect([...clipped].every((ch) => ch === "…" || ch === EMOJI)).toBe(true);
  });
});

describe("clipHeadTail keeps BOTH ends", () => {
  it("preserves the opening as well as the conclusion", () => {
    const text = "OBJECTIVE-START" + ASCII.repeat(4000) + "CONCLUSION-END";
    const clipped = clipHeadTail(text, 400);
    expect(utf8Bytes(clipped)).toBeLessThanOrEqual(400);
    // Head-preserving is the point: dropping it entirely is what made a truncated narrative
    // unreadable — the reader loses what the peer was even asked to do.
    expect(clipped).toContain("OBJECTIVE-START");
    expect(clipped).toContain("CONCLUSION-END");
    expect(clipped).toContain("…");
  });

  it("is tail-heavy: the tail gets more room than the head", () => {
    const text = ASCII.repeat(10_000);
    const clipped = clipHeadTail(text, 1000);
    const [head, tail] = clipped.split("\n…\n");
    expect(tail.length).toBeGreaterThan(head.length * 2);
  });
});

describe("applyResultBudget — the order is the reverse of how much the coordinator needs a field", () => {
  const bigArtifact = (findingsBytes: number) => ({
    findings: ASCII.repeat(findingsBytes),
    actions_taken: ASCII.repeat(1024),
    residual_state: ASCII.repeat(1024),
    task_status: "complete" as const,
  });

  it("returns the payload untouched, with NO truncation field, when it fits", () => {
    const out = applyResultBudget({ artifact: bigArtifact(100), finalText: "short", steps: ["a", "b"] });
    expect(out.truncation).toBeUndefined();
    expect(out.artifact?.findings).toHaveLength(100);
    expect(out.steps).toEqual(["a", "b"]);
  });

  it("cuts steps FIRST, keeping the most recent, and stops as soon as it fits", () => {
    // 40 steps x 1 KiB = 40 KiB of steps alone; everything else is small.
    const steps = Array.from({ length: 40 }, (_, i) => `step-${i}-` + ASCII.repeat(1024));
    const out = applyResultBudget({ artifact: bigArtifact(1024), finalText: ASCII.repeat(1024), steps });

    expect(out.truncation?.fields).toEqual(["steps"]);
    // The answer and the narrative are untouched — the budget was reached before them.
    expect(out.artifact?.findings).toHaveLength(1024);
    expect(out.finalText).toHaveLength(1024);
    // The most RECENT steps survive: the last ones say where the peer ended up.
    expect(out.steps.at(-1)).toContain("step-39-");
    expect(out.steps.length).toBeLessThan(40);
  });

  it("never empties findings — it stops at the floor", () => {
    // findings alone dwarfs the budget, so every earlier stage runs out and it is cut last.
    const out = applyResultBudget({
      artifact: bigArtifact(RESULT_BUDGET_BYTES * 3),
      finalText: ASCII.repeat(4096),
      steps: [ASCII.repeat(4096)],
    });
    const kept = utf8Bytes(out.artifact?.findings ?? "");
    expect(kept).toBeGreaterThanOrEqual(FINDINGS_FLOOR_BYTES);
    expect(out.truncation?.fields).toContain("artifact.findings");
    // Order is observable in `fields`: cheapest-to-lose first, the answer last.
    expect(out.truncation?.fields.indexOf("steps")).toBeLessThan(
      out.truncation!.fields.indexOf("artifact.findings"),
    );
  });

  it("keeps inputQuestion whole whenever anything else can still give", () => {
    // Cutting a question is bad — half a question cannot be relayed to a user — so it goes last.
    const question = "WHICH-CLUSTER-" + ASCII.repeat(1024);
    const out = applyResultBudget({ inputQuestion: question, steps: Array.from({ length: 40 }, () => ASCII.repeat(2048)) });
    expect(out.inputQuestion).toBe(question);
    expect(out.truncation!.fields).toContain("steps");
    expect(out.truncation!.fields).not.toContain("inputQuestion");
  });

  it("cuts inputQuestion as a LAST resort rather than blowing the budget", () => {
    // It used to be exempt unconditionally, which made the budget a suggestion: a single huge
    // question emitted a result far past the declared bound with nothing able to bring it down.
    const question = "WHICH-CLUSTER-" + ASCII.repeat(RESULT_BUDGET_BYTES * 2);
    const out = applyResultBudget({ inputQuestion: question, steps: [] });
    expect(out.truncation!.fields).toContain("inputQuestion");
    expect(utf8Bytes(JSON.stringify({ inputQuestion: out.inputQuestion, steps: out.steps })))
      .toBeLessThanOrEqual(RESULT_BUDGET_BYTES + 64);
  });

  it("measures the SERIALIZED payload, not the sum of the raw strings", () => {
    // Summing raw strings understates the wire by roughly 2x — JSON escaping doubles every quote,
    // backslash and newline (and a log excerpt is mostly those), and keys/braces/commas are payload
    // too. Measured before the fix: raw strings totalling 32760 bytes serialized to 65563, so a
    // "32 KiB budget" admitted a 64 KiB result.
    const steps = Array.from({ length: 20 }, () => ASCII.repeat(2048));
    const out = applyResultBudget({ artifact: bigArtifact(512), steps });
    // Strictly greater than the raw sum, because the structure itself counts.
    expect(out.truncation!.original_bytes).toBeGreaterThan(20 * 2048 + 512 + 1024 + 1024);
    expect(out.truncation!.omitted_bytes).toBeGreaterThan(0);
    // And what is left actually fits, measured the same way.
    const kept = utf8Bytes(JSON.stringify({
      artifact: out.artifact, finalText: out.finalText, inputQuestion: out.inputQuestion, steps: out.steps,
    }));
    expect(kept).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
  });

  it("escaping counts: a payload of quotes and newlines is bounded on the WIRE", () => {
    // The case the raw-sum measurement got most wrong. Every character here doubles when escaped.
    const nasty = '"\n'.repeat(RESULT_BUDGET_BYTES / 2);
    const out = applyResultBudget({ finalText: nasty, steps: [] });
    const kept = utf8Bytes(JSON.stringify({ finalText: out.finalText, steps: out.steps }));
    expect(kept).toBeLessThanOrEqual(RESULT_BUDGET_BYTES);
  });

  it("matches §8a's worked example", () => {
    // steps 40 KiB, finalText 10 KiB, findings 3 KiB, other members 1 KiB each = 55 KiB.
    // The doc's promise: step 1 alone reaches the budget, so only `steps` is listed.
    const out = applyResultBudget({
      artifact: { findings: ASCII.repeat(3 * 1024), actions_taken: ASCII.repeat(1024), residual_state: ASCII.repeat(1024) },
      finalText: ASCII.repeat(10 * 1024),
      steps: Array.from({ length: 40 }, () => ASCII.repeat(1024)),
    });
    expect(out.truncation?.fields).toEqual(["steps"]);
    expect(out.finalText).toHaveLength(10 * 1024);
    expect(out.artifact?.findings).toHaveLength(3 * 1024);
  });
});
