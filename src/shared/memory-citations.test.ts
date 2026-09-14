import { expect, it } from "vitest";
import {
  memoryCitationPaths,
  stripMemoryCitations,
} from "./memory-citations.js";
const path = `memory/${"a".repeat(64)}.md`;
it("accepts only a bounded final JSON block and hides streaming attribution", () => {
  const text = `Answer.\n<memory-citations>["${path}","${path}"]</memory-citations>`;
  expect(memoryCitationPaths(text)).toEqual([path]);
  expect(stripMemoryCitations(text).trim()).toBe("Answer.");
  expect(stripMemoryCitations('Answer.\n<memory-citations>["memory/').trim()).toBe(
    "Answer.",
  );
  expect(stripMemoryCitations("Answer.\n<memory-citati").trim()).toBe("Answer.");
  expect(memoryCitationPaths(`Source ${path}`)).toEqual([]);
  expect(
    memoryCitationPaths('<memory-citations>["/etc/passwd"]</memory-citations>'),
  ).toEqual([]);
  expect(memoryCitationPaths(text + "\nFurther claims")).toEqual([]);
});
