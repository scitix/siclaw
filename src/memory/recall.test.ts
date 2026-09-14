import { expect, it } from "vitest";
import fs from "node:fs";
import {
  rankMemories,
  anchors,
  indexedMemoryTerms,
  briefMatches,
  terms,
} from "./recall.js";
const fixture = JSON.parse(
  fs.readFileSync(new URL("./recall-fixtures.json", import.meta.url), "utf8"),
);
it("shares query ordering, entity boundaries and cross-language aliases with the remote fixtures", () => {
  for (const q of fixture.queries) {
    const candidates = fixture.records.filter((r: any) =>
      anchors(q.query).every((a) => indexedMemoryTerms(r).has(a)),
    );
    expect(
      rankMemories(candidates, q.query, true).map((v) => v.id),
      q.query,
    ).toEqual(q.ids);
  }
});
it("ignores sentence verbs in briefs but retains named project anchors", () => {
  const indexed = terms("Harbor report format");
  expect(
    briefMatches(
      "Prepare the Harbor report. Use our prior convention.",
      indexed,
    ),
  ).toBe(true);
  expect(
    briefMatches(
      "Prepare the Birch report. Use our prior convention.",
      indexed,
    ),
  ).toBe(false);
});

it("routes prompts with field labels, transport language hints and version changes", () => {
 const indexed = terms("LighthouseM1409 incident reports title prefix");
 expect(briefMatches("Prepare a LighthouseM1409 incident report. Impact: queue delayed. Action: consumer restarted. Return only the report.", indexed)).toBe(true);
 expect(briefMatches("[System: respond in Chinese]\n请按 LighthouseM1409 的约定写报告。", indexed)).toBe(true);
 expect(briefMatches("Harbor42 is now on v2; the previous v1 diagnosis may no longer apply.", terms("harbor42 staging v2 repair"))).toBe(true);
 expect(briefMatches("Harbor43 is now on v2; the previous v1 diagnosis may no longer apply.", terms("harbor42 staging v2 repair"))).toBe(false);
});
