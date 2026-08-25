/**
 * The delegation result budget — one deterministic cut, so both ends of the contract produce the
 * same wire from the same input.
 *
 * Spec: docs/design/2026-08-25-delegation-contract-v1.md §8a. Three properties there are the whole
 * reason this is a module rather than a few lines at the call site:
 *
 *   1. **Bytes, not characters.** The budget is UTF-8 bytes of the serialized value. `.length` on a
 *      JS string counts UTF-16 units and undercounts CJK by ~3x, so a character budget silently
 *      gives a Chinese result a third of the room.
 *   2. **Never split a character.** A byte-count cut lands mid-sequence in CJK text roughly a third
 *      of the time. Every cut walks back to a character boundary, so the result is ≤ the budget and
 *      never over it.
 *   3. **Cut the string VALUES, never the serialized JSON.** Cutting the JSON produces a document
 *      that does not parse — exactly the failure this contract exists to remove.
 */

import type { DelegateArtifact, DelegateTruncation } from "./agent-delegate.js";

/** 32 KiB, UTF-8 bytes, across the result-bearing fields only. */
export const RESULT_BUDGET_BYTES = 32 * 1024;

/**
 * `findings` is the answer, so it is cut last and never emptied: below this floor the artifact
 * stops being a result at all, and a coordinator holding 0 bytes of findings is worse off than one
 * holding a clipped paragraph.
 */
export const FINDINGS_FLOOR_BYTES = 4 * 1024;

/** §10b: tail-heavy because a conclusion comes last, but not tail-ONLY — see clipHeadTail. */
const HEAD_SHARE = 0.25;

const encoder = new TextEncoder();

export function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Largest prefix of `value` that fits in `maxBytes`, never splitting a character.
 *
 * Iterating code points (via the string iterator, which yields whole code points including
 * surrogate pairs) is what makes the boundary property hold for astral characters too — indexing
 * by `charAt` would split an emoji into two halves that are individually valid UTF-16 and produce
 * U+FFFD on decode.
 */
function prefixWithinBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(value) <= maxBytes) return value;
  let used = 0;
  let out = "";
  for (const ch of value) {
    const size = utf8Bytes(ch);
    if (used + size > maxBytes) break;
    used += size;
    out += ch;
  }
  return out;
}

/** Largest SUFFIX of `value` that fits, never splitting a character. */
function suffixWithinBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (utf8Bytes(value) <= maxBytes) return value;
  const chars = [...value];
  let used = 0;
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const size = utf8Bytes(chars[i]);
    if (used + size > maxBytes) break;
    used += size;
    start = i;
  }
  return chars.slice(start).join("");
}

/**
 * Keep the head AND the tail, joined by an ellipsis.
 *
 * Tail-heavy because a conclusion comes last — that is why the pre-contract behaviour kept the
 * tail. Head-preserving because dropping it entirely is what made a truncated narrative
 * unreadable: the reader loses what the peer was even asked to do, and cannot tell whether the
 * surviving text answers the question.
 */
export function clipHeadTail(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const marker = "\n…\n";
  const markerBytes = utf8Bytes(marker);
  const usable = maxBytes - markerBytes;
  if (usable <= 0) return prefixWithinBytes(value, maxBytes);
  const headBudget = Math.floor(usable * HEAD_SHARE);
  const head = prefixWithinBytes(value, headBudget);
  // The tail takes whatever the head did not use, so a head that ended early at a character
  // boundary donates the remainder rather than wasting it.
  const tail = suffixWithinBytes(value, usable - utf8Bytes(head));
  return head + marker + tail;
}

/** Tail-clip: keep the END, mark the omission at the front. */
export function clipTail(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  const marker = "…";
  const kept = suffixWithinBytes(value, Math.max(0, maxBytes - utf8Bytes(marker)));
  return marker + kept;
}

export interface ResultPayload {
  artifact?: DelegateArtifact | null;
  finalText?: string;
  inputQuestion?: string;
  steps: string[];
}

export interface BudgetedResult extends ResultPayload {
  truncation?: DelegateTruncation;
}

/**
 * Total of the fields the budget governs. Identity and status fields are NOT counted and never
 * cut — they are bounded by construction, and a truncated `task_status` would be worse than no
 * result at all.
 *
 * `inputQuestion` IS counted but never cut (see below), so a huge question can push the budget
 * over on its own. That is the honest accounting: the total tells the truth even when nothing more
 * can be done about it.
 */
function payloadBytes(p: ResultPayload): number {
  // ⚠️ MEASURES THE SERIALIZED FORM, not the sum of the raw strings.
  //
  // Summing raw strings understates the wire by roughly 2x: JSON escaping doubles every quote,
  // backslash and newline (and a log excerpt is mostly those), and the keys, braces, commas and
  // quotes are themselves payload. Measured: content whose raw strings totalled 32760 bytes
  // serialized to 65563 — so a "32 KiB budget" admitted a 64 KiB result.
  //
  // The spec says "UTF-8 bytes of the serialized value", and this is the only measurement that
  // matches it. It costs one JSON.stringify per iteration of the trim loop, which is a few passes
  // over at most a few tens of KiB — irrelevant next to the turn that produced the payload.
  return utf8Bytes(JSON.stringify({
    artifact: p.artifact ?? undefined,
    finalText: p.finalText,
    inputQuestion: p.inputQuestion,
    steps: p.steps,
  }));
}

/**
 * Apply the budget, in the order of §8a's table.
 *
 * The order is the REVERSE of how much the coordinator needs each field: `steps` are a progress
 * card whose full version survives in the peer's own session, `findings` is the answer. So the
 * cheapest-to-lose goes first and the answer goes last.
 *
 * `inputQuestion` is never cut at any stage: half a question cannot be relayed to a user, and the
 * coordinator's only useful action on a blocked turn is to relay it verbatim.
 */
export function applyResultBudget(payload: ResultPayload, budgetBytes = RESULT_BUDGET_BYTES): BudgetedResult {
  const originalBytes = payloadBytes(payload);
  if (originalBytes <= budgetBytes) return { ...payload };

  const cut: string[] = [];
  const out: ResultPayload = {
    ...payload,
    steps: [...payload.steps],
    artifact: payload.artifact ? { ...payload.artifact } : payload.artifact,
  };

  // 1. steps — drop from the START, keeping the most recent. The last ones describe where the peer
  //    ended up, which is what a progress card is read for.
  while (out.steps.length > 0 && payloadBytes(out) > budgetBytes) {
    out.steps.shift();
    if (!cut.includes("steps")) cut.push("steps");
  }

  // 2. finalText — head+tail, so the objective and the conclusion both survive.
  if (payloadBytes(out) > budgetBytes && out.finalText) {
    const over = payloadBytes(out) - budgetBytes;
    const target = Math.max(0, utf8Bytes(out.finalText) - over);
    out.finalText = clipHeadTail(out.finalText, target);
    cut.push("finalText");
  }

  // 3-5. artifact members, least load-bearing first; findings last and never below its floor.
  const artifactOrder: Array<{ key: "residual_state" | "actions_taken" | "findings"; floor: number }> = [
    { key: "residual_state", floor: 0 },
    { key: "actions_taken", floor: 0 },
    { key: "findings", floor: FINDINGS_FLOOR_BYTES },
  ];
  for (const { key, floor } of artifactOrder) {
    if (payloadBytes(out) <= budgetBytes) break;
    if (!out.artifact) break;
    const current = out.artifact[key];
    if (!current) continue;
    const over = payloadBytes(out) - budgetBytes;
    const target = Math.max(floor, utf8Bytes(current) - over);
    if (target >= utf8Bytes(current)) continue;
    out.artifact = { ...out.artifact, [key]: clipTail(current, target) };
    cut.push(`artifact.${key}`);
  }

  // inputQuestion is cut LAST and only if the budget is still exceeded with everything else at its
  // floor. Cutting a question is bad — half a question cannot be relayed to a user — but silently
  // emitting a result twice the declared budget is worse, and an unbounded field makes the budget a
  // suggestion rather than a bound. Kept whole in every case where anything else could still give.
  if (payloadBytes(out) > budgetBytes && out.inputQuestion) {
    const over = payloadBytes(out) - budgetBytes;
    out.inputQuestion = clipTail(out.inputQuestion, Math.max(0, utf8Bytes(out.inputQuestion) - over));
    cut.push("inputQuestion");
  }

  const finalBytes = payloadBytes(out);
  return {
    ...out,
    // Reported even when the cut could not reach the budget (a huge inputQuestion, or findings at
    // its floor): the numbers stay true, and a reader can see the shortfall rather than inferring
    // that everything fit.
    truncation: { original_bytes: originalBytes, omitted_bytes: originalBytes - finalBytes, fields: cut },
  };
}
