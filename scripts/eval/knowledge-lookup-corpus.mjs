#!/usr/bin/env node
// Offline retrieval comparison. Inputs and output can contain private corpus data.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createKnowledgeResolver } from "../../dist/knowledge/indexer.js";

const { values } = parseArgs({ options: { root: { type: "string" }, queries: { type: "string" } } });
if (!values.root || !values.queries) throw new Error("Usage: knowledge-lookup-corpus.mjs --root <wiki> --queries <questions.json>");
const root = path.resolve(values.root);
const questions = JSON.parse(fs.readFileSync(values.queries, "utf8"));
if (!Array.isArray(questions) || !questions.length) throw new Error("Expected a nonempty question array.");
const ids = new Set();
for (const q of questions) {
  if (typeof q.id !== "string" || !q.id || ids.has(q.id) || typeof q.query !== "string" || !q.query.trim() ||
      !Array.isArray(q.expectedFiles) || q.expectedFiles.some(f => typeof f !== "string" || !f || path.isAbsolute(f) || f.split(/[\\/]/).includes("..")) ||
      (q.alternates !== undefined && (!Array.isArray(q.alternates) || q.alternates.length > 3 || q.alternates.some(s => typeof s !== "string" || !s.trim())))) {
    throw new Error("Each question needs a unique id, query, relative expectedFiles, and at most three alternate queries.");
  }
  ids.add(q.id);
}

function fuse(lists) {
  const pages = new Map();
  for (const list of lists) list.forEach((page, i) => {
    const entry = pages.get(page.file) ?? { file: page.file, score: 0 };
    entry.score += 1 / (60 + i + 1);
    pages.set(page.file, entry);
  });
  return [...pages.values()].sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}

const resolver = createKnowledgeResolver(root);
const rows = [];
try {
  await resolver.sync();
  for (const q of questions) {
    const inputs = [...new Set([q.query, ...q.alternates ?? []])];
    const start = performance.now();
    const results = [];
    for (const query of inputs) results.push(await resolver.lookup({ query, readCount: 0, topK: 20 }));
    const arms = { labels: resolver.search(q.query, 6).pages, original: results[0].results, fused: fuse(results.map(r => r.results)) };
    const expected = [...new Set(q.expectedFiles.map(f => f.replaceAll("\\", "/")))];
    rows.push({
      id: q.id, expectedPages: expected.length, lookupCalls: inputs.length,
      lookupElapsedMs: performance.now() - start,
      candidateCutoff: results.some(r => r.hasMore),
      arms: Object.fromEntries(Object.entries(arms).map(([name, pages]) => {
        const files = pages.map(p => (path.isAbsolute(p.file) ? path.relative(root, p.file) : p.file).replaceAll("\\", "/"));
        return [name, { ranks: expected.map(file => files.indexOf(file) + 1), files: files.slice(0, 6) }];
      })),
    });
  }
} finally { resolver.close(); }

const positive = rows.filter(r => r.expectedPages > 0);
const expectedPages = positive.reduce((n, r) => n + r.expectedPages, 0);
const metrics = Object.fromEntries(["labels", "original", "fused"].map(arm => [arm, {
  expectedPages,
  pagesAt1: positive.flatMap(r => r.arms[arm].ranks).filter(n => n === 1).length,
  pagesAt6: positive.flatMap(r => r.arms[arm].ranks).filter(n => n > 0 && n <= 6).length,
  completeQuestionsAt6: positive.filter(r => r.arms[arm].ranks.every(n => n > 0 && n <= 6)).length,
  positiveQuestions: positive.length,
  negativeQueriesWithCandidates: rows.filter(r => r.expectedPages === 0 && r.arms[arm].files.length > 0).length,
}]));
console.log(JSON.stringify({
  scope: "Offline retrieval only. Supplied alternates are an intervention, not measured Agent query planning. Candidate presence for a negative question is not an incorrect answer. Each lookup returns at most 20 metadata candidates within its output budget. Keep corpus-derived output private.",
  metrics, rows,
}, null, 2));
