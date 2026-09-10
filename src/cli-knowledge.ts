import path from "node:path";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { createKnowledgeResolver } from "./knowledge/indexer.js";

const HELP = `Usage: siclaw knowledge search <query> --root <mounted-wiki> [options]

Search mounted Markdown knowledge without a Portal connection or model provider.

  --top-k <n>       Candidate limit (default 6, maximum 20)
  --read-count <n>  Complete pages to include (default 2, maximum 5; 0 for metadata)
  --repo <id>       Restrict to a mounted library ID (repeatable)
  --labels         Use the existing labels-only baseline (metadata only)
  --json           Print structured results including original paths and versions
  --help           Show this help

Each invocation builds a disposable index. Agent sessions reuse their index until sync.
`;

export async function runKnowledgeCli(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: {
      root: { type: "string" }, "top-k": { type: "string" }, "read-count": { type: "string" },
      repo: { type: "string", multiple: true }, labels: { type: "boolean" },
      json: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) { console.log(HELP); return; }
  if (positionals.length !== 2 || positionals[0] !== "search" || !positionals[1].trim() || !values.root) throw new Error(HELP);
  const topK = Number(values["top-k"] ?? 6);
  const readCount = Number(values["read-count"] ?? 2);
  if (!Number.isInteger(topK) || topK < 1 || topK > 20 || !Number.isInteger(readCount) || readCount < 0 || readCount > 5) throw new Error("Invalid top-k (1–20) or read-count (0–5).");
  if (values.labels && (values.repo || values["read-count"])) throw new Error("--labels returns only baseline metadata and does not accept --repo or --read-count.");
  const root = path.resolve(values.root);
  if (!fs.statSync(root).isDirectory()) throw new Error("--root must be a mounted Wiki directory.");
  const resolver = createKnowledgeResolver(root);
  const start = performance.now();
  try {
    if (values.labels) {
      await resolver.sync();
      const result = { mode: "labels", ...resolver.search(positionals[1], topK), elapsedMs: performance.now() - start };
      console.log(JSON.stringify(result, null, values.json ? undefined : 2));
    } else {
      const result = await resolver.lookup({ query: positionals[1], topK, readCount, repoIds: values.repo });
      const output = { ...result, elapsedMs: performance.now() - start };
      console.log(values.json ? JSON.stringify(output) : [
        ...result.results.map((page) => `${page.rank}. ${page.title} [${page.library.id}${page.library.version ? ` @ ${page.library.version}` : ""}]\n${page.file}\n${page.content ?? `(${page.readStatus}: use Read to inspect this page)`}`),
        result.message,
      ].join("\n\n"));
    }
  } finally { resolver.close(); }
}
