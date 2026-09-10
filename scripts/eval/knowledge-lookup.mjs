#!/usr/bin/env node
// Deterministic retrieval microbenchmark; no provider, credentials or private corpus.
// npm run build && node scripts/eval/knowledge-lookup.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createKnowledgeResolver } from "../../dist/knowledge/indexer.js";

const output = [];
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
for (const count of [1, 5, 10]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-lookup-eval-"));
  const resolver = createKnowledgeResolver(root);
  try {
    const repos = [];
    const queries = [];
    for (let lib = 0; lib < count; lib++) {
      const folder = `repos/library-${lib}`;
      fs.mkdirSync(path.join(root, folder), { recursive: true });
      repos.push({ id: `library-${lib}`, root: folder, name: `Library ${lib}`, version: 1 });
      const links = [];
      for (let page = 0; page < 100; page++) {
        const file = `${folder}/guide-${page}.md`;
        const body = [
          "---", `title: Guide ${page}`, "labels:", "  - facet: component", `    value: module-${lib}-${page}`,
          `    aliases: [alias-${lib}-${page}]`, "---", `# Guide ${page}`,
          `Applies to fleet${lib} service${page}.`,
          page === 0 ? `For error E_CONN_${lib}, rotate the expired certificate.` : "Use the standard health checks before changing configuration.",
          page === 1 ? "证书过期时先更新证书再重启服务。" : "Check the component log and the configured endpoint.",
          page === 2 ? `Worker${lib} v2.3 allows one retry; v2.4 uses automatic recovery.` : "Record the observed failure code and collect a diagnostic report.",
          "## Exception", "Do not restart during maintenance or when the health check is already passing.",
          "## Prerequisite", "Confirm the service owner and the maintenance window before acting.",
        ].join("\n");
        fs.writeFileSync(path.join(root, file), body);
        links.push(`[Guide ${page}](guide-${page}.md)`);
      }
      fs.writeFileSync(path.join(root, folder, "index.md"), links.join("\n"));
      queries.push(
        { kind: "label_alias", query: `alias-${lib}-4`, expected: `${folder}/guide-4.md` },
        { kind: "body_identifier", query: `E_CONN_${lib}`, expected: `${folder}/guide-0.md` },
        { kind: "cjk_body", query: `fleet${lib} 证书过期怎么处理`, expected: `${folder}/guide-1.md` },
        { kind: "version_body", query: `Worker${lib} v2.3 retry`, expected: `${folder}/guide-2.md` },
      );
    }
    fs.writeFileSync(path.join(root, "index.md"), repos.map((repo) => `[${repo.name}](${repo.root}/index.md)`).join("\n"));
    fs.writeFileSync(path.join(root, ".citation-manifest.json"), JSON.stringify({ version: 1, repos }));
    fs.writeFileSync(path.join(root, ".sync-manifest.json"), JSON.stringify({ repos }));
    const syncStart = performance.now();
    await resolver.sync();
    const labelSyncMs = performance.now() - syncStart;
    const coldStart = performance.now();
    await resolver.lookup({ query: queries[0].query });
    const contentColdMs = performance.now() - coldStart;
    const groups = {};
    const times = { labels: [], contentMetadata: [], contentRead: [] };
    let firstPageRead = 0;
    let maxOutputBytes = 0;
    for (const query of queries) {
      const group = groups[query.kind] ??= { queries: 0, labelsRecallAt6: 0, contentRecallAt6: 0, contentTop1: 0 };
      group.queries++;
      let start = performance.now();
      const baseline = resolver.search(query.query, 6);
      times.labels.push(performance.now() - start);
      if (baseline.pages.some((page) => page.file.endsWith(query.expected))) group.labelsRecallAt6++;
      start = performance.now();
      const metadata = await resolver.lookup({ query: query.query, readCount: 0 });
      times.contentMetadata.push(performance.now() - start);
      if (metadata.results.some((page) => page.file.endsWith(query.expected))) group.contentRecallAt6++;
      if (metadata.results[0]?.file.endsWith(query.expected)) group.contentTop1++;
      start = performance.now();
      const read = await resolver.lookup({ query: query.query });
      times.contentRead.push(performance.now() - start);
      if (read.results[0]?.readStatus === "full") firstPageRead++;
      maxOutputBytes = Math.max(maxOutputBytes, Buffer.byteLength(JSON.stringify(read)));
    }
    const absent = await resolver.lookup({ query: "UNSEEN_IDENTIFIER_999999" });
    output.push({
      libraries: count, pages: count * 100, queries: queries.length, labelSyncMs, contentColdMs,
      warmMs: Object.fromEntries(Object.entries(times).map(([key, values]) => [key, { p50: percentile(values, 0.5), p95: percentile(values, 0.95) }])),
      groups, firstPageRead, maxOutputBytes, absentQueryResults: absent.results.length,
    });
  } finally { resolver.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
console.log(JSON.stringify({
  environment: { node: process.version, platform: process.platform, architecture: process.arch },
  scope: "Synthetic retrieval only. Does not measure LLM tool choices, answer accuracy, citation quality or end-to-end latency. Corpus deliberately separates label aliases from body-only facts.",
  results: output,
}, null, 2));
