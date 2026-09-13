import type { MemoryLearningSource } from "../shared/private-workspace.js";

/** Deterministic admission runs before the authority reserves model work. */
export function trivialLearningInput(text: string): boolean {
  const value = text.replace(/^(?:\[System: respond in [A-Za-z ]+\]\r?\n|\[Language:[^\]\r\n]+\]\s*)/i, "").trim();
  if (/^(?:thanks[.!]?|thank you[.!]?|谢谢[。！]?|收到|好的)$/i.test(value))
    return true;
  if (
    /^(?:计算|calculate|compute|what is|what's)\s*[0-9\s×÷+*/().=乘以除于加减-]+(?:[，,。.]?\s*(?:只输出结果|only (?:the )?(?:answer|result))[。.]?)?$/i.test(
      value,
    )
  )
    return true;
  return (
    !/remember|记住/i.test(value) &&
    /^(?:translate |请翻译|翻译|忽略所有记忆)/i.test(value)
  );
}
export function skipLearningModel(inputs: MemoryLearningSource[]): boolean {
  const users = inputs.filter((v) => v.role === "user");
  return (
    users.length > 0 &&
    !inputs.some(
      (v) => v.role === "tool" || v.role === "toolResult" || v.target,
    ) &&
    users.every((v) => trivialLearningInput(v.text))
  );
}
/** Preserve recent human corrections and original goals before tool volume.
 * Restore chronology after selection; read-only context never advances review. */
export function selectLearningSources(
  all: MemoryLearningSource[],
  pending: MemoryLearningSource[],
  maxInputs: number,
) {
  const priority = (v: MemoryLearningSource) =>
    v.target ? 0 : v.role === "user" ? 1 : v.role === "assistant" ? 2 : 3;
  const ordered = (items: MemoryLearningSource[]) =>
    [...items].sort(
      (a, b) =>
        priority(a) - priority(b) ||
        (b.sourceOrder ?? 0) - (a.sourceOrder ?? 0),
    );
  const inputs: MemoryLearningSource[] = [],
    context: MemoryLearningSource[] = [];
  let bytes = 0;
  for (const item of ordered(pending)) {
    const size = Buffer.byteLength(item.text);
    if (inputs.length >= maxInputs || bytes + size > 24 * 1024) continue;
    inputs.push(item);
    bytes += size;
  }
  const selected = new Set(inputs.map((v) => v.id));
  const rest = ordered(all.filter((v) => !selected.has(v.id)));
  const goal = all.find((v) => v.role === "user" && !selected.has(v.id));
  if (goal) rest.splice(0, 0, ...rest.splice(rest.indexOf(goal), 1));
  for (const item of rest) {
    const size = Buffer.byteLength(item.text);
    if (!inputs.length || context.length >= 8 || bytes + size > 32 * 1024)
      continue;
    context.push(item);
    bytes += size;
  }
  const chronological = (a: MemoryLearningSource, b: MemoryLearningSource) =>
    (a.sourceOrder ?? 0) - (b.sourceOrder ?? 0);
  return {
    inputs: inputs.sort(chronological),
    context: context.sort(chronological),
    more: inputs.length < pending.length,
  };
}
export function explicitTaskConfirmation(quote: string): boolean {
  return (
    /(?:\b(?:i (?:have )?(?:verified|confirmed)|confirmed|verified)\b.{0,80}\b(?:fixed|resolved|working|healthy|passed|successful)|(?:确认|验证).{0,40}(?:修复成功|已恢复|恢复正常|通过|问题已解决))/i.test(
      quote,
    ) &&
    !/\?|？|\b(?:not|please|could|cannot|failed)\b|没有|未能|请|失败/i.test(
      quote,
    )
  );
}
