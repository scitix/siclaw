/**
 * Trace Recorder — writes per-prompt JSON traces to disk for offline retrospective.
 *
 * Hooks into BrainSession.subscribe() + diagnostic event bus. One JSON file per
 * agent run (bounded by agent_start/agent_end events). Filesystem only, never
 * exposed through HTTP/SSE/WebSocket.
 *
 * Default output: <cwd>/.siclaw/traces/trace-<sessionId>-<idx>-<ts>.json
 * Override: env SICLAW_TRACE_DIR=/path
 * Disable:  env SICLAW_TRACE_DISABLE=1
 */

import fs from "node:fs";
import path from "node:path";
import { onDiagnostic, type DiagnosticEvent } from "../shared/diagnostic-events.js";
import type { BrainSession, BrainSessionStats, BrainModelInfo } from "./brain-session.js";
import { getTraceStore, type TraceStore } from "./trace-store.js";

// ── Types ──────────────────────────────────────────────

export interface TraceRecorderOpts {
  traceDir: string;
  sessionId: string;
  /** Internal user identifier (hex ID in web mode, OS username in CLI). Used as the
   *  machine-readable field in the JSON body; also used as the filename fallback
   *  when no displayable username is available. */
  userId?: string;
  /** Displayable username (e.g. "admin") — set via constructor for CLI or later via
   *  setUsername() for web mode. Preferred over userId in filenames. */
  username?: string;
  mode: string;
  brainType?: string;
  getSessionStats?: () => BrainSessionStats | undefined;
  getModel?: () => BrainModelInfo | undefined;
  /** Persistent store; when provided, each flush also inserts a DB row. */
  store?: TraceStore | null;
}

/**
 * How a skill was referenced in a single tool call.
 *   - "read"         = agent read the SKILL.md documentation (Path A; the dominant path
 *                      since most siclaw skills are pure markdown instructions).
 *   - "local_script" = agent invoked a bundled script under the skill (Path B).
 */
type SkillVia = "read" | "local_script";

interface SkillRef {
  skillName: string;
  scope?: string;           // core | extension | global | personal | user | ...
  scriptName?: string;      // only for via === "local_script"
  via: SkillVia;
}

interface ToolCallStep {
  kind: "tool_call";
  name: string;
  toolCallId?: string;
  args: unknown;
  output: string;
  isError: boolean;
  startedAt: string;   // Beijing time (UTC+8), format: YYYY-MM-DD HH:mm:ss.SSS
  endedAt: string;
  durationMs: number;  // Duration — kept as number for easy arithmetic
  skill?: SkillRef;
}

interface MessageStep {
  kind: "message";
  role: "assistant";   // user/toolResult messages dropped as redundant
  stopReason?: string;
  ts: string;
  text: string;
  toolCalls?: Array<{ name: string; args?: unknown; toolCallId?: string }>;
}

interface LifecycleStep {
  kind: "turn_start" | "turn_end" | "auto_compaction" | "auto_retry" | "model_error";
  ts: string;
  detail?: unknown;
}

type TraceStep = ToolCallStep | MessageStep | LifecycleStep;

interface SkillUsageRecord extends SkillRef {
  ts: string;                         // when the usage happened (Beijing time)
  outcome?: "success" | "error";      // only populated for local_script via diagnostic bus
  durationMs?: number;                // only populated for local_script via diagnostic bus
}

// ── Recorder ───────────────────────────────────────────

export class TraceRecorder {
  private pendingTools = new Map<string, { name: string; args: unknown; startedAtMs: number; toolCallId?: string }>();
  private steps: TraceStep[] = [];
  private skillsUsed: SkillUsageRecord[] = [];
  /**
   * Buffer for `skill_call` diagnostic events that arrive BEFORE their corresponding
   * tool_execution_end (because `local_script.ts` emits the diagnostic synchronously
   * during execute(), whereas the brain emits tool_execution_end afterwards). When
   * the tool_call step is later constructed, we drain the matching buffered entry to
   * populate `scope` on the step's `skill` field. Fixes the empirical mismatch where
   * `skillsUsed[]` had scope but the tool_call step did not.
   */
  private pendingSkillMeta: Array<{ skillName: string; scriptName: string; scope: string; outcome: "success" | "error"; durationMs: number; ts: string }> = [];
  private active = false;
  private promptIdx = 0;
  private userMessage = "";
  private lastUserMessageBuffered = "";
  private startedAtMs = 0;
  private prevStats: BrainSessionStats | undefined;
  private unsubscribeDiag: (() => void) | null = null;
  private outcome: "completed" | "error" = "completed";
  /** Live username — may be updated mid-session via setUsername() (web mode). */
  private username: string | undefined;
  /**
   * Explicit-boundary mode. Once beginPrompt() is called by external code
   * (http-server `/api/prompt`, cli-main's session.prompt wrapper, …), we stop
   * treating internal agent_start/agent_end events as trace boundaries. This
   * keeps ONE user prompt = ONE trace file even when pi-agent internally fires
   * multiple agent cycles (empty-response retry, auto-compaction, continuation).
   * Once set to true, stays true — mixing modes mid-session is not supported.
   */
  private explicitMode = false;

  constructor(private readonly opts: TraceRecorderOpts) {
    try {
      fs.mkdirSync(opts.traceDir, { recursive: true });
    } catch (err) {
      console.warn(`[trace-recorder] Failed to create trace dir ${opts.traceDir}:`, err);
    }
    this.username = opts.username;
    this.unsubscribeDiag = onDiagnostic((evt) => this.onDiagnosticEvent(evt));
  }

  /**
   * Set (or update) the displayable username. Used by the web/agentbox path
   * where username isn't known at session-creation time but arrives later in
   * the prompt body. Applies to all subsequent trace flushes for this session
   * — filenames use it, and the JSON body records it alongside userId.
   */
  setUsername(username: string): void {
    if (username && username.trim()) this.username = username;
  }

  /** Subscribe to a brain's events. Returns unsubscribe fn. */
  attach(brain: BrainSession): () => void {
    return brain.subscribe((event) => this.onBrainEvent(event));
  }

  /**
   * Explicitly record the user's raw prompt text.
   *
   * This is needed for the web/agentbox path because the pi-agent framework
   * does not reliably emit a `message_end { role: "user" }` event before
   * `agent_start` fires in that mode (events are raised inside brain.prompt()
   * after the fact). Callers that have direct access to the user input
   * (e.g. the HTTP /api/prompt handler) should call this before invoking
   * `brain.prompt()` so the upcoming agent_start picks it up.
   *
   * If a trace is already in-flight (rare edge case), the current trace's
   * userMessage is also updated so it's not lost.
   */
  setUserMessage(text: string): void {
    this.lastUserMessageBuffered = text;
    if (this.active && !this.userMessage) {
      this.userMessage = text;
    }
  }

  /**
   * Start collecting a new trace. When called externally (http-server,
   * cli-main's session.prompt wrapper), switches the recorder into
   * explicit-boundary mode: subsequent internal agent_start/agent_end events
   * will NOT split the trace into multiple files.
   */
  beginPrompt(userMessage: string): void {
    this.explicitMode = true;
    this.startTrace(userMessage);
  }

  /** Shared trace-reset logic used by both explicit beginPrompt() and the
   *  internal auto-detect path (agent_start in auto mode). */
  private startTrace(userMessage: string): void {
    if (this.active) this.flush();
    this.active = true;
    this.promptIdx += 1;
    this.userMessage = userMessage;
    this.startedAtMs = Date.now();
    this.steps = [];
    this.skillsUsed = [];
    this.pendingSkillMeta = [];
    this.pendingTools.clear();
    this.outcome = "completed";
    this.prevStats = safeCall(this.opts.getSessionStats);
  }

  /** Finalize the current trace. Usually auto-invoked on agent_end. */
  endPrompt(outcome?: "completed" | "error"): string | null {
    if (!this.active) return null;
    if (outcome) this.outcome = outcome;
    return this.flush();
  }

  /** Release all resources. Writes any in-flight trace first. */
  close(): void {
    if (this.active) this.flush();
    if (this.unsubscribeDiag) {
      this.unsubscribeDiag();
      this.unsubscribeDiag = null;
    }
  }

  // ── Event handlers ──────────────────────────────────

  private onBrainEvent(event: unknown): void {
    const ev = event as Record<string, unknown> | null;
    if (!ev || typeof ev !== "object") return;
    const type = ev.type as string | undefined;
    if (!type) return;
    const now = Date.now();

    // User message: capture for use when next agent_start fires (auto mode only).
    // In EXPLICIT mode, pi-agent may re-emit the prompt verbatim during retry —
    // don't let that overwrite the authoritative userMessage from beginPrompt().
    if (type === "message_end") {
      const msg = ev.message as Record<string, unknown> | undefined;
      if (msg?.role === "user" && !this.explicitMode) {
        this.lastUserMessageBuffered = extractText(msg.content);
      }
    }

    // agent_start: in AUTO mode, opens a new trace. In EXPLICIT mode, internal
    // cycles (empty-response retry / auto-compaction continuation) are merged
    // into the current trace by external beginPrompt — do nothing here.
    if (type === "agent_start") {
      if (!this.explicitMode) {
        this.startTrace(this.lastUserMessageBuffered);
      }
      return;
    }

    if (!this.active) return;

    switch (type) {
      case "agent_end":
        // In EXPLICIT mode, external endPrompt drives the flush; ignore.
        if (this.explicitMode) return;
        this.flush();
        return;

      case "turn_start":
      case "turn_end":
        this.steps.push({ kind: type, ts: formatBeijing(now) });
        return;

      case "message_end": {
        const msg = ev.message as Record<string, unknown> | undefined;
        if (!msg) return;
        const role = (msg.role as string) ?? "";
        // Drop role="user" (== top-level userMessage) and role="toolResult"
        // (== tool_call.output) — pure duplicates.
        if (role !== "assistant") return;
        const content = Array.isArray(msg.content) ? (msg.content as Array<Record<string, unknown>>) : [];
        const text = content
          .filter((c) => c.type === "text")
          .map((c) => (c.text as string | undefined) ?? "")
          .join("");
        const toolCalls = content
          .filter((c) => c.type === "toolCall")
          .map((c) => ({
            name: c.name as string,
            args: c.input ?? c.arguments,
            toolCallId: c.id as string | undefined,
          }));
        this.steps.push({
          kind: "message",
          role: "assistant",
          stopReason: msg.stopReason as string | undefined,
          ts: formatBeijing(now),
          text,
          toolCalls: toolCalls.length ? toolCalls : undefined,
        });
        if (msg.stopReason === "error") {
          this.outcome = "error";
          this.steps.push({
            kind: "model_error",
            ts: formatBeijing(now),
            detail: { errorMessage: msg.errorMessage },
          });
        }
        return;
      }

      case "tool_execution_start": {
        const name = (ev.toolName as string) ?? (ev.name as string) ?? "tool";
        const toolCallId = ev.toolCallId as string | undefined;
        this.pendingTools.set(pendingKey(name, toolCallId), {
          name,
          args: ev.args,
          startedAtMs: now,
          toolCallId,
        });
        return;
      }

      case "tool_execution_end": {
        const name = (ev.toolName as string) ?? (ev.name as string) ?? "tool";
        const toolCallId = ev.toolCallId as string | undefined;
        const key = pendingKey(name, toolCallId);
        const pending = this.pendingTools.get(key);
        this.pendingTools.delete(key);

        const result = ev.result as Record<string, unknown> | undefined;
        const output = Array.isArray(result?.content)
          ? (result!.content as Array<Record<string, unknown>>)
              .filter((c) => c.type === "text")
              .map((c) => (c.text as string | undefined) ?? "")
              .join("")
          : "";
        const details = result?.details as Record<string, unknown> | undefined;
        const isError = Boolean(ev.isError || details?.error || details?.blocked);

        const startMs = pending?.startedAtMs ?? now;
        const startedAtStr = formatBeijing(startMs);
        const step: ToolCallStep = {
          kind: "tool_call",
          name,
          toolCallId: pending?.toolCallId ?? toolCallId,
          args: pending?.args,
          output,
          isError,
          startedAt: startedAtStr,
          endedAt: formatBeijing(now),
          durationMs: pending ? now - pending.startedAtMs : 0,
        };
        this.enrichWithSkill(step, startedAtStr);
        this.steps.push(step);
        return;
      }

      case "auto_compaction_start":
      case "auto_compaction_end":
        this.steps.push({ kind: "auto_compaction", ts: formatBeijing(now), detail: ev });
        return;

      case "auto_retry_start":
      case "auto_retry_end":
        this.steps.push({ kind: "auto_retry", ts: formatBeijing(now), detail: ev });
        return;

      // message_update / tool_execution_update are high-volume streaming deltas; drop.
      default:
        return;
    }
  }

  /**
   * Enrich a freshly-built tool_call step with skill information by detecting:
   *  - Path A: read/Read/file_read with args.path ending in "/SKILL.md"
   *  - Path B: local_script with args.skill
   * Also merges any pending skill_call diagnostic metadata (scope, outcome,
   * durationMs) that arrived before the corresponding tool_execution_end.
   */
  private enrichWithSkill(step: ToolCallStep, ts: string): void {
    const args = step.args as Record<string, unknown> | undefined;
    let ref: SkillRef | null = null;

    // Path B: local_script
    if (args && typeof args === "object") {
      const skillName = (args.skill ?? args.skillName) as string | undefined;
      if (skillName) {
        ref = {
          skillName,
          scriptName: ((args.script ?? args.scriptName) as string | undefined) ?? "",
          via: "local_script",
        };
      }
    }

    // Path A: reading SKILL.md
    if (!ref && args && typeof args === "object") {
      const filePath = (args.path ?? args.file_path ?? args.filePath) as string | undefined;
      const parsed = filePath ? parseSkillPath(filePath) : null;
      if (parsed) {
        ref = { skillName: parsed.skillName, scope: parsed.scope, via: "read" };
      }
    }

    if (!ref) return;

    // Merge any buffered diagnostic metadata for Path B (carries authoritative scope).
    if (ref.via === "local_script") {
      const idx = this.pendingSkillMeta.findIndex(
        (m) => m.skillName === ref!.skillName && (!ref!.scriptName || m.scriptName === ref!.scriptName),
      );
      if (idx >= 0) {
        const meta = this.pendingSkillMeta[idx];
        ref.scope = meta.scope;
        this.pendingSkillMeta.splice(idx, 1);
      }
    }

    step.skill = ref;
    this.skillsUsed.push({
      skillName: ref.skillName,
      scope: ref.scope,
      scriptName: ref.scriptName,
      via: ref.via,
      ts,
    });
  }

  private onDiagnosticEvent(evt: DiagnosticEvent): void {
    if (evt.type !== "skill_call") return;
    if (evt.sessionId && evt.sessionId !== this.opts.sessionId) return;

    // Try to find a tool_call step already recorded (the local_script event arrives
    // AFTER the brain's tool_execution_end — correct flow). Enrich scope/outcome/duration.
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const s = this.steps[i];
      if (s.kind === "tool_call" && s.skill && s.skill.via === "local_script" && s.skill.skillName === evt.skillName) {
        if (!s.skill.scope) s.skill.scope = evt.scope;
        // Also enrich the latest matching aggregate record.
        for (let j = this.skillsUsed.length - 1; j >= 0; j--) {
          const u = this.skillsUsed[j];
          if (u.via === "local_script" && u.skillName === evt.skillName && !u.scope) {
            u.scope = evt.scope;
            u.outcome = evt.outcome;
            u.durationMs = evt.durationMs;
            break;
          }
        }
        return;
      }
    }

    // No matching step yet — the diagnostic fired BEFORE tool_execution_end.
    // Buffer it so enrichWithSkill() can pick it up when the step is built.
    this.pendingSkillMeta.push({
      skillName: evt.skillName,
      scriptName: evt.scriptName,
      scope: evt.scope,
      outcome: evt.outcome,
      durationMs: evt.durationMs,
      ts: formatBeijing(Date.now()),
    });
  }

  // ── Flush ───────────────────────────────────────────

  private flush(): string | null {
    if (!this.active) return null;
    this.active = false;
    const endedAtMs = Date.now();
    const currStats = safeCall(this.opts.getSessionStats);
    const model = safeCall(this.opts.getModel);

    const tokensDelta =
      this.prevStats && currStats
        ? {
            input: currStats.tokens.input - this.prevStats.tokens.input,
            output: currStats.tokens.output - this.prevStats.tokens.output,
            cacheRead: currStats.tokens.cacheRead - this.prevStats.tokens.cacheRead,
            cacheWrite: currStats.tokens.cacheWrite - this.prevStats.tokens.cacheWrite,
            total: currStats.tokens.total - this.prevStats.tokens.total,
          }
        : undefined;
    const costDelta =
      this.prevStats && currStats ? currStats.cost - this.prevStats.cost : undefined;

    const trace = {
      schemaVersion: "1.1",
      sessionId: this.opts.sessionId,
      username: this.username,
      userId: this.opts.userId,
      mode: this.opts.mode,
      brainType: this.opts.brainType,
      model,
      userMessage: this.userMessage,
      startedAt: formatBeijing(this.startedAtMs),
      endedAt: formatBeijing(endedAtMs),
      durationMs: endedAtMs - this.startedAtMs,
      outcome: this.outcome,
      skillsUsed: this.skillsUsed,
      stats: { tokensDelta, costDelta },
      steps: this.steps,
    };

    // Filename prefers the displayable username ("admin") over the internal
    // hex userId ("3e3a85bf..."), falls back to "unknown" if neither.
    const raw = (this.username && this.username.trim())
      ? this.username
      : (this.opts.userId && this.opts.userId.trim() ? this.opts.userId : "unknown");
    const user = raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32);
    const stamp = formatBeijingFilename(this.startedAtMs); // YYYYMMDD-HHmmssSSS
    const baseName = `trace-${stamp}-${user}`;
    // If two traces fall in the exact same millisecond, append -002, -003, ...
    let fname = `${baseName}.json`;
    let suffix = 1;
    while (fs.existsSync(path.join(this.opts.traceDir, fname))) {
      suffix += 1;
      fname = `${baseName}-${String(suffix).padStart(3, "0")}.json`;
    }
    const fpath = path.join(this.opts.traceDir, fname);
    const bodyJson = JSON.stringify(trace, null, 2);
    let written: string | null = null;
    try {
      fs.writeFileSync(fpath, bodyJson, "utf-8");
      written = fpath;
    } catch (err) {
      console.warn(`[trace-recorder] write failed: ${fpath}`, err);
    }

    // Persist to SQLite (same JSON body, plus indexed columns for API queries).
    // Best-effort: DB failures must not break the trace contract on disk.
    if (this.opts.store) {
      try {
        // File basename (without .json) is a human-friendly, unique-per-flush id.
        const traceId = fname.replace(/\.json$/, "");
        const toolCallCount = this.steps.reduce((n, s) => n + (s.kind === "tool_call" ? 1 : 0), 0);
        this.opts.store.insert({
          id: traceId,
          sessionId: this.opts.sessionId,
          promptIdx: this.promptIdx,
          userId: this.opts.userId ?? null,
          username: this.username ?? null,
          mode: this.opts.mode,
          brainType: this.opts.brainType ?? null,
          modelName: model?.id ?? null,
          userMessage: this.userMessage,
          outcome: this.outcome,
          startedAt: formatBeijing(this.startedAtMs),
          endedAt: formatBeijing(endedAtMs),
          durationMs: endedAtMs - this.startedAtMs,
          stepCount: this.steps.length,
          toolCallCount,
          tokensTotal: tokensDelta?.total ?? null,
          costUsd: costDelta ?? null,
          schemaVersion: trace.schemaVersion,
          bodyJson,
        });
      } catch (err) {
        console.warn(`[trace-recorder] DB insert failed:`, err);
      }
    }

    return written;
  }
}

// ── Helpers ────────────────────────────────────────────

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000; // UTC+8

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function pad3(n: number): string {
  return n < 10 ? `00${n}` : n < 100 ? `0${n}` : String(n);
}

/**
 * Format a Unix ms timestamp as Beijing time (UTC+8).
 * Output: "YYYY-MM-DD HH:mm:ss.SSS" — no timezone suffix since all values are fixed to +08:00.
 */
function formatBeijing(ms: number): string {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}.${pad3(d.getUTCMilliseconds())}`
  );
}

/** Filename-safe variant: YYYYMMDD-HH-mm-ss (no milliseconds; same-second collisions handled by suffix). */
function formatBeijingFilename(ms: number): string {
  const d = new Date(ms + BEIJING_OFFSET_MS);
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-` +
    `${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}-${pad2(d.getUTCSeconds())}`
  );
}

function pendingKey(name: string, toolCallId: string | undefined): string {
  return toolCallId ? `${name}#${toolCallId}` : name;
}

/**
 * Parse a filesystem path pointing at a SKILL.md file into { skillName, scope }.
 * Handles the siclaw skill layout:
 *   .../skills/core/<name>/SKILL.md                → scope=core,      name=<name>
 *   .../skills/extension/<name>/SKILL.md           → scope=extension, name=<name>
 *   .../skills/global/<name>/SKILL.md              → scope=global,    name=<name>
 *   .../skills/personal/<name>/SKILL.md            → scope=personal,  name=<name>
 *   .../skills/user/<userId>/<name>/SKILL.md       → scope=user,      name=<name>
 * Returns null if the path does not look like a siclaw SKILL.md reference.
 */
function parseSkillPath(p: string): { skillName: string; scope: string } | null {
  if (!p || !/\/SKILL\.md$/i.test(p)) return null;
  const idx = p.lastIndexOf("/skills/");
  if (idx < 0) return null;
  const tail = p.slice(idx + "/skills/".length).replace(/\/SKILL\.md$/i, "");
  const segs = tail.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  // user/<userId>/<name> → 3 segments
  if (segs[0] === "user" && segs.length >= 3) {
    return { scope: "user", skillName: segs[segs.length - 1] };
  }
  // <scope>/<name> → 2 segments
  return { scope: segs[0], skillName: segs[segs.length - 1] };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .filter((c) => c.type === "text")
    .map((c) => (c.text as string | undefined) ?? "")
    .join("");
}

function safeCall<T>(fn: (() => T | undefined) | undefined): T | undefined {
  if (!fn) return undefined;
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// ── Env-var gated factory ──────────────────────────────

/**
 * Create a TraceRecorder unless SICLAW_TRACE_DISABLE=1.
 * Default trace dir: <cwd>/.siclaw/traces (override with SICLAW_TRACE_DIR).
 */
export function maybeCreateTraceRecorder(
  opts: Omit<TraceRecorderOpts, "traceDir"> & { traceDir?: string },
): TraceRecorder | null {
  if (process.env.SICLAW_TRACE_DISABLE === "1") return null;
  const traceDir =
    opts.traceDir ??
    process.env.SICLAW_TRACE_DIR ??
    path.join(process.cwd(), ".siclaw", "traces");
  // Auto-attach the process-level trace store unless caller already supplied one.
  const store = opts.store !== undefined ? opts.store : getTraceStore();
  return new TraceRecorder({ ...opts, traceDir, store });
}
