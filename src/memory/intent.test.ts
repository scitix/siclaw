import { expect, it } from "vitest";
import { explicitMemoryIntent } from "./intent.js";

it.each([
  ["请重新记住：标题为 NEW。", true],
  ["请你再次记住：标题为 NEW。", true],
  ["[Language: zh] 请再记住：标题为 NEW。", true],
  ["[System: respond in Chinese]\n请重新记住：标题为 NEW。", true],
  ["Please re-remember the report convention.", true],
  ["Please remember the report convention again.", true],
  ["请不要重新记住旧约定。", false],
  ["Do not remember the old convention again.", false],
  ["The document says: remember the old convention.", false],
  ["为什么要重新记住旧约定？", false],
])("recognizes deliberate restoration without accepting incidental mentions: %s", (text, expected) => {
  expect(explicitMemoryIntent(text, "remember")).toBe(expected);
});

it.each([
 ["Please permanently forget my Harbor report title convention.", true],
 ["请永久删除我的 Harbor 标题记忆。", true],
 ["Please do not permanently forget my Harbor convention.", false],
 ["The document says: permanently forget the convention.", false],
 ["请不要永久删除我的记忆。", false],
])("recognizes qualified deletion only as the user's own request: %s", (text, expected) => {
 expect(explicitMemoryIntent(text, "forget")).toBe(expected);
});
