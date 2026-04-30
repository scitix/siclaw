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
import { buildTraceSummary, buildTraceEasy } from "./trace-summary.js";
import { classifyInjectedPrompt, INJECTED_PROMPT_KINDS, type InjectedPromptKind } from "./injected-prompt-kinds.js";
import type { DpStateRef } from "./types.js";

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
  /** Readonly view of the session's DP workflow state. Sampled at flush() to
   *  populate trace.dpStatusEnd. null/undefined → recorded as "idle". */
  dpStateRef?: DpStateRef;
}

/**
 * `isInjectedPrompt` is an enum (InjectedPromptKind), NOT a boolean.
 * See src/core/injected-prompt-kinds.ts for the kind list, matcher registry,
 * and classification rule. Add new injection types there, not here.
 *
 * Quick recap of the contract:
 *   - kind === "none"  → plain user prompt (the `[Deep Investigation]` wrapper
 *                        is a mode flag, NOT canned content, so it stays "none").
 *   - any other kind   → the prompt carries machine-generated content the user
 *                        did not type (UI button click, synthetic system capsule…).
 */
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
  /** Computed once at startTrace(): which (if any) injection class produced
   *  this prompt. Stored alongside the trace for analytics filtering. Default
   *  "none" — overwritten by classifyInjectedPrompt() at startTrace(). */
  private isInjectedPrompt: InjectedPromptKind = INJECTED_PROMPT_KINDS.NONE;
  /** Business id (trace_key) assigned at startTrace() — reused across the
   *  in-flight stub insert and the final flush upsert so they refer to the
   *  same row. Format matches the filename stem: `trace-YYYYMMDD-HH-MM-SS-<user>`. */
  private currentTraceKey: string | null = null;
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
  async beginPrompt(userMessage: string): Promise<void> {
    this.explicitMode = true;
    await this.startTrace(userMessage);
  }

  /** Shared trace-reset logic used by both explicit beginPrompt() and the
   *  internal auto-detect path (agent_start in auto mode). */
  private async startTrace(userMessage: string): Promise<void> {
    if (this.active) await this.flush();
    this.active = true;
    this.promptIdx += 1;
    this.userMessage = userMessage;
    this.isInjectedPrompt = classifyInjectedPrompt(userMessage);
    this.startedAtMs = Date.now();
    this.steps = [];
    this.skillsUsed = [];
    this.pendingSkillMeta = [];
    this.pendingTools.clear();
    this.outcome = "completed";
    this.prevStats = safeCall(this.opts.getSessionStats);
    this.currentTraceKey = this.computeTraceKey();
    // Two-phase persistence: stub the row NOW, so even if the prompt later
    // hangs (e.g. propose_hypotheses infinite loop) the injected prompt /
    // session / DP-status-at-start are preserved in the DB. flush() will
    // later UPSERT the same trace_key with complete data.
    await this.persistInFlightStub();
  }

  /** Finalize the current trace. Usually auto-invoked on agent_end. */
  async endPrompt(outcome?: "completed" | "error"): Promise<string | null> {
    if (!this.active) return null;
    if (outcome) this.outcome = outcome;
    return await this.flush();
  }

  /**
   * One-shot record for a "steer" message — the frontend sends these via
   * `chat.steer` RPC → `POST /api/sessions/:id/steer` when the agent is
   * mid-run (DP checkpoint chips like Proceed / Refine / Summarize, the
   * Dig deeper chip, feedback injections, etc.).
   *
   * Why this method exists (why not reuse beginPrompt/flush):
   *   - A steer has no paired "end" event (it's inserted into the currently
   *     running agent, not a new agent cycle). begin+flush's two-phase model
   *     doesn't fit.
   *   - Calling beginPrompt() mid-run would reset `this.active` and prematurely
   *     flush the main in-flight trace (cutting it in half).
   *
   * So we write a fully-formed standalone row atomically, with its own unique
   * trace_key (suffixed `-steer-<rand>` to guarantee no collision with main
   * traces). `outcome='completed'` and `duration_ms=0` because the steer itself
   * is instantaneous from the user's perspective; what happens afterwards
   * (resumed agent work) lands in the main trace's final flush.
   */
  async recordSteerEvent(text: string): Promise<void> {
    if (!this.opts.store) return;
    try {
      const nowMs = Date.now();
      const raw = (this.username && this.username.trim())
        ? this.username
        : (this.opts.userId && this.opts.userId.trim() ? this.opts.userId : "unknown");
      const user = raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32);
      const stamp = formatBeijingFilename(nowMs);
      const rand = Math.random().toString(36).slice(2, 8);
      const traceKey = `trace-${stamp}-${user}-steer-${rand}`;
      const startedAtStr = formatBeijing(nowMs);
      const model = safeCall(this.opts.getModel);
      const dpStatus = this.opts.dpStateRef?.active ? "active" : "idle";
      const injected = classifyInjectedPrompt(text);
      const body = {
        schemaVersion: "1.2",
        kind: "steer",   // distinguishes from "prompt" traces in the body
        sessionId: this.opts.sessionId,
        username: this.username,
        userId: this.opts.userId,
        mode: this.opts.mode,
        brainType: this.opts.brainType,
        model,
        userMessage: text,
        isInjectedPrompt: injected,
        dpStatusEnd: dpStatus,
        startedAt: startedAtStr,
        endedAt: startedAtStr,
        durationMs: 0,
        outcome: "completed",
        skillsUsed: [],
        stats: {},
        steps: [],
      };
      await this.opts.store.upsert({
        id: traceKey,
        sessionId: this.opts.sessionId,
        promptIdx: 0,        // steer is not a top-level prompt — 0 signals "n/a"
        userId: this.opts.userId ?? null,
        username: this.username ?? null,
        mode: this.opts.mode,
        brainType: this.opts.brainType ?? null,
        modelName: model?.id ?? null,
        userMessage: text,
        outcome: "completed",
        startedAt: startedAtStr,
        endedAt: startedAtStr,
        durationMs: 0,
        stepCount: 0,
        toolCallCount: 0,
        tokensTotal: null,
        costUsd: null,
        schemaVersion: "1.2",
        isInjectedPrompt: injected,
        dpStatusEnd: dpStatus,
        bodyJson: JSON.stringify(body, null, 2),
      });
    } catch (err) {
      console.warn(`[trace-recorder] recordSteerEvent failed:`, err);
    }
  }

  /** Release all resources. Writes any in-flight trace first. */
  async close(): Promise<void> {
    if (this.active) await this.flush();
    if (this.unsubscribeDiag) {
      this.unsubscribeDiag();
      this.unsubscribeDiag = null;
    }
  }

  /**
   * Derive the trace_key (= filename stem) from username + startedAtMs.
   * Called once per prompt in startTrace(). Reused later by persistInFlightStub()
   * and flush() so the stub and final rows hit the same row via UPSERT.
   *
   * NOTE: collision-suffix (`-002`, `-003`) is decided at flush() time based on
   * filesystem existence — at startTrace() we don't yet know about disk state.
   * In practice collisions only happen when two traces share the same second,
   * which is rare; flush() will write to a suffixed *file* when it hits one,
   * while the DB row still uses the un-suffixed trace_key. That is an accepted
   * minor inconsistency in exchange for being able to write the stub upfront.
   */
  private computeTraceKey(): string {
    const raw = (this.username && this.username.trim())
      ? this.username
      : (this.opts.userId && this.opts.userId.trim() ? this.opts.userId : "unknown");
    const user = raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 32);
    const stamp = formatBeijingFilename(this.startedAtMs);
    return `trace-${stamp}-${user}`;
  }

  /**
   * Write a minimal "in-progress" row to the DB immediately after the prompt
   * boundary opens. Guarantees that a stuck prompt still leaves evidence:
   *   - the injected-prompt text + classification
   *   - session / user / model metadata
   *   - DP status at the moment the prompt arrived
   *
   * Best-effort: any error is warned but does not break the live trace flow.
   */
  private async persistInFlightStub(): Promise<void> {
    if (!this.opts.store || !this.currentTraceKey) return;
    try {
      const startedAtStr = formatBeijing(this.startedAtMs);
      const model = safeCall(this.opts.getModel);
      const dpStatus = this.opts.dpStateRef?.active ? "active" : "idle";
      const stubBody = {
        schemaVersion: "1.2",
        sessionId: this.opts.sessionId,
        username: this.username,
        userId: this.opts.userId,
        mode: this.opts.mode,
        brainType: this.opts.brainType,
        model,
        userMessage: this.userMessage,
        isInjectedPrompt: this.isInjectedPrompt,
        dpStatusEnd: dpStatus,
        startedAt: startedAtStr,
        outcome: "in_progress",
        pending: true,
        note: "Partial trace — the prompt has not yet finished. A completed row will overwrite this via UPSERT once endPrompt() fires. If this note survives, the agent hung or the process died mid-prompt.",
      };
      await this.opts.store.upsert({
        id: this.currentTraceKey,
        sessionId: this.opts.sessionId,
        promptIdx: this.promptIdx,
        userId: this.opts.userId ?? null,
        username: this.username ?? null,
        mode: this.opts.mode,
        brainType: this.opts.brainType ?? null,
        modelName: model?.id ?? null,
        userMessage: this.userMessage,
        outcome: "in_progress",
        startedAt: startedAtStr,
        endedAt: startedAtStr,      // placeholder — flush() overwrites
        durationMs: 0,              // placeholder — flush() overwrites
        stepCount: 0,
        toolCallCount: 0,
        tokensTotal: null,
        costUsd: null,
        schemaVersion: "1.2",
        isInjectedPrompt: this.isInjectedPrompt,
        dpStatusEnd: dpStatus,
        bodyJson: JSON.stringify(stubBody, null, 2),
      });
    } catch (err) {
      console.warn(`[trace-recorder] in-flight stub upsert failed:`, err);
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
    //
    // Fire-and-forget the async startTrace/flush from sync event handlers:
    // brain.subscribe() callbacks don't await, and we don't want to block
    // event processing on DB writes. Unhandled rejections must be caught.
    if (type === "agent_start") {
      if (!this.explicitMode) {
        this.startTrace(this.lastUserMessageBuffered).catch((err) =>
          console.warn("[trace-recorder] auto startTrace failed:", err));
      }
      return;
    }

    if (!this.active) return;

    switch (type) {
      case "agent_end":
        // In EXPLICIT mode, external endPrompt drives the flush; ignore.
        if (this.explicitMode) return;
        this.flush().catch((err) =>
          console.warn("[trace-recorder] auto flush failed:", err));
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
        let output = Array.isArray(result?.content)
          ? (result!.content as Array<Record<string, unknown>>)
              .filter((c) => c.type === "text")
              .map((c) => (c.text as string | undefined) ?? "")
              .join("")
          : "";
        const details = result?.details as Record<string, unknown> | undefined;
        const isError = Boolean(ev.isError || details?.error || details?.blocked);

        // Empty-output annotation: trace consumers should never see an
        // ambiguous `output: ""`. If the tool produced no text content, fill
        // in a tagged reason so the why is preserved alongside the why-not.
        // Fixed prefixes (`[ok-empty]` / `[error]`) make downstream filtering
        // unambiguous (`output LIKE '[error]%'`).
        if (!output) {
          output = isError
            ? formatErrorEmpty(result, details, ev)
            : "[ok-empty] 命令执行成功，但无任何 stdout/stderr 输出";
        }

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

  private async flush(): Promise<string | null> {
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

    // Sample DP status at the exact moment the prompt finishes — this is the
    // authoritative "where did this prompt leave the workflow" signal.
    // DP refactor (2026-04-24): the old enum status was replaced by `active: boolean`.
    // Map active=true → "active", active=false → "idle" so dp_status_end stays a stable
    // string column readable by downstream tooling.
    const dpStatusEnd: string = this.opts.dpStateRef?.active ? "active" : "idle";

    const trace = {
      // Body schema bumped 1.1 → 1.2 for the new top-level fields
      // (isInjectedPrompt, dpStatusEnd). Readers pinned to older JSON can
      // detect & upgrade via this field.
      schemaVersion: "1.2",
      sessionId: this.opts.sessionId,
      username: this.username,
      userId: this.opts.userId,
      mode: this.opts.mode,
      brainType: this.opts.brainType,
      model,
      userMessage: this.userMessage,
      isInjectedPrompt: this.isInjectedPrompt,
      dpStatusEnd,
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

    // Build the chronological summary — pure projection of `steps[]`, no LLM.
    // Best-effort: a malformed step must not break trace persistence.
    let traceSummary: string | null = null;
    let traceSummaryJson: string | null = null;
    let traceEasy: string | null = null;
    try {
      const summary = buildTraceSummary({
        userMessage: this.userMessage,
        steps: this.steps,
      });
      traceSummary = summary.line;
      traceSummaryJson = JSON.stringify(summary.events);
    } catch (err) {
      console.warn("[trace-recorder] buildTraceSummary failed (non-fatal):", err);
    }
    try {
      traceEasy = buildTraceEasy({
        userMessage: this.userMessage,
        steps: this.steps,
      }).line;
    } catch (err) {
      console.warn("[trace-recorder] buildTraceEasy failed (non-fatal):", err);
    }

    // Persist to SQLite (same JSON body, plus indexed columns for API queries).
    // UPSERT overwrites the in-flight stub row written by startTrace(). Best-
    // effort: DB failures must not break the trace contract on disk.
    if (this.opts.store) {
      try {
        // Re-use the trace_key assigned at startTrace() to hit the same row
        // written by persistInFlightStub(). If the filesystem collision path
        // in `fname` ended up with a -NNN suffix (same-second clash), prefer
        // the already-stamped currentTraceKey — the *DB* row is keyed there.
        const traceId = this.currentTraceKey ?? fname.replace(/\.json$/, "");
        const toolCallCount = this.steps.reduce((n, s) => n + (s.kind === "tool_call" ? 1 : 0), 0);
        await this.opts.store.upsert({
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
          isInjectedPrompt: this.isInjectedPrompt,
          dpStatusEnd,
          traceSummary,
          traceSummaryJson,
          traceEasy,
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
 * Synthesize a tagged reason string when an errored tool call produced no
 * text output. Always returns a non-empty `[error] …` line so trace consumers
 * can filter ambiguous empty outputs by prefix.
 *
 * Priority order is intentional: `blocked` (security policy) is most specific,
 * `details.reason` is an explicit author-supplied tag, then exitCode/errorMessage,
 * then result-shape diagnostics, then a final fallback.
 */
function formatErrorEmpty(
  result: Record<string, unknown> | undefined,
  details: Record<string, unknown> | undefined,
  ev: Record<string, unknown>,
): string {
  if (details?.blocked) {
    const reason = (details.reason as string | undefined) ?? "n/a";
    return `[error] 命令被安全策略拦截 reason=${reason}`;
  }
  if (details?.error && details.reason) {
    const exit = details.exitCode === undefined ? "n/a" : String(details.exitCode);
    return `[error] ${String(details.reason)} exitCode=${exit}`;
  }
  if (details?.exitCode !== undefined) {
    return `[error] 命令异常退出 exitCode=${String(details.exitCode)}`;
  }
  const errMsg = (ev.errorMessage as string | undefined) ?? (ev.error as string | undefined);
  if (typeof errMsg === "string" && errMsg) {
    return `[error] ${errMsg}`;
  }
  if (!result || typeof result !== "object") {
    return "[error] 工具未返回 result 对象";
  }
  if (!Array.isArray(result.content)) {
    return "[error] 工具未返回 content（result.content 非数组）";
  }
  const arr = result.content as Array<Record<string, unknown>>;
  if (arr.length === 0) {
    return "[error] 工具未返回 content（content 数组为空）";
  }
  const types = arr.map((c) => String(c.type ?? "?")).join(",");
  if (!arr.some((c) => c.type === "text")) {
    return `[error] content 仅含非文本类型: ${types}`;
  }
  return "[error] 工具标记错误但未提供原因";
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
 *
 * Async because the default store factory (`getTraceStore`) performs MySQL
 * schema init on first use. Callers typically `await` this once at session
 * setup, so the cost is amortized.
 */
export async function maybeCreateTraceRecorder(
  opts: Omit<TraceRecorderOpts, "traceDir"> & { traceDir?: string },
): Promise<TraceRecorder | null> {
  if (process.env.SICLAW_TRACE_DISABLE === "1") return null;
  const traceDir =
    opts.traceDir ??
    process.env.SICLAW_TRACE_DIR ??
    path.join(process.cwd(), ".siclaw", "traces");
  // Auto-attach the process-level trace store unless caller already supplied one.
  const store = opts.store !== undefined ? opts.store : await getTraceStore();
  return new TraceRecorder({ ...opts, traceDir, store });
}
