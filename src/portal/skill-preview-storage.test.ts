import { expect, it } from "vitest";
import type { Db } from "../gateway/db.js";
import { preparePreviewMessage } from "./skill-preview-storage.js";

it.each([4, 16, 64])("bounds escaped writes for a %i MiB MySQL packet", async (packetMiB) => {
  const packet = packetMiB * 1024 * 1024;
  const db = { driver: "mysql", query: async () => [[{ packet }], undefined] } as unknown as Db;
  const message = { metadata: { skillPreview: { skill: { name: "large", specs: "\u0000".repeat(2_000_000) } }, llm_round: 3 }, content: "\"".repeat(3_000_000), tool_input: "{}" };
  await preparePreviewMessage(db, message);
  expect(message.metadata).toMatchObject({ skillPreview: { status: "omitted", reason: "size_limit" }, llm_round: 3 });
  expect(2 * (Buffer.byteLength(JSON.stringify(message.metadata)) + Buffer.byteLength(message.content)) + 65536).toBeLessThan(packet);
});
