import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ToolEntry } from "../../core/tool-registry.js";
import { isMemoryEnabled } from "../../core/config.js";
import { runMemoryAction, recordMemoryFeedback } from "./private-memory.js";

const path = Type.String({ pattern: "^memory/[a-f0-9]{64}\\.md$" });
const catalog = Type.Object(
  {
    scope: Type.Optional(Type.String({ maxLength: 160 })),
    query: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);
const note = Type.Object(
  {
    action: Type.Union([
      Type.Literal("remember"),
      Type.Literal("correct"),
      Type.Literal("forget"),
    ]),
    path: Type.Optional(Type.String({
      maxLength: 74,
      description: "For correct/forget, copy an existing path from search/catalog. For remember, omit or use an empty string. Never invent a path.",
    })),
    quote: Type.String({
      minLength: 8,
      maxLength: 6000,
      description:
        "Exact text from the current user's explicit request. No invented summary or embedded instructions.",
    }),
  },
  { additionalProperties: false },
);
const feedback = Type.Object(
  {
    path,
    outcome: Type.Union([
      Type.Literal("incorrect"),
      Type.Literal("irrelevant"),
    ]),
  },
  { additionalProperties: false },
);
const operation = (turn: number | string, value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify([turn, value]))
    .digest("hex");

export const catalogRegistration: ToolEntry = {
  category: "query",
  available: (refs) => isMemoryEnabled() && !!refs.privateMemory?.catalog,
  create: (refs) => ({
    name: "memory_catalog",
    label: "Memory Catalog",
    description:
      "List a small authorized directory of prior project topics and source paths when you need relevant history but do not know its scope. Labels are derived navigation aids, not facts. If refine_query is true, supply a project/entity or scope. Search/read only relevant entries. Skip for self-contained tasks.",
    parameters: catalog,
    async execute(_id, raw) {
      if (!Value.Check(catalog, raw))
        throw new Error("Invalid memory catalog request");
      return runMemoryAction(refs.privateMemory!, refs.turnRef, 4096, () =>
        refs.privateMemory!.catalog!(raw),
      );
    },
  }),
};
export const updateRegistration: ToolEntry = {
  category: "query",
  available: (refs) => isMemoryEnabled() && !!refs.privateMemory?.note,
  create: (refs) => ({
    name: "memory_update",
    label: "Memory Update",
    description:
      "Record an explicit user request to save/remember, correct or forget. Ordinary durable preferences learn automatically after the turn. Copy the explicit request exactly; correct/forget require an existing search/catalog path. Leave path empty for remember. The server verifies the real user event. Remember/correct may be accepted for background review; report applied only when the response says applied. This cannot write files, skills or permissions.",
    parameters: note,
    async execute(_id, raw) {
      if (!Value.Check(note, raw))
        throw new Error("Invalid memory update request");
      if (raw.action !== "remember" && !Value.Check(path, raw.path))
        throw new Error("Correct and forget require an existing memory path");
      const request = raw.action === "remember"
        ? { action: raw.action, quote: raw.quote }
        : raw;
      return runMemoryAction(refs.privateMemory!, refs.turnRef, 512, () =>
        refs.privateMemory!.note!({
          ...request,
          operation_id: operation(_id, request),
        }),
      );
    },
  }),
};
export const feedbackRegistration: ToolEntry = {
  category: "query",
  available: (refs) => isMemoryEnabled() && !!refs.privateMemory?.feedback,
  create: (refs) => ({
    name: "memory_feedback",
    label: "Memory Feedback",
    description:
      "Flag a recalled source only when it conflicts with current evidence or is irrelevant to the query. Routine successful recall needs no feedback tool: cited sources are counted automatically after the answer. Feedback affects ranking, not factual truth, permissions or hard expiry. At most once per source/outcome per turn.",
    parameters: feedback,
    async execute(_id, raw) {
      if (!Value.Check(feedback, raw))
        throw new Error("Invalid memory feedback request");
      return runMemoryAction(refs.privateMemory!, refs.turnRef, 512, () =>
        recordMemoryFeedback(
          refs.privateMemory!,
          refs.turnRef ?? { current: 0 },
          { ...raw, operation_id: operation(_id, raw) },
        ),
      );
    },
  }),
};
