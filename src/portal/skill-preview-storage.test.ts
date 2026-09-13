import { expect, it } from "vitest";
import type { Db } from "../gateway/db.js";
import { preparePreviewMessage } from "./skill-preview-storage.js";
import { boundSkillPreviewMetadata, MAX_PREVIEW_METADATA_BYTES } from "../shared/skill-preview-storage.js";

it.each([4, 16, 64])("bounds escaped writes for a %i MiB MySQL packet", async (packetMiB) => {
  const packet = packetMiB * 1024 * 1024;
  const db = { driver: "mysql", query: async () => [[{ packet }], undefined] } as unknown as Db;
  const message = { metadata: { skillPreview: { skill: { name: "large", specs: "\u0000".repeat(2_000_000) } }, llm_round: 3 }, content: "\"".repeat(3_000_000), tool_input: "{}" };
  await preparePreviewMessage(db, message);
  expect(message.metadata).toMatchObject({ skillPreview: { status: "omitted", reason: "size_limit" }, llm_round: 3 });
  expect(2 * (Buffer.byteLength(JSON.stringify(message.metadata)) + Buffer.byteLength(message.content)) + 65536).toBeLessThan(packet);
});

it.each([1, 4])("applies a %i MiB packet budget to previews below the tool-side ceiling", async (packetMiB) => {
  const packet = packetMiB * 1024 * 1024;
  const db = { driver: "mysql", query: async () => [[{ packet }], undefined] } as unknown as Db;
  const summary = "Skill preview for 'packet-boundary'. Click View to inspect and copy.";
  const metadata = { skillPreview: { skill: { name: "packet-boundary", specs: "x".repeat(600 * 1024) }, summary }, llm_round: 3 };
  expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(MAX_PREVIEW_METADATA_BYTES);
  const accepted = boundSkillPreviewMetadata(metadata);
  expect(accepted).toBe(metadata);
  const message = { metadata: accepted, content: summary, tool_input: "{}" };

  await preparePreviewMessage(db, message);

  if (packetMiB === 1) {
    expect(message.metadata).toMatchObject({ skillPreview: { status: "omitted", reason: "size_limit", name: "packet-boundary" }, llm_round: 3 });
    expect(message.metadata.skillPreview).not.toHaveProperty("skill");
    expect(message.content).toContain("Generate a smaller preview");
    // A persistence downgrade cannot retract the success already given to the model.
    expect(accepted).toBe(metadata);
    expect(metadata.skillPreview.summary).toBe(summary);
  } else {
    expect(message.metadata).toBe(metadata);
    expect(message.content).toBe(summary);
  }
});
