import fs from "node:fs";
import { explicitMemoryIntent } from "./intent.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  PrivateMemorySource,
  MemoryLearningBackend,
  MemoryLearningBatch,
  MemoryLearningSubmission,
  MemoryLearningSource,
  MemorySearchRequest,
  MemorySearchPage,
  MemoryReadRequest,
  MemoryReadPage,
  MemoryCatalogRequest,
  MemoryCatalogPage,
  MemoryNoteRequest,
  MemoryFeedbackRequest,
} from "../shared/private-workspace.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const lifetime = 90 * 86400_000;
const bytes = (text: string) => Buffer.byteLength(text);
const stopWords = new Set("a an and are as at be been before by can could do does for from had has have how i in is it me my of on or our please remember should that the their them then there these they this to use was we were what when where which who why will with would you your now previous previously said tell about".split(" "));
const terms = (text: string) => {
  const lower = text.toLowerCase().replace(/请你记住|请记住|之前说过|之前|什么|怎样|怎么|多少|如何|以后|我希望|请问|一下|现在|应该|我们|我的/g, " ");
  const result = new Set<string>();
  for (const token of lower.replace(/[\p{Script=Han}]/gu, " ").match(/[\p{L}\p{N}_.-]+/gu) ?? []) {
    const word = token.replace(/^[-_.]+|[-_.]+$/g, "");
    if (word && !stopWords.has(word)) result.add(word);
    for (const part of word.split(/[-_.]/)) if (part.length > 1 && !stopWords.has(part)) result.add(part);
  }
  for (const run of lower.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = Array.from(run);
    for (let i = 1; i < chars.length; i++) result.add(chars[i - 1] + chars[i]);
  }
  return result;
};
// Keep named projects and versioned identifiers as strict anchors, matching the
// remote backend. Generic shared words must not pull in a different project.
const anchors = (query: string) => (query.match(/[A-Za-z0-9_-]+/g) ?? [])
  .map((v) => v.replace(/^[-_]+|[-_]+$/g, ""))
  .filter((v) => v.length >= 2 && !stopWords.has(v.toLowerCase()) &&
    (/[A-Za-z]/.test(v) && /[0-9]/.test(v) || /^[A-Z]/.test(v)))
  .map((v) => v.toLowerCase());
const matches = (query: string, indexed: Set<string>) =>
  anchors(query).every((v) => indexed.has(v)) && [...terms(query)].some((v) => indexed.has(v));
interface StoredMemory {
  id: string;
  text: string;
  scope: string;
  claim: string;
  summary: string;
  keywords: string;
  kind: string;
  source: MemoryLearningSource;
  superseded: string;
  usage?: number;
  negative?: number;
}

/** A per-user local backend for the same protocol as remote memory. SQLite is
 * only transactional storage here: no FTS, vector extension, embedding client,
 * filesystem watcher, or implicit Markdown authority. */
export class LocalMemoryStore
  implements PrivateMemorySource, MemoryLearningBackend
{
  private db: DatabaseSync;
  private readonly holder = randomUUID();
  private closed = false;
  private session = "";
  private manager?: SessionManager;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink())
      throw new Error("Unsafe local memory directory");
    this.directory = fs.realpathSync(directory);
    const file = path.join(directory, "memory-v2.db");
    if (
      fs.existsSync(file) &&
      (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).nlink !== 1)
    )
      throw new Error("Unsafe local memory database");
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, cleared_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO state VALUES (1,0,0);
      CREATE TABLE IF NOT EXISTS sources (session TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (generation INTEGER, id TEXT, expires_at INTEGER, PRIMARY KEY(generation,id));
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (session TEXT PRIMARY KEY, token TEXT, generation INTEGER, lease_until INTEGER, body TEXT, digest TEXT, result TEXT, holder TEXT, retry_at INTEGER, attempts INTEGER);
      CREATE TABLE IF NOT EXISTS receipts (session TEXT, token TEXT, generation INTEGER, digest TEXT, result TEXT, created_at INTEGER, PRIMARY KEY(session,token));
      CREATE TABLE IF NOT EXISTS notes (session TEXT, operation TEXT, generation INTEGER, digest TEXT, body TEXT, result TEXT, created_at INTEGER, PRIMARY KEY(session,operation));
      CREATE TABLE IF NOT EXISTS feedback (session TEXT, operation TEXT, generation INTEGER, body TEXT, created_at INTEGER, PRIMARY KEY(session,operation));
      CREATE TABLE IF NOT EXISTS budget (day INTEGER PRIMARY KEY, batches INTEGER);
      CREATE TABLE IF NOT EXISTS topics (generation INTEGER, topic TEXT, source_at INTEGER, source_order INTEGER, id TEXT, PRIMARY KEY(generation,topic));`);
  }
  private state(): { generation: number; cleared_at: number } {
    return this.db
      .prepare("SELECT generation,cleared_at FROM state WHERE id=1")
      .get() as { generation: number; cleared_at: number };
  }
  capture(sessionId: string, manager: SessionManager): void {
    this.session = sessionId;
    this.manager = manager;
    const source: MemoryLearningSource[] = [];
    for (const [order, entry] of manager.getBranch().entries()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (!["user", "assistant", "toolResult"].includes(message.role)) continue;
      if(message.role==="toolResult"&&message.toolName.startsWith("memory_"))continue;
      if (!("content" in message)) continue;
      const value = message.content;
      const text =
        typeof value === "string"
          ? value
          : value
              .filter((v) => v.type === "text")
              .map((v) => (v as { text: string }).text)
              .join("\n");
      if (
        !text.trim() ||
        /private key|authorization:|password|api_key|accesskeysecret/i.test(
          text,
        )
      )
        continue;
      const at = Date.parse(entry.timestamp);
      if (
        !Number.isFinite(at) ||
        at > Date.now() + 300_000 ||
        at + lifetime <= Date.now()
      )
        continue;
      let offset = 0;
      for (const chunk of this.chunks(text, 6000)) {
        const entryId = entry.id + (offset ? `#${offset}` : "");
        offset += bytes(chunk);
        source.push({
          id: hash(sessionId + "\0" + entryId),
          sourceEntryId: entryId,
          sourceSessionId: sessionId,
          text: chunk,
          role: message.role,
          createdAt: at,
          expiresAt: at + lifetime,
          sourceOrder: order * 10000 + Math.floor(offset / 6000),
          ...(message.role === "toolResult"
            ? { tool: message.toolName, isError: message.isError }
            : {}),
        });
      }
    }
    this.db
      .prepare(
        "INSERT INTO sources VALUES (?,?) ON CONFLICT(session) DO UPDATE SET body=excluded.body",
      )
      .run(sessionId, JSON.stringify(source));
  }
  private chunks(text: string, size: number): string[] {
    const result: string[] = [];
    let part = "",
      n = 0;
    for (const ch of text) {
      const b = bytes(ch);
      if (n + b > size) {
        result.push(part);
        part = "";
        n = 0;
      }
      part += ch;
      n += b;
    }
    if (part) result.push(part);
    return result;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async prepareLearning(): Promise<MemoryLearningBatch> {
    return this.transaction(() => this.prepare());
  }
  private prepare(): MemoryLearningBatch {
    const state = this.state();
    const cutoff = Date.now() - lifetime;
    this.db
      .prepare("DELETE FROM memories WHERE generation<>? OR expires_at<=?")
      .run(state.generation, Date.now());
    this.db
      .prepare("DELETE FROM reviews WHERE generation<>? OR expires_at<=?")
      .run(state.generation, Date.now());
    for (const table of ["notes", "feedback", "receipts"])
      this.db
        .prepare(`DELETE FROM ${table} WHERE generation<>? OR created_at<=?`)
        .run(state.generation, cutoff);
    this.db
      .prepare("DELETE FROM budget WHERE day<?")
      .run(Math.floor(Date.now() / 86400_000) - 2);
    this.db
      .prepare(
        "DELETE FROM topics WHERE generation<>? OR (source_at<=? AND id NOT LIKE 'forgotten:%')",
      )
      .run(state.generation, cutoff);
    const empty: MemoryLearningBatch = {
      token: "",
      generation: state.generation,
      revision: 0,
      inputs: [],
      hints: [],
      more: false,
    };
    if (!this.session) return empty;
    const old = this.db
      .prepare("SELECT * FROM jobs WHERE session=?")
      .get(this.session) as
      | {
          generation: number;
          lease_until: number;
          body: string;
          digest: string;
          holder: string;
          retry_at: number;
          attempts: number;
        }
      | undefined;
    if (
      old &&
      old.generation === state.generation &&
      old.lease_until > Date.now() &&
      !old.digest
    ) {
      if (old.holder === this.holder) return JSON.parse(old.body);
      return { ...empty, retryAfterMs: old.lease_until - Date.now() };
    }
    if (old && old.generation === state.generation && old.retry_at > Date.now())
      return { ...empty, retryAfterMs: old.retry_at - Date.now() };
    const day = Math.floor(Date.now() / 86400_000),
      budget = this.db
        .prepare("SELECT batches FROM budget WHERE day=?")
        .get(day) as { batches: number } | undefined;
    if ((budget?.batches ?? 0) >= 64)
      return { ...empty, retryAfterMs: (day + 1) * 86400_000 - Date.now() };
    const row = this.db
      .prepare("SELECT body FROM sources WHERE session=?")
      .get(this.session) as { body: string } | undefined;
    const source: MemoryLearningSource[] = row ? JSON.parse(row.body) : [];
    const notes = this.db
      .prepare(
        "SELECT body FROM notes WHERE session=? AND generation=? AND body<>'' ORDER BY created_at",
      )
      .all(this.session, state.generation) as { body: string }[];
    source.push(
      ...notes.map((v) => JSON.parse(v.body) as MemoryLearningSource),
    );
    let used = 0;
    const maxInputs = Math.max(
      1,
      24 >> Math.min(Math.floor((old?.attempts ?? 0) / 2), 4),
    );
    for (const item of [...source].reverse()) {
      if (item.target && !this.active().some((v) => v.id === item.target!.id)) {
        this.db
          .prepare("INSERT OR IGNORE INTO reviews VALUES (?,?,?)")
          .run(state.generation, item.id, item.expiresAt);
        continue;
      }
      if (
        item.createdAt <= state.cleared_at ||
        item.expiresAt <= Date.now() ||
        this.db
          .prepare("SELECT id FROM reviews WHERE generation=? AND id=?")
          .get(state.generation, item.id)
      )
        continue;
      if (
        empty.inputs.length >= maxInputs ||
        used + bytes(item.text) > 24 * 1024
      ) {
        empty.more = true;
        continue;
      }
      empty.inputs.push(item);
      used += bytes(item.text);
    }
    empty.inputs.reverse();
    const ids = new Set(empty.inputs.map((v) => v.id));
    empty.context = [];
    for (const item of [...source].reverse()) {
      if (
        ids.has(item.id) ||
        !empty.inputs.length ||
        (item.sourceOrder ?? 0) >= (empty.inputs[0].sourceOrder ?? 0) ||
        item.expiresAt <= Date.now() ||
        item.createdAt <= state.cleared_at
      )
        continue;
      if (empty.context.length >= 8 || used + bytes(item.text) > 32 * 1024)
        continue;
      empty.context.push(item);
      used += bytes(item.text);
    }
    empty.context.reverse();
    if (!empty.inputs.length) return empty;
    empty.token = randomUUID();
    empty.hints = this.active()
      .slice(0, 16)
      .map((v) => ({
        id: v.id,
        scope: v.scope,
        claim: v.claim,
        summary: v.summary,
      }));
    for (const src of empty.inputs)
      if (src.target)
        empty.hints = [
          src.target,
          ...empty.hints.filter((v) => v.id !== src.target!.id),
        ].slice(0, 16);
    this.db
      .prepare(
        "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session) DO UPDATE SET token=excluded.token,generation=excluded.generation,lease_until=excluded.lease_until,body=excluded.body,digest='',result='',holder=excluded.holder,retry_at=0,attempts=excluded.attempts",
      )
      .run(
        this.session,
        empty.token,
        state.generation,
        Date.now() + 120_000,
        JSON.stringify(empty),
        "",
        "",
        this.holder,
        0,
        Math.min((old?.attempts ?? 0) + 1, 16),
      );
    this.db
      .prepare(
        "INSERT INTO budget VALUES (?,1) ON CONFLICT(day) DO UPDATE SET batches=batches+1",
      )
      .run(day);
    return empty;
  }
  async publishLearning(
    input: MemoryLearningSubmission,
  ): Promise<{ count: number; more: boolean }> {
    const digest = hash(JSON.stringify(input));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.db
        .prepare("SELECT * FROM receipts WHERE session=? AND token=?")
        .get(this.session, input.token) as
        | { generation: number; digest: string; result: string }
        | undefined;
      if (receipt) {
        if (
          receipt.generation !== this.state().generation ||
          receipt.digest !== digest
        )
          throw new Error("Memory operation changed");
        this.db.exec("COMMIT");
        return JSON.parse(receipt.result);
      }
      const row = this.db
        .prepare("SELECT * FROM jobs WHERE session=? AND token=?")
        .get(this.session, input.token) as
        | {
            generation: number;
            lease_until: number;
            body: string;
            digest: string;
            result: string;
            holder: string;
          }
        | undefined;
      if (
        !row ||
        row.holder !== this.holder ||
        row.generation !== this.state().generation
      )
        throw new Error("Memory learning generation changed");
      if (row.digest) {
        if (row.digest !== digest) throw new Error("Memory operation changed");
        this.db.exec("COMMIT");
        return JSON.parse(row.result);
      }
      if (row.lease_until <= Date.now())
        throw new Error("Memory learning lease expired");
      const batch: MemoryLearningBatch = JSON.parse(row.body),
        covered = new Set<string>(),
        seen = new Set<string>();
      const sources = new Map(batch.inputs.map((v) => [v.sourceEntryId, v])),
        hints = new Map(batch.hints.map((v) => [v.id, v]));
      const activeIds = new Set(this.active().map((v) => v.id));
      if (input.decisions.length > 64)
        throw new Error("Too many memory decisions");
      let count = 0;
      const claimSpans = new Map<string, { start: number; end: number }[]>();
      for (const d of input.decisions) {
        const source = sources.get(d.entryId);
        if (!source) throw new Error("Unknown memory source");
        covered.add(d.entryId);
        if (d.kind === "ignore") continue;
        if (
          ![
            "preference",
            "constraint",
            "correction",
            "experience",
            "task",
            "forget",
          ].includes(d.kind) ||
          !d.quote ||
          bytes(d.quote) < 8 ||
          bytes(d.quote) > 6000 ||
          !source.text.includes(d.quote) ||
          !d.scope ||
          bytes(d.scope) > 160 ||
          !d.claim ||
          bytes(d.claim) > 160 ||
          bytes(d.summary ?? "") > 512 ||
          bytes(d.keywords ?? "") > 512
        )
          throw new Error("Unsupported memory claim");
        if (source.expiresAt <= Date.now() || (d.replaces?.length ?? 0) > 16)
          throw new Error("Expired or invalid memory claim");
        if (
          source.target &&
          (source.target.scope !== d.scope ||
            source.target.claim !== d.claim ||
            !d.replaces?.includes(source.target.id))
        )
          throw new Error("Correction target changed");
        if (!["experience", "task"].includes(d.kind) && source.role !== "user")
          throw new Error("Memory requires user source");
        if (
          d.kind === "forget" &&
          !explicitMemoryIntent(source.text, "forget")
        )
          throw new Error("Explicit forget request required");
        for (const id of d.replaces ?? []) {
          const h = hints.get(id);
          if (
            !h ||
            h.scope !== d.scope ||
            h.claim !== d.claim ||
            !activeIds.has(id)
          )
            throw new Error("Memory replacement scope changed");
        }
        const id = hash(source.id + "\0" + d.scope + "\0" + d.claim);
        if (seen.has(id)) throw new Error("Duplicate memory claim");
        seen.add(id);
        if (!["experience", "task"].includes(d.kind)) {
          const start = source.text.indexOf(d.quote), end = start + d.quote.length;
          const spans = claimSpans.get(d.entryId) ?? [];
          if (spans.some(span => start < span.end && span.start < end))
            throw new Error("Independent memory claims require disjoint source quotes");
          spans.push({ start, end });
          claimSpans.set(d.entryId, spans);
        }
        let text = d.quote;
        if (["experience", "task"].includes(d.kind)) {
          if (
            !d.status ||
            ![
              "observed",
              "failed",
              "proposed",
              "uncertain",
              "user-confirmed",
            ].includes(d.status) ||
            !d.evidence?.length ||
            d.evidence.length > 6
          )
            throw new Error("Task evidence required");
          let tool = false,
            user = false;
          for (const e of d.evidence) {
            const src =
              sources.get(e.entryId) ??
              batch.context?.find((v) => v.sourceEntryId === e.entryId);
            if (
              !src ||
              bytes(e.quote) < 8 ||
              bytes(e.quote) > 3000 ||
              !src.text.includes(e.quote)
            )
              throw new Error("Invalid task evidence");
            tool ||= src.role === "toolResult";
            user ||= src.role === "user";
            text += `\n\n[${src.role}; ${e.entryId}]\n${e.quote}`;
          }
          if (
            (d.kind === "experience" && !tool) ||
            (d.status === "user-confirmed" && !user)
          )
            throw new Error("Unsupported task status");
          text = `Historical task status: ${d.status} (requires current verification)\n\n${text}`;
        }
        const topic = hash(d.scope + "\0" + d.claim),
          prior = this.db
            .prepare(
              "SELECT source_at,source_order,id FROM topics WHERE generation=? AND topic=?",
            )
            .get(row.generation, topic) as
            | { source_at: number; source_order: number; id: string }
            | undefined;
        const memory: StoredMemory = {
          id,
          text,
          scope: d.scope,
          claim: d.claim,
          kind: d.kind,
          summary: d.summary ?? d.quote.slice(0, 100),
          keywords: d.keywords ?? "",
          source,
          superseded: d.kind === "forget" ? "forgotten" : "",
        };
        if (
          prior &&
          ((prior.id.startsWith("forgotten:") &&
            !explicitMemoryIntent(source.text, "remember")) ||
            prior.source_at > source.createdAt ||
            (prior.source_at === source.createdAt &&
              prior.source_order >= (source.sourceOrder ?? 0)))
        )
          memory.superseded = prior.id;
        else {
          for (const old of this.active())
            if (old.scope === d.scope && old.claim === d.claim) {
              old.superseded = id;
              this.db
                .prepare("UPDATE memories SET body=? WHERE id=?")
                .run(JSON.stringify(old), old.id);
            }
          this.db
            .prepare(
              "INSERT INTO topics VALUES (?,?,?,?,?) ON CONFLICT(generation,topic) DO UPDATE SET source_at=excluded.source_at,source_order=excluded.source_order,id=excluded.id",
            )
            .run(
              row.generation,
              topic,
              source.createdAt,
              source.sourceOrder ?? 0,
              (d.kind === "forget" ? "forgotten:" : "") + id,
            );
        }
        count += Number(
          this.db
            .prepare("INSERT OR IGNORE INTO memories VALUES (?,?,?,?)")
            .run(id, row.generation, source.expiresAt, JSON.stringify(memory))
            .changes,
        );
      }
      if (batch.inputs.some((v) => !covered.has(v.sourceEntryId)))
        throw new Error("Missing source decisions");
      for (const source of batch.inputs)
        this.db
          .prepare("INSERT OR IGNORE INTO reviews VALUES (?,?,?)")
          .run(row.generation, source.id, source.expiresAt);
      const result = { count, more: batch.more };
      this.db
        .prepare("INSERT INTO receipts VALUES (?,?,?,?,?,?)")
        .run(
          this.session,
          input.token,
          row.generation,
          digest,
          JSON.stringify(result),
          Date.now(),
        );
      this.db
        .prepare(
          "UPDATE jobs SET digest=?,result=?,lease_until=0 WHERE session=? AND token=?",
        )
        .run(digest, JSON.stringify(result), this.session, input.token);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async failLearning(token: string): Promise<void> {
    this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT attempts FROM jobs WHERE session=? AND token=? AND holder=? AND digest='' AND generation=?",
        )
        .get(this.session, token, this.holder, this.state().generation) as
        | { attempts: number }
        | undefined;
      if (row)
        this.db
          .prepare(
            "UPDATE jobs SET lease_until=0,retry_at=? WHERE session=? AND token=?",
          )
          .run(
            Date.now() +
              (row.attempts >= 8
                ? 86400_000
                : 5000 * 2 ** Math.min(row.attempts - 1, 6)),
            this.session,
            token,
          );
    });
  }
  private active(): StoredMemory[] {
    return (
      this.db
        .prepare(
          "SELECT body FROM memories WHERE generation=? AND expires_at>? ORDER BY expires_at DESC,id",
        )
        .all(this.state().generation, Date.now()) as { body: string }[]
    )
      .map((v) => JSON.parse(v.body) as StoredMemory)
      .filter((v) => !v.superseded);
  }
  async search(incoming: MemorySearchRequest): Promise<MemorySearchPage> {
    const input = {
      ...incoming,
      match_mode: incoming.match_mode ?? "all",
      max_results: incoming.max_results ?? 5,
    };
    if (
      !["any", "all"].includes(input.match_mode) ||
      !Number.isInteger(input.max_results) ||
      input.max_results < 1 ||
      input.max_results > 5 ||
      bytes(input.scope ?? "") > 160 ||
      (input.cursor?.length ?? 0) > 512 ||
      !Number.isInteger(input.context_lines ?? 0) ||
      (input.context_lines ?? 0) < 0 ||
      (input.context_lines ?? 0) > 5
    )
      throw new Error("Invalid memory query");
    if (
      !input.queries.length ||
      input.queries.length > 4 ||
      input.queries.some((v) => !v.trim()) ||
      bytes(input.queries.join("")) > 1000
    )
      throw new Error("Invalid memory query");
    const ranked = this.active()
      .filter((v) => !input.scope || v.scope === input.scope)
      .map((v) => {
        const indexed = terms(
          `${v.scope} ${v.claim} ${v.summary} ${v.keywords} ${v.text}`,
        );
        const matched = input.queries.filter((q) => matches(q, indexed));
        return {
          v,
          matched,
          score: matched.length,
          usage:
            Math.min(v.usage ?? 0, 10) * 0.01 -
            Math.min(v.negative ?? 0, 3) * 0.05,
        };
      })
      .filter((v) =>
        input.match_mode === "any"
          ? v.score > 0
          : v.score === input.queries.length,
      )
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.usage - a.usage ||
          b.v.source.createdAt - a.v.source.createdAt ||
          a.v.id.localeCompare(b.v.id),
      );
    const { cursor: _, ...query } = input;
    const fingerprint = hash(
      JSON.stringify({
        query,
        generation: this.state().generation,
        ids: ranked.map((v) => v.v.id),
      }),
    );
    let offset = 0;
    if (input.cursor) {
      const c = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      if (
        c.f !== fingerprint ||
        !Number.isSafeInteger(c.o) ||
        c.o < 0 ||
        c.o >= ranked.length
      )
        throw new Error("Memory cursor changed");
      offset = c.o;
    }
    const result: MemorySearchPage = {
      matches: [],
      enabled: true,
      truncated: false,
    };
    while (
      offset < ranked.length &&
      result.matches.length < input.max_results
    ) {
      const { v, matched } = ranked[offset];
      const lines = v.text.split("\n"),
        wanted = terms(input.queries.join(" "));
      let best = 0,
        score = 0;
      lines.forEach((line, i) => {
        const n = [...terms(line)].filter((t) => wanted.has(t)).length;
        if (n > score) {
          best = i;
          score = n;
        }
      });
      const start = Math.max(0, best - (input.context_lines ?? 0)),
        end = Math.min(lines.length, best + (input.context_lines ?? 0) + 1);
      const content =
        this.chunks(lines.slice(start, end).join("\n"), 512)[0] ?? "";
      const match = {
        path: `memory/${v.id}.md`,
        kind: v.kind,
        scope: v.scope,
        claim: v.claim,
        content,
        content_start_line_number: start + 1,
        truncated:
          start > 0 || end < lines.length || content.length < v.text.length,
        matched_queries: matched,
        source_session_id: v.source.sourceSessionId,
        source_entry_id: v.source.sourceEntryId,
        created_at: v.source.createdAt,
        expires_at: v.source.expiresAt,
      };
      if (
        bytes(
          JSON.stringify({ ...result, matches: [...result.matches, match] }),
        ) > 6800
      )
        break;
      result.matches.push(match);
      offset++;
    }
    if (offset < ranked.length) {
      result.truncated = true;
      result.next_cursor = Buffer.from(
        JSON.stringify({ f: fingerprint, o: offset }),
      ).toString("base64url");
    }
    return result;
  }
  async read(input: MemoryReadRequest): Promise<MemoryReadPage> {
    if (
      !Number.isSafeInteger(input.line_offset ?? 1) ||
      (input.line_offset ?? 1) < 1 ||
      !Number.isInteger(input.max_lines ?? 40) ||
      (input.max_lines ?? 40) < 1 ||
      (input.max_lines ?? 40) > 200 ||
      !Number.isSafeInteger(input.char_offset ?? 0) ||
      (input.char_offset ?? 0) < 0 ||
      ((input.char_offset ?? 0) > 0 && (input.line_offset ?? 1) > 1)
    )
      throw new Error("Invalid memory window");
    if (!/^memory\/[a-f0-9]{64}\.md$/.test(input.path))
      throw new Error("Invalid memory path");
    const id = input.path.slice(7, -3),
      record = this.active().find((v) => v.id === id);
    if (!record)
      return {
        path: input.path,
        found: false,
        content: "",
        start_line_number: 0,
        truncated: false,
      };
    const chars = Array.from(record.text);
    let offset = input.char_offset ?? 0;
    const lines = record.text.split("\n");
    if (!offset)
      offset = Array.from(
        lines.slice(0, (input.line_offset ?? 1) - 1).join("\n") +
          ((input.line_offset ?? 1) > 1 ? "\n" : ""),
      ).length;
    const suffix = chars.slice(offset).join(""),
      selected = suffix
        .split("\n")
        .slice(0, input.max_lines ?? 40)
        .join("\n");
    const content = this.chunks(selected, 1800)[0] ?? "";
    const next = offset + Array.from(content).length;
    return {
      path: input.path,
      found: true,
      content,
      start_line_number:
        chars.slice(0, offset).filter((v) => v === "\n").length + 1,
      truncated: next < chars.length,
      ...(next < chars.length ? { next_char_offset: next } : {}),
      source_session_id: record.source.sourceSessionId,
      source_entry_id: record.source.sourceEntryId,
      created_at: record.source.createdAt,
      expires_at: record.source.expiresAt,
    };
  }
  async catalog(input: MemoryCatalogRequest): Promise<MemoryCatalogPage> {
    if (bytes(input.scope ?? "") > 160 || bytes(input.query ?? "") > 1000)
      throw new Error("Invalid memory catalog");
    const rows = this.active()
      .filter((v) => !input.scope || v.scope === input.scope)
      .filter(
        (v) =>
          !input.query ||
          matches(input.query, terms(`${v.scope} ${v.claim} ${v.summary}`)),
      );
    const result: MemoryCatalogPage = {
      entries: [],
      generation: this.state().generation,
      truncated: false,
    };
    for (const row of rows) {
      const item = {
        path: `memory/${row.id}.md`,
        scope: row.scope,
        claim: row.claim,
        label: this.chunks(row.summary, 180)[0] ?? "",
        created_at: row.source.createdAt,
      };
      if (
        result.entries.length >= 8 ||
        bytes(JSON.stringify([...result.entries, item])) > 3000
      ) {
        result.truncated = true;
        break;
      }
      result.entries.push(item);
    }
    return result;
  }
  async note(
    input: MemoryNoteRequest,
  ): Promise<{ status: "accepted" | "applied"; id: string }> {
    if (
      !this.manager ||
      !["remember", "correct", "forget"].includes(input.action) ||
      !input.operation_id ||
      input.operation_id.length > 64 ||
      bytes(input.quote) < 8 ||
      bytes(input.quote) > 6000
    )
      throw new Error("Invalid memory note");
    this.capture(this.session, this.manager);
    return this.transaction(() => {
      const generation = this.state().generation,
        digest = hash(JSON.stringify(input));
      const old = this.db
        .prepare("SELECT * FROM notes WHERE session=? AND operation=?")
        .get(this.session, input.operation_id) as
        | { generation: number; digest: string; result: string }
        | undefined;
      if (old) {
        if (old.generation !== generation || old.digest !== digest)
          throw new Error("Memory operation changed");
        return JSON.parse(old.result);
      }
      const sources = JSON.parse(
        (
          this.db
            .prepare("SELECT body FROM sources WHERE session=?")
            .get(this.session) as { body: string }
        ).body,
      ) as MemoryLearningSource[];
      const event = sources.filter((v) => v.role === "user").at(-1);
      if (
        !event ||
        event.createdAt <= this.state().cleared_at ||
        !event.text.includes(input.quote) ||
        !explicitMemoryIntent(event.text, input.action) ||
        !explicitMemoryIntent(input.quote, input.action)
      )
        throw new Error("An explicit current user request is required");
      const target =
        input.path &&
        this.active().find((v) => `memory/${v.id}.md` === input.path);
      if ((input.path || input.action !== "remember") && !target)
        throw new Error("An active target memory is required");
      const id = hash(this.session + "\0" + input.operation_id);
      const result = {
        status:
          input.action === "forget"
            ? ("applied" as const)
            : ("accepted" as const),
        id,
      };
      const source: MemoryLearningSource = {
        ...event,
        id,
        sourceEntryId: "note:" + id,
        text: input.quote,
        ...(target
          ? {
              target: {
                id: target.id,
                scope: target.scope,
                claim: target.claim,
                summary: target.summary,
              },
            }
          : {}),
      };
      this.db
        .prepare("INSERT INTO notes VALUES (?,?,?,?,?,?,?)")
        .run(
          this.session,
          input.operation_id,
          generation,
          digest,
          input.action === "forget" ? "" : JSON.stringify(source),
          JSON.stringify(result),
          Date.now(),
        );
      if (input.action === "forget" && target) {
        for (const old of this.active())
          if (old.scope === target.scope && old.claim === target.claim) {
            old.superseded = "forgotten:" + id;
            this.db
              .prepare("UPDATE memories SET body=? WHERE id=?")
              .run(JSON.stringify(old), old.id);
          }
        this.db
          .prepare(
            "INSERT INTO topics VALUES (?,?,?,?,?) ON CONFLICT(generation,topic) DO UPDATE SET source_at=excluded.source_at,source_order=excluded.source_order,id=excluded.id",
          )
          .run(
            generation,
            hash(target.scope + "\0" + target.claim),
            Date.now(),
            0,
            "forgotten:" + id,
          );
      }
      return result;
    });
  }
  async feedback(input: MemoryFeedbackRequest): Promise<{ ok: boolean }> {
    if (
      !["used", "incorrect", "irrelevant"].includes(input.outcome) ||
      !input.operation_id ||
      input.operation_id.length > 64
    )
      throw new Error("Invalid feedback");
    return this.transaction(() => {
      const generation = this.state().generation,
        body = JSON.stringify(input);
      const old = this.db
        .prepare(
          "SELECT body,generation FROM feedback WHERE session=? AND operation=?",
        )
        .get(this.session, input.operation_id) as
        | { body: string; generation: number }
        | undefined;
      if (old) {
        if (old.body !== body || old.generation !== generation)
          throw new Error("Feedback operation changed");
        return { ok: true };
      }
      const record = this.active().find(
        (v) => `memory/${v.id}.md` === input.path,
      );
      if (!record) throw new Error("Memory is unavailable");
      this.db
        .prepare("INSERT INTO feedback VALUES (?,?,?,?,?)")
        .run(this.session, input.operation_id, generation, body, Date.now());
      if (input.outcome === "used")
        record.usage = Math.min((record.usage ?? 0) + 1, 1000);
      else record.negative = Math.min((record.negative ?? 0) + 1, 1000);
      this.db
        .prepare("UPDATE memories SET body=? WHERE id=?")
        .run(JSON.stringify(record), record.id);
      return { ok: true };
    });
  }
  clear(): void {
    this.db
      .prepare(
        "UPDATE state SET generation=generation+1,cleared_at=? WHERE id=1",
      )
      .run(Date.now());
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
