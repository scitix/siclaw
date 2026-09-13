import {
  terms,
  anchors,
  briefMatches,
  rankMemories,
  indexedMemoryTerms,
} from "./recall.js";
import { validateMemoryOutline } from "./consolidation.js";
import {
  selectLearningSources,
  skipLearningModel,
  explicitTaskConfirmation,
  trivialLearningInput,
} from "./policy.js";
import fs from "node:fs";
import { explicitMemoryIntent } from "./intent.js";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  MemoryConsolidationBatch,
  MemoryConsolidationRecord,
  MemoryConsolidationSubmission,
  MemoryOutline,
  MemoryBriefRequest,
  MemoryBrief,
  MemorySearchMatch,
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
class BroadMemoryQuery extends Error {}
interface StoredMemory {
  id: string;
  text: string;
  scope: string;
  claim: string;
  summary: string;
  keywords: string;
  kind: string;
  status?: string;
  source: MemoryLearningSource;
  superseded: string;
  usage?: number;
  lastUsed?: number;
  negative?: number;
}

interface LocalConsolidationJob {
  token: string;
  generation: number;
  revision: number;
  holder: string;
  leaseUntil: number;
  retryAt: number;
  attempts: number;
  batch: MemoryConsolidationBatch;
  completedRevision?: number;
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
      CREATE TABLE IF NOT EXISTS pipeline_state (name TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS topic_aliases (generation INTEGER,alias TEXT,canonical TEXT,PRIMARY KEY(generation,alias));
      CREATE TABLE IF NOT EXISTS consolidation_receipts (token TEXT PRIMARY KEY,generation INTEGER,holder TEXT,digest TEXT,created_at INTEGER);
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, generation INTEGER NOT NULL, cleared_at INTEGER NOT NULL);
      INSERT OR IGNORE INTO state VALUES (1,0,0);
      CREATE TABLE IF NOT EXISTS sources (session TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews (generation INTEGER, id TEXT, expires_at INTEGER, PRIMARY KEY(generation,id));
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS recall_index (id TEXT PRIMARY KEY, generation INTEGER, terms TEXT);
      CREATE TABLE IF NOT EXISTS recall_terms (generation INTEGER, term TEXT, id TEXT, PRIMARY KEY(generation,term,id));
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
    let taskId = "";
    for (const [order, entry] of manager.getBranch().entries()) {
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (!["user", "assistant", "toolResult"].includes(message.role)) continue;
      if (
        message.role === "toolResult" &&
        message.toolName.startsWith("memory_")
      )
        continue;
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
      if (message.role === "user") taskId = entry.id;
      const at = Date.parse(entry.timestamp);
      if (
        !Number.isFinite(at) ||
        at > Date.now() + 300_000 ||
        at + lifetime <= Date.now()
      )
        continue;
      let offset = 0,
        fragment = 0;
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
          taskId,
          expiresAt: at + lifetime,
          sourceOrder: order * 10000 + fragment++,
          ...(message.role === "toolResult"
            ? {
                tool: message.toolName,
                isError: message.isError,
                toolCallId: message.toolCallId,
              }
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
    return this.transaction(() => {
      const current = this.session;
      try {
        const first = this.prepare();
        if (first.token) return first;
        const state = this.state(),
          cursor = this.pipelineGet<string>("scan-cursor") ?? "";
        const pending = this.db
          .prepare(
            "SELECT s.session FROM sources s WHERE s.session<>? AND s.session>? AND (EXISTS (SELECT 1 FROM json_each(s.body) v WHERE json_extract(v.value,'$.expiresAt')>? AND json_extract(v.value,'$.createdAt')>? AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.generation=? AND r.id=json_extract(v.value,'$.id'))) OR EXISTS (SELECT 1 FROM notes n WHERE n.session=s.session AND n.generation=? AND n.body<>'' AND json_extract(n.body,'$.expiresAt')>? AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.generation=n.generation AND r.id=json_extract(n.body,'$.id')))) ORDER BY s.session LIMIT 32",
          )
          .all(
            current,
            cursor,
            Date.now(),
            state.cleared_at,
            state.generation,
            state.generation,
            Date.now(),
          ) as { session: string }[];
        this.pipelinePut("scan-cursor", pending.at(-1)?.session ?? "");
        for (const row of pending) {
          this.session = row.session;
          const next = this.prepare();
          if (next.token) return next;
        }
        return first;
      } finally {
        this.session = current;
      }
    });
  }
  private prepare(): MemoryLearningBatch {
    const state = this.state();
    const cutoff = Date.now() - lifetime;
    this.db
      .prepare(
        "DELETE FROM recall_terms WHERE generation<>? OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id=recall_terms.id AND m.expires_at>?)",
      )
      .run(state.generation, Date.now());
    this.db
      .prepare(
        "DELETE FROM recall_index WHERE generation<>? OR NOT EXISTS (SELECT 1 FROM memories m WHERE m.id=recall_index.id AND m.expires_at>?)",
      )
      .run(state.generation, Date.now());
    this.db
      .prepare("DELETE FROM memories WHERE generation<>? OR expires_at<=?")
      .run(state.generation, Date.now());
    this.db
      .prepare("DELETE FROM reviews WHERE generation<>? OR expires_at<=?")
      .run(state.generation, Date.now());
    for (const table of [
      "notes",
      "feedback",
      "receipts",
      "consolidation_receipts",
    ])
      this.db
        .prepare(`DELETE FROM ${table} WHERE generation<>? OR created_at<=?`)
        .run(state.generation, cutoff);
    this.db
      .prepare(
        "DELETE FROM budget WHERE (day >= 1000000000 AND day-1000000000<?) OR (day<1000000000 AND ABS(day)<?)",
      )
      .run(
        Math.floor(Date.now() / 86400_000) - 2,
        Math.floor(Date.now() / 86400_000) - 2,
      );
    this.db
      .prepare(
        "DELETE FROM topics WHERE generation<>? OR (source_at<=? AND id NOT LIKE 'forgotten:%')",
      )
      .run(state.generation, cutoff);
    this.db
      .prepare("DELETE FROM topic_aliases WHERE generation<>?")
      .run(state.generation);
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
    const day = Math.floor(Date.now() / 86400_000);
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
    const pending: MemoryLearningSource[] = [];
    const maxInputs = Math.max(
      1,
      24 >> Math.min(Math.floor((old?.attempts ?? 0) / 2), 4),
    );
    for (const item of [...source].reverse()) {
      if (item.target && !this.memoryById(item.target.id)) {
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
      pending.push(item);
    }
    const validSources = source.filter(
      (v) => v.createdAt > state.cleared_at && v.expiresAt > Date.now(),
    );
    Object.assign(
      empty,
      selectLearningSources(validSources, pending.reverse(), maxInputs),
    );
    empty.skipModel = skipLearningModel(empty.inputs);
    const explicit = empty.inputs.some(
      (v) => v.target || explicitMemoryIntent(v.text, "remember"),
    );
    const budgetDay = explicit ? -day - 1 : day;
    const reserved = this.db
      .prepare("SELECT batches FROM budget WHERE day=?")
      .get(budgetDay) as { batches: number } | undefined;
    if (!empty.skipModel && (reserved?.batches ?? 0) >= (explicit ? 16 : 64))
      return {
        ...empty,
        inputs: [],
        context: [],
        token: "",
        retryAfterMs: (day + 1) * 86400_000 - Date.now(),
      };
    if (!empty.inputs.length) return empty;
    empty.token = randomUUID();
    empty.hints = this.learningHints(empty.inputs)
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
    if (!empty.skipModel)
      this.db
        .prepare(
          "INSERT INTO budget VALUES (?,1) ON CONFLICT(day) DO UPDATE SET batches=batches+1",
        )
        .run(budgetDay);
    return empty;
  }
  async publishLearning(
    input: MemoryLearningSubmission,
  ): Promise<{ count: number; more: boolean }> {
    const row = this.db
      .prepare(
        "SELECT session FROM receipts WHERE token=? UNION SELECT session FROM jobs WHERE token=? LIMIT 1",
      )
      .get(input.token, input.token) as { session: string } | undefined;
    const learningSession = row?.session ?? this.session;
    const digest = hash(JSON.stringify(input));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.db
        .prepare("SELECT * FROM receipts WHERE session=? AND token=?")
        .get(learningSession, input.token) as
        { generation: number; digest: string; result: string } | undefined;
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
        .get(learningSession, input.token) as
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
      const activeIds = new Set(
        batch.hints.filter((v) => this.memoryById(v.id)).map((v) => v.id),
      );
      if (input.decisions.length > 64)
        throw new Error("Too many memory decisions");
      let count = 0;
      const claimSpans = new Map<string, { start: number; end: number }[]>();
      for (const d of input.decisions) {
        let status = d.status;
        if (batch.skipModel && d.kind !== "ignore")
          throw new Error("No-model batch only accepts ignored sources");
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
        if (d.kind === "forget" && !explicitMemoryIntent(source.text, "forget"))
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
          const start = source.text.indexOf(d.quote),
            end = start + d.quote.length;
          const spans = claimSpans.get(d.entryId) ?? [];
          if (spans.some((span) => start < span.end && span.start < end))
            throw new Error(
              "Independent memory claims require disjoint source quotes",
            );
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
          let toolOrder = -1,
            confirmationOrder = -1;
          let firstToolOrder = Infinity,
            goalOrder = Infinity;
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
            if (src.role === "toolResult") {
              toolOrder = Math.max(toolOrder, src.sourceOrder ?? -1);
              firstToolOrder = Math.min(firstToolOrder, src.sourceOrder ?? 0);
            }
            if (src.role === "user" && !explicitTaskConfirmation(e.quote))
              goalOrder = Math.min(goalOrder, src.sourceOrder ?? 0);
            if (src.role === "user" && explicitTaskConfirmation(e.quote))
              confirmationOrder = Math.max(
                confirmationOrder,
                src.sourceOrder ?? -1,
              );
            text += `\n\n[${src.role}; ${e.entryId}]\n${e.quote}`;
          }
          if (
            (d.kind === "experience" && !tool) ||
            !user ||
            !Number.isFinite(goalOrder) ||
            goalOrder > firstToolOrder
          )
            throw new Error("Unsupported task status");
          if (
            d.status === "user-confirmed" &&
            !(tool && confirmationOrder > toolOrder)
          )
            status = "uncertain";
          text = `Historical task status: ${status} (requires current verification)\n\n${text}`;
        }
        const topic = ["task", "experience"].includes(d.kind)
            ? hash("task\0" + id)
            : this.canonicalTopic(d.scope, d.claim),
          prior = this.db
            .prepare(
              "SELECT source_at,source_order,id FROM topics WHERE generation=? AND topic=?",
            )
            .get(row.generation, topic) as
            { source_at: number; source_order: number; id: string } | undefined;
        const memory: StoredMemory = {
          id,
          text,
          scope: d.scope,
          claim: d.claim,
          kind: d.kind,
          status,
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
            if (
              !["task", "experience"].includes(old.kind) &&
              this.canonicalTopic(old.scope, old.claim) === topic
            ) {
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
        this.indexMemory(memory, row.generation);
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
      if (count) this.bumpRevision();
      const result = { count, more: batch.more };
      this.db
        .prepare("INSERT INTO receipts VALUES (?,?,?,?,?,?)")
        .run(
          learningSession,
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
        .run(digest, JSON.stringify(result), learningSession, input.token);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async failLearning(token: string): Promise<void> {
    this.transaction(() => {
      const rowSession = this.db
        .prepare("SELECT session FROM jobs WHERE token=? AND holder=?")
        .get(token, this.holder) as { session: string } | undefined;
      if (!rowSession) return;
      const learningSession = rowSession.session;
      const row = this.db
        .prepare(
          "SELECT attempts FROM jobs WHERE session=? AND token=? AND holder=? AND digest='' AND generation=?",
        )
        .get(learningSession, token, this.holder, this.state().generation) as
        { attempts: number } | undefined;
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
            learningSession,
            token,
          );
    });
  }
  private indexMemory(v: StoredMemory, generation: number): void {
    if (!this.db.isTransaction) {
      this.transaction(() => this.indexMemory(v, generation));
      return;
    }
    const words = [...indexedMemoryTerms(v)];
    this.db
      .prepare("INSERT OR REPLACE INTO recall_index VALUES (?,?,?)")
      .run(v.id, generation, JSON.stringify(words));
    this.db.prepare("DELETE FROM recall_terms WHERE id=?").run(v.id);
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO recall_terms VALUES (?,?,?)",
    );
    for (const word of words) insert.run(generation, word, v.id);
  }
  private recallCandidates(
    queries: string[],
    scope?: string,
    strict = false,
  ): StoredMemory[] {
    const generation = this.state().generation,
      now = Date.now();
    const pending = this.db
      .prepare(
        "SELECT body FROM memories m WHERE generation=? AND expires_at>? AND NOT EXISTS (SELECT 1 FROM recall_index r WHERE r.id=m.id) LIMIT 129",
      )
      .all(generation, now) as { body: string }[];
    for (const row of pending.slice(0, 128))
      this.indexMemory(JSON.parse(row.body), generation);
    if (pending.length > 128)
      throw new Error("Memory index upgrade in progress; retry");
    let sql =
      "SELECT m.body FROM memories m WHERE m.generation=? AND m.expires_at>? AND json_extract(m.body,'$.superseded')=''";
    const args: (string | number)[] = [generation, now];
    if (scope) {
      sql += " AND json_extract(m.body,'$.scope')=?";
      args.push(scope);
    }
    if (queries.length) {
      const words = [
        ...new Set(queries.flatMap((q) => [...terms(q)].slice(0, 128))),
      ];
      if (!words.length) return [];
      sql +=
        " AND m.id IN (SELECT id FROM recall_terms WHERE generation=? AND term IN (" +
        words.map(() => "?").join(",") +
        "))";
      args.push(generation, ...words);
      if (strict)
        for (const anchor of anchors(queries[0])) {
          sql +=
            " AND m.id IN (SELECT id FROM recall_terms WHERE generation=? AND term=?)";
          args.push(generation, anchor);
        }
    }
    const rows = this.db.prepare(sql + " LIMIT 1001").all(...args) as {
      body: string;
    }[];
    if (rows.length > 1000) throw new BroadMemoryQuery();
    return rows.map((v) => JSON.parse(v.body) as StoredMemory);
  }
  private learningHints(inputs: MemoryLearningSource[]): StoredMemory[] {
    const query = inputs.map((v) => this.chunks(v.text, 500)[0]).join(" ");
    try {
      return rankMemories(this.recallCandidates([query]), query, false);
    } catch (e) {
      if (e instanceof BroadMemoryQuery) return [];
      throw e;
    }
  }
  private memoryById(
    id: string,
    includeRetired = false,
  ): StoredMemory | undefined {
    const row = this.db
      .prepare(
        "SELECT body FROM memories WHERE id=? AND generation=? AND expires_at>?",
      )
      .get(id, this.state().generation, Date.now()) as
      { body: string } | undefined;
    const value = row ? (JSON.parse(row.body) as StoredMemory) : undefined;
    return value && (includeRetired || !value.superseded) ? value : undefined;
  }
  private memoryTopic(v: StoredMemory): string {
    return ["task", "experience"].includes(v.kind)
      ? hash("task\0" + v.id)
      : this.canonicalTopic(v.scope, v.claim);
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
    let candidates: StoredMemory[];
    try {
      const all = new Map<string, StoredMemory>();
      for (const query of input.queries)
        for (const row of this.recallCandidates([query], input.scope, true))
          all.set(row.id, row);
      candidates = [...all.values()];
    } catch (e) {
      if (e instanceof BroadMemoryQuery)
        return {
          matches: [],
          truncated: false,
          enabled: true,
          refine_query: true,
        };
      throw e;
    }
    const found = new Map<
      string,
      { v: StoredMemory; matched: string[]; score: number }
    >();
    for (const query of input.queries)
      rankMemories(candidates, query, true).forEach((v, i) => {
        const old = found.get(v.id) ?? { v, matched: [], score: 0 };
        old.matched.push(query);
        old.score += 1 / (i + 1);
        found.set(v.id, old);
      });
    const ranked = [...found.values()]
      .filter(
        (v) =>
          input.match_mode === "any" ||
          v.matched.length === input.queries.length,
      )
      .sort(
        (a, b) =>
          b.score - a.score ||
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
        ...(v.status ? { status: v.status } : {}),
        ...(v.source.taskId ? { task_id: v.source.taskId } : {}),
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
      record = this.memoryById(id);
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
    let rows: StoredMemory[];
    try {
      rows = rankMemories(
        this.recallCandidates(
          input.query ? [input.query] : [],
          input.scope,
          Boolean(input.query),
        ),
        input.query ?? "",
        Boolean(input.query),
      );
    } catch (e) {
      if (e instanceof BroadMemoryQuery)
        return {
          entries: [],
          generation: this.state().generation,
          truncated: false,
          refine_query: true,
        };
      throw e;
    }
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
        { generation: number; digest: string; result: string } | undefined;
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
      const target = input.path && this.memoryById(input.path.slice(7, -3));
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
        this.bumpRevision();
        for (const old of this.active())
          if (this.memoryTopic(old) === this.memoryTopic(target)) {
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
            this.memoryTopic(target),
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
        { body: string; generation: number } | undefined;
      if (old) {
        if (old.body !== body || old.generation !== generation)
          throw new Error("Feedback operation changed");
        return { ok: true };
      }
      const record = /^memory\/[a-f0-9]{64}\.md$/.test(input.path)
        ? this.memoryById(input.path.slice(7, -3))
        : undefined;
      if (!record) throw new Error("Memory is unavailable");
      this.db
        .prepare("INSERT INTO feedback VALUES (?,?,?,?,?)")
        .run(this.session, input.operation_id, generation, body, Date.now());
      if (input.outcome === "used") {
        record.usage = Math.min((record.usage ?? 0) + 1, 1000);
        record.lastUsed = Date.now();
      } else record.negative = Math.min((record.negative ?? 0) + 1, 1000);
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
  private pipelineGet<T>(name: string): T | undefined {
    const r = this.db
      .prepare("SELECT body FROM pipeline_state WHERE name=?")
      .get(name) as { body: string } | undefined;
    return r ? (JSON.parse(r.body) as T) : undefined;
  }
  private pipelinePut(name: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO pipeline_state VALUES (?,?) ON CONFLICT(name) DO UPDATE SET body=excluded.body",
      )
      .run(name, JSON.stringify(value));
  }
  private memoryRevision(): number {
    return this.pipelineGet<number>("revision") ?? 0;
  }
  private bumpRevision(): void {
    this.pipelinePut("revision", this.memoryRevision() + 1);
  }
  private canonicalTopic(scope: string, claim: string): string {
    const key = hash(scope + "\0" + claim);
    const r = this.db
      .prepare(
        "SELECT canonical FROM topic_aliases WHERE generation=? AND alias=?",
      )
      .get(this.state().generation, key) as { canonical: string } | undefined;
    return r?.canonical ?? key;
  }
  async prepareConsolidation(): Promise<MemoryConsolidationBatch> {
    return this.transaction(() => {
      const generation = this.state().generation,
        revision = this.memoryRevision(),
        now = Date.now();
      const empty: MemoryConsolidationBatch = {
        token: "",
        generation,
        revision,
        records: [],
        rollouts: [],
        previous: { topics: [], merges: [] },
      };
      const old = this.pipelineGet<LocalConsolidationJob>("job");
      if (old?.generation === generation) {
        if (old.leaseUntil > now) {
          if (old.holder !== this.holder || !old.batch)
            return { ...empty, retryAfterMs: old.leaseUntil - now };
          this.checkConsolidation(old);
          return old.batch;
        }
        if (old.retryAt > now)
          return { ...empty, retryAfterMs: old.retryAt - now };
        if (old.completedRevision === revision) return empty;
      }
      const day = Math.floor(now / 86400_000) + 1_000_000_000;
      const budget = this.db
        .prepare("SELECT batches FROM budget WHERE day=?")
        .get(day) as { batches: number } | undefined;
      if ((budget?.batches ?? 0) >= 16)
        return { ...empty, retryAfterMs: 86400_000 - (now % 86400_000) };
      const candidates = this.active().sort(
        (a, b) =>
          (b.usage ?? 0) - (a.usage ?? 0) ||
          (b.lastUsed ?? 0) - (a.lastUsed ?? 0) ||
          b.source.createdAt - a.source.createdAt ||
          a.id.localeCompare(b.id),
      );
      let bytes = 0;
      for (const v of candidates) {
        if (empty.records.length >= 64) break;
        const r: MemoryConsolidationRecord = {
          id: v.id,
          scope: v.scope,
          claim: v.claim,
          kind: v.kind,
          status: v.status,
          text: v.text,
          summary: v.summary,
          sourceSessionId: v.source.sourceSessionId,
          createdAt: v.source.createdAt,
          usageCount: v.usage ?? 0,
          negativeCount: v.negative ?? 0,
        };
        const size = Buffer.byteLength(JSON.stringify(r));
        if (bytes + size > 64 * 1024) continue;
        bytes += size;
        empty.records.push(r);
      }
      if (!empty.records.length) return empty;
      const rollouts = new Map<string, string[]>();
      for (const r of [...empty.records].sort(
        (a, b) => a.createdAt - b.createdAt,
      ))
        rollouts.set(r.sourceSessionId, [
          ...(rollouts.get(r.sourceSessionId) ?? []),
          r.id,
        ]);
      empty.rollouts = [...rollouts].map(([sessionId, ids]) => ({
        sessionId,
        ids,
      }));
      const previous = this.pipelineGet<{
        generation: number;
        outline: MemoryOutline;
      }>("summary");
      const ids = new Set(empty.records.map((v) => v.id));
      if (previous?.generation === generation)
        empty.previous = {
          topics: previous.outline.topics.filter((t) =>
            t.ids.every((id) => ids.has(id)),
          ),
          merges: [],
        };
      empty.token = randomUUID();
      this.pipelinePut("job", {
        token: empty.token,
        generation,
        revision,
        holder: this.holder,
        leaseUntil: now + 120000,
        retryAt: 0,
        attempts: (old?.attempts ?? 0) + 1,
        batch: empty,
      } satisfies LocalConsolidationJob);
      this.db
        .prepare(
          "INSERT INTO budget VALUES (?,1) ON CONFLICT(day) DO UPDATE SET batches=batches+1",
        )
        .run(day);
      return empty;
    });
  }
  private checkConsolidation(j: LocalConsolidationJob): void {
    if (
      j.holder !== this.holder ||
      j.generation !== this.state().generation ||
      j.revision !== this.memoryRevision() ||
      j.leaseUntil <= Date.now()
    )
      throw new Error("Memory consolidation changed");
    const active = new Set(
      j.batch.records.filter((v) => this.memoryById(v.id)).map((v) => v.id),
    );
    if (j.batch.records.some((v) => !active.has(v.id)))
      throw new Error("Consolidation source expired or changed");
  }
  async publishConsolidation(
    input: MemoryConsolidationSubmission,
  ): Promise<{ ok: boolean }> {
    const digest = hash(JSON.stringify(input));
    return this.transaction(() => {
      const receipt = this.db
        .prepare("SELECT * FROM consolidation_receipts WHERE token=?")
        .get(input.token) as
        { generation: number; holder: string; digest: string } | undefined;
      if (receipt) {
        if (
          receipt.generation !== this.state().generation ||
          receipt.holder !== this.holder ||
          receipt.digest !== digest
        )
          throw new Error("Memory consolidation operation changed");
        return { ok: true };
      }
      const j = this.pipelineGet<LocalConsolidationJob>("job");
      if (!j || j.token !== input.token)
        throw new Error("Unknown consolidation job");
      this.checkConsolidation(j);
      validateMemoryOutline(input.outline, j.batch.records);
      for (const ids of input.outline.merges) this.mergeTopics(ids);
      this.pipelinePut("summary", {
        generation: j.generation,
        outline: input.outline,
      });
      this.pipelinePut("job", {
        ...j,
        leaseUntil: 0,
        attempts: 0,
        retryAt: Date.now() + 30000,
        completedRevision: this.memoryRevision(),
      });
      this.db
        .prepare("INSERT INTO consolidation_receipts VALUES (?,?,?,?,?)")
        .run(input.token, j.generation, this.holder, digest, Date.now());
      return { ok: true };
    });
  }
  private mergeTopics(ids: string[]): void {
    const active = this.active(),
      members = ids.map((id) => active.find((v) => v.id === id)!);
    const roots = [
      ...new Set(members.map((v) => this.canonicalTopic(v.scope, v.claim))),
    ].sort();
    if (roots.length < 2) return;
    const canonical = roots[0],
      generation = this.state().generation;
    const heads = roots.map(
      (root) =>
        this.db
          .prepare("SELECT * FROM topics WHERE generation=? AND topic=?")
          .get(generation, root) as
          { id: string; source_at: number; source_order: number } | undefined,
    );
    if (heads.some((v) => !v || v.id.startsWith("forgotten:")))
      throw new Error("Cannot merge a forgotten topic");
    const winner = heads
      .filter((v): v is NonNullable<typeof v> => !!v)
      .sort(
        (a, b) =>
          b.source_at - a.source_at ||
          b.source_order - a.source_order ||
          b.id.localeCompare(a.id),
      )[0];
    this.db
      .prepare(
        "INSERT INTO topics VALUES (?,?,?,?,?) ON CONFLICT(generation,topic) DO UPDATE SET source_at=excluded.source_at,source_order=excluded.source_order,id=excluded.id",
      )
      .run(
        generation,
        canonical,
        winner.source_at,
        winner.source_order,
        winner.id,
      );
    for (const root of roots) {
      this.db
        .prepare(
          "UPDATE topic_aliases SET canonical=? WHERE generation=? AND canonical=?",
        )
        .run(canonical, generation, root);
      this.db
        .prepare(
          "INSERT INTO topic_aliases VALUES (?,?,?) ON CONFLICT(generation,alias) DO UPDATE SET canonical=excluded.canonical",
        )
        .run(generation, root, canonical);
    }
    for (const v of active) {
      if (
        ["task", "experience"].includes(v.kind) ||
        this.canonicalTopic(v.scope, v.claim) !== canonical
      )
        continue;
      if (v.id !== winner.id) {
        v.superseded = winner.id;
        this.db
          .prepare("UPDATE memories SET body=? WHERE id=?")
          .run(JSON.stringify(v), v.id);
      }
    }
    this.bumpRevision();
  }
  async failConsolidation(token: string): Promise<void> {
    this.transaction(() => {
      const j = this.pipelineGet<LocalConsolidationJob>("job");
      if (
        !j ||
        j.token !== token ||
        j.holder !== this.holder ||
        j.generation !== this.state().generation
      )
        return;
      this.pipelinePut("job", {
        ...j,
        leaseUntil: 0,
        retryAt: Date.now() + 5000 * 2 ** Math.min(j.attempts, 6),
      });
    });
  }
  async brief(input: MemoryBriefRequest): Promise<MemoryBrief> {
    const generation = this.state().generation;
    const out: MemoryBrief = { generation, items: [] };
    if (
      Buffer.byteLength(input.query) > 1000 ||
      Buffer.byteLength(input.scope ?? "") > 160
    )
      throw new Error("Invalid memory brief query");
    if (trivialLearningInput(input.query)) return out;
    const summary = this.pipelineGet<{
      generation: number;
      outline: MemoryOutline;
    }>("summary");
    if (!summary || summary.generation !== generation) return out;
    const seen = new Set<string>();
    let used = 0, candidates = 0;
    for (const topic of summary.outline.topics)
      for (const id of topic.ids) {
        let v = this.memoryById(id);
        if (!v) {
          const old = this.memoryById(id, true);
          if (old && !["task", "experience"].includes(old.kind)) {
            const head = this.db
              .prepare("SELECT id FROM topics WHERE generation=? AND topic=?")
              .get(generation, this.memoryTopic(old)) as
              { id: string } | undefined;
            if (head) v = this.memoryById(head.id);
          }
        }
        if (!v || seen.has(v.id) || (input.scope && v.scope !== input.scope))
          continue;
        if (
          v.scope !== "user" &&
          !briefMatches(
            input.query,
            terms(v.scope + " " + v.claim + " " + v.summary),
          )
        )
          continue;
        if (candidates++ >= 5) return out;
        seen.add(v.id);
        let content = v.text;
        // A complete short task already contains literal goal and evidence.
        // Reserve a route for long records; do not force a redundant read.
        if (
          (v.kind === "task" || v.kind === "experience") &&
          Buffer.byteLength(content) > 1200
        )
          content = `Historical task (${v.status}): ${v.summary}. Read its evidence if this route is useful; verify current conditions.`;
        content = this.chunks(content, 1200)[0] ?? "";
        const item: MemorySearchMatch = {
          path: `memory/${v.id}.md`,
          kind: v.kind,
          status: v.status,
          task_id: v.source.taskId,
          scope: v.scope,
          claim: v.claim,
          content,
          content_start_line_number: 1,
          truncated: content !== v.text,
          matched_queries: [],
          source_session_id: v.source.sourceSessionId,
          source_entry_id: v.source.sourceEntryId,
          created_at: v.source.createdAt,
          expires_at: v.source.expiresAt,
        };
        const size = Buffer.byteLength(JSON.stringify(item));
        if (out.items.length >= 5 || used + size > 4096) continue;
        used += size;
        out.items.push(item);
      }
    return out;
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
