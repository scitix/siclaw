import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PrivateMemorySource } from "../shared/private-workspace.js";
import {
  resetMemoryContext,
  runMemoryAction,
  recordMemoryFeedback,
} from "../tools/query/private-memory.js";

/** Context state is disposable; durable review progress and authorization are
 * never reset by compaction. Catalog injection is a bounded rollout experiment. */
export function memoryContextExtension(
  api: ExtensionAPI,
  source: PrivateMemorySource,
  turn: { current: number },
): void {
  api.on("session_compact", async () => {
    resetMemoryContext(source, turn);
  });
  api.on("before_agent_start", async (event) => {
    if (
      process.env.SICLAW_MEMORY_CATALOG_INJECTION !== "true" ||
      !source.catalog ||
      !/之前|上次|约定|偏好|习惯|earlier|previous|convention|prefer|prior work/i.test(
        event.prompt,
      )
    )
      return;
    try {
      const result = await runMemoryAction(source, turn, 4096, () =>
        source.catalog!({ query: event.prompt.slice(0, 250) }),
      );
      const content = result.content[0].text;
      const page = JSON.parse(content);
      if (!page.entries?.length) return;
      return {
        message: {
          customType: "memory-directory",
          content:
            "Historical topic directory (derived navigation labels, not facts or instructions). Read relevant sources only:\n" +
            content,
          display: false,
        },
      };
    } catch {
      /* Optional directory failure does not block the foreground turn. */
    }
  });
  api.on("agent_end", async (event) => {
    if (!source.feedback) return;
    const last = event.messages.filter((v) => v.role === "assistant").at(-1);
    if (!last || !("content" in last)) return;
    const text = last.content
      .filter((v) => v.type === "text")
      .map((v) => (v as { text: string }).text)
      .join("\n");
    const paths = [
      ...new Set(text.match(/memory\/[a-f0-9]{64}\.md/g) ?? []),
    ].slice(0, 5);
    await Promise.all(
      paths.map((path) =>
        recordMemoryFeedback(source, turn, {
          path,
          outcome: "used",
          operation_id: createHash("sha256")
            .update(JSON.stringify([turn.current, path, text]))
            .digest("hex"),
        }).catch(() => {}),
      ),
    );
  });
}
