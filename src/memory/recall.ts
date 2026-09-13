const stopWords = new Set(
  "a an and are as at be been before by can could do does for from had has have how i in is it me my of on or our please remember should that the their them then there these they this to use was we were what when where which who why will with would you your now previous previously said tell about".split(
    " ",
  ),
);
export const terms = (text: string) => {
  const lower = text
    .toLowerCase()
    .replace(
      /请你记住|请记住|之前说过|之前|什么|怎样|怎么|多少|如何|以后|我希望|请问|一下|现在|应该|我们|我的/g,
      " ",
    );
  const result = new Set<string>();
  for (const token of lower
    .replace(/[\p{Script=Han}]/gu, " ")
    .match(/[\p{L}\p{N}_.-]+/gu) ?? []) {
    const word = token.replace(/^[-_.]+|[-_.]+$/g, "");
    if (word && !stopWords.has(word)) result.add(word);
    for (const part of word.split(/[-_.]/))
      if (part.length > 1 && !stopWords.has(part)) result.add(part);
  }
  for (const run of lower.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = Array.from(run);
    for (let i = 1; i < chars.length; i++) result.add(chars[i - 1] + chars[i]);
  }
  return result;
};
// Keep named projects and versioned identifiers as strict anchors, matching the
// remote backend. Generic shared words must not pull in a different project.
export const anchors = (query: string) =>
  (query.match(/[A-Za-z0-9_-]+/g) ?? [])
    .map((v) => v.replace(/^[-_]+|[-_]+$/g, ""))
    .filter(
      (v) =>
        v.length >= 2 &&
        !stopWords.has(v.toLowerCase()) &&
        ((/[A-Za-z]/.test(v) && /[0-9]/.test(v)) || /^[A-Z]/.test(v)),
    )
    .map((v) => v.toLowerCase());
export const matches = (query: string, indexed: Set<string>) =>
  anchors(query).every((v) => indexed.has(v)) &&
  [...terms(query)].some((v) => indexed.has(v));

/** Full user prompts contain capitalized sentence verbs, unlike search clauses.
 * For automatic routing only identifier-shaped anchors are mandatory; sentence
 * capitalization alone must not turn "Diagnose" into a required project name. */
export function briefMatches(query: string, indexed: Set<string>): boolean {
  query = query.replace(/^(?:\[System: respond in [A-Za-z ]+\]\r?\n|\[Language:[^\]\r\n]+\]\s*)/i, "");
  const sentenceWords = new Set(
    "diagnose investigate prepare submit continue summarize translate calculate only based give write create find review check explain inspect establish confirm fix repair ignore disregard otherwise current latest use impact action return".split(
      " ",
    ),
  );
  // A prompt can mention both current and old versions. Version metadata is
  // presented as applicability evidence; it is not a project identity anchor.
  const required = anchors(query).filter((v) => !sentenceWords.has(v) && !/^v[0-9]+(?:[_.-][0-9]+)*$/.test(v));
  return (
    required.every((v) => indexed.has(v)) &&
    [...terms(query)].some((v) => indexed.has(v))
  );
}

interface RecallRecord {
  id: string;
  scope: string;
  claim: string;
  summary: string;
  keywords: string;
  text: string;
  source: { createdAt: number };
  usage?: number;
  negative?: number;
}
/** Match the remote metadata index: literal source is retrieved after ranking.
 * Derived aliases can help lookup, but are never returned as factual evidence. */
export function indexedMemoryTerms(v: RecallRecord): Set<string> {
  return new Set(
    [...terms(`${v.scope} ${v.claim} ${v.keywords} ${v.summary}`)].slice(
      0,
      128,
    ),
  );
}

export function rankMemories<T extends RecallRecord>(
  candidates: T[],
  query: string,
  strict: boolean,
): T[] {
  const words = [...terms(query)].slice(0, 128);
  if (!words.length && query) return [];
  const rows = candidates
    .filter((v) => !query || words.some((w) => indexedMemoryTerms(v).has(w)))
    .sort(
      (a, b) =>
        b.source.createdAt - a.source.createdAt || a.id.localeCompare(b.id),
    );
  const sets = rows.map(indexedMemoryTerms),
    counts = new Map<string, number>();
  for (const set of sets)
    for (const word of set) counts.set(word, (counts.get(word) ?? 0) + 1);
  let best = 0;
  const scored: { v: T; score: number }[] = [];
  rows.forEach((v, i) => {
    const set = sets[i];
    if (
      strict &&
      (anchors(query).some((a) => !set.has(a)) ||
        words.some(
          (w) =>
            !set.has(w) &&
            w.includes("-") &&
            w.split("-").some((p) => p.length === 1),
        ))
    )
      return;
    let score = 0;
    for (const word of words)
      if (set.has(word))
        score += 1 + Math.log(1 + rows.length / ((counts.get(word) ?? 0) + 1));
    best = Math.max(best, score);
    score +=
      0.04 * Math.log1p(Math.min(v.usage ?? 0, 20)) -
      0.02 * Math.min(v.negative ?? 0, 5);
    scored.push({ v, score });
  });
  const seen = new Set<string>();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter(({ v, score }) => {
      if (strict && query && score < best * 0.72) return false;
      const key = JSON.stringify([
        v.scope,
        v.claim,
        v.text.toLowerCase().trim().replace(/\s+/g, " "),
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((v) => v.v);
}
