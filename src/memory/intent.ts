/** Keep local note admission and tombstone revival aligned with the host's
 * anchored user-intent checks. A quoted, negated or incidental mention is not
 * an explicit request. The real user event is verified separately. */
export function explicitMemoryIntent(text: string, action: string): boolean {
  const value = text.replace(/^(?:\[System: respond in [A-Za-z ]+\]\r?\n|\[Language:[^\]\r\n]+\]\s*)/i, "").trim();
  if (action === "forget") {
    return /^(?:please\s+|请(?:你)?\s*)?(?:(?:permanently|completely)\s+|(?:永久|彻底)\s*)?(?:forget\b|stop remembering\b|remove\b.{0,80}\bmemor|忘记|删除.{0,40}记忆|不要再记)/i.test(value);
  }
  return /^(?:please\s+|请(?:你)?\s*)?(?:(?:re[- ]?)?remember\b|from now on\b|update\b.{0,80}\bmemor|correct\b|(?:重新|再次|再)?记住|以后|今后|更正|纠正)/i.test(value);
}
