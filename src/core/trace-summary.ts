/**
 * Trace summary — deterministic, time-ordered projection of a finished trace.
 *
 * Goal: produce a compact "流水账" (chronological log) suitable for the
 * algorithms team to consume directly, without parsing the full JSON body.
 *
 * Hard contracts:
 *   1. Pure projection of `steps[]` order. No reordering, no deduplication
 *      across event types. Implementation MUST NOT call .sort() / .reverse().
 *   2. No LLM involvement — this file MUST NOT import any model SDK. Any
 *      future enrichment that would require network calls belongs elsewhere.
 *   3. Only five event categories appear in the output: user / steer / tool /
 *      ai / elided. All `kind: turn_*` / `auto_*` / `model_error` / timestamp
 *      / model-config metadata is dropped — see CLAUDE.md design doc.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/** Recorder Step shape. Re-declared locally so this module stays decoupled
 *  from trace-recorder internals (avoids a circular import when the recorder
 *  imports from here). Only fields read by the projection are listed. */
export interface SummaryStepInput {
  kind: "tool_call" | "message" | "turn_start" | "turn_end" | "auto_compaction" | "auto_retry" | "model_error";
  // tool_call
  name?: string;
  args?: unknown;
  output?: string;
  isError?: boolean;
  skill?: { skillName: string; scope?: string; via?: string; scriptName?: string };
  // message
  role?: string;
  text?: string;
}

export type SummaryEvent =
  | { t: "user"; text: string }
  | { t: "steer"; text: string }
  | { t: "tool"; name: string; input?: string | Record<string, unknown>; output?: string; isError?: boolean; skill?: string }
  | { t: "ai"; text: string; final?: boolean };

export interface BuildTraceSummaryInput {
  userMessage: string;
  steps: ReadonlyArray<SummaryStepInput>;
}

export interface TraceSummary {
  /** Single-string flow, human-readable, grep-friendly. */
  line: string;
  /** Structured array, time-ordered, JSON-friendly. */
  events: SummaryEvent[];
}

// ── Tool-arg formatters ────────────────────────────────────────────────────
//
// No length limits are enforced anywhere in this module. The summary is
// already a selective projection of the trace (only user/ai/tool events are
// kept; all metadata and scaffolding events are dropped), so the per-segment
// content is preserved verbatim. Storage columns are TEXT (SQLite, ~1GB) and
// MEDIUMTEXT (MySQL, 16MB) — comfortably larger than any plausible summary.

/**
 * Per-tool formatter. Returns either a single-line command string (preferred
 * for shell-like tools) or a small key-value object (for path-based tools).
 * The default formatter falls back to a noise-stripped shallow copy.
 */
type ArgFormatter = (args: Record<string, unknown>) => string | Record<string, unknown>;

const FORMATTERS: Record<string, ArgFormatter> = {
  "restricted-bash": (a) => stringy(a.command ?? a.cmd ?? a.script ?? ""),
  "bash": (a) => stringy(a.command ?? a.cmd ?? ""),
  "shell": (a) => stringy(a.command ?? a.cmd ?? ""),
  "script-exec": (a) => {
    const name = stringy(a.scriptName ?? a.script ?? "");
    const argv = Array.isArray(a.args) ? (a.args as unknown[]).map(stringy).join(" ") : "";
    return argv ? `${name} ${argv}` : name;
  },
  "local_script": (a) => {
    const skill = stringy(a.skill ?? a.skillName ?? "");
    const script = stringy(a.script ?? a.scriptName ?? "");
    const head = skill && script ? `${skill}/${script}` : (skill || script);
    const argv = Array.isArray(a.args) ? (a.args as unknown[]).map(stringy).join(" ") : "";
    return argv ? `${head} ${argv}` : head;
  },
  "read": (a) => compactObject({ path: a.path ?? a.file_path ?? a.filePath, range: a.range }),
  "Read": (a) => compactObject({ path: a.path ?? a.file_path ?? a.filePath, range: a.range }),
  "edit": (a) => compactObject({ path: a.path ?? a.file_path ?? a.filePath }),
  "Edit": (a) => compactObject({ path: a.path ?? a.file_path ?? a.filePath }),
  "write": (a) => compactObject({ path: a.path ?? a.file_path ?? a.filePath, bytes: typeof a.content === "string" ? (a.content as string).length : undefined }),
  "Write": (a) => compactObject({ path: a.path ?? a.file_path ?? a.filePath, bytes: typeof a.content === "string" ? (a.content as string).length : undefined }),
};

const NOISY_KEYS = new Set([
  "_internal", "correlationId", "traceId", "requestId",
  "sessionId", "userId", "username", "callId",
]);

function defaultFormatter(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(args)) {
    if (NOISY_KEYS.has(k)) continue;
    if (k.startsWith("_")) continue;
    if (n >= 8) break;
    out[k] = summarizeValue(v);
    n += 1;
  }
  return out;
}

function summarizeValue(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v;
  if (typeof v === "object") return v;
  return String(v);
}

function stringy(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return String(v);
}

function compactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}

function formatToolInput(name: string, args: unknown): string | Record<string, unknown> | undefined {
  if (args == null) return undefined;
  if (typeof args !== "object") return stringy(args);
  const fmt = FORMATTERS[name] ?? defaultFormatter;
  const out = fmt(args as Record<string, unknown>);
  if (typeof out === "string") return out || undefined;
  return Object.keys(out).length ? out : undefined;
}

// ── Core projection ────────────────────────────────────────────────────────

/**
 * Build a chronologically-ordered summary of a finished trace.
 *
 * Inputs are passed as a `ReadonlyArray<Step>` to make accidental reordering
 * caught by TypeScript. The function makes a single forward pass over `steps`
 * and never sorts or reverses.
 *
 * The first event is always `{t:"user"}` derived from `userMessage`, even if
 * empty — it pins the start of the timeline and lets the algorithms team
 * align by index across traces.
 */
export function buildTraceSummary(input: BuildTraceSummaryInput): TraceSummary {
  const events: SummaryEvent[] = [];

  // 1. Initial user input — verbatim, no truncation.
  events.push({ t: "user", text: input.userMessage ?? "" });

  // 2. Iterate steps in their original order. NEVER sort.
  for (let i = 0; i < input.steps.length; i++) {
    const s = input.steps[i];
    if (s.kind === "tool_call") {
      const name = s.name ?? "tool";
      const inputForm = formatToolInput(name, s.args);
      const output = s.output ?? "";
      const ev: SummaryEvent = {
        t: "tool",
        name,
        ...(inputForm !== undefined ? { input: inputForm } : {}),
        ...(output ? { output } : {}),
        ...(s.isError ? { isError: true } : {}),
        ...(s.skill?.skillName ? { skill: s.skill.skillName } : {}),
      };
      events.push(ev);
      continue;
    }

    if (s.kind === "message" && s.role === "assistant") {
      const text = s.text ?? "";
      // Skip empty assistant messages whose only content was tool calls — the
      // tool calls themselves appear as separate tool_call steps right after.
      if (!text) continue;
      events.push({ t: "ai", text });
      continue;
    }

    // turn_start / turn_end / auto_compaction / auto_retry / model_error are
    // dropped per design — they are scaffolding metadata, not "what happened".
  }

  // 3. Mark the last assistant text as final.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.t === "ai") {
      ev.final = true;
      break;
    }
  }

  return { events, line: renderLine(events) };
}

function renderLine(events: ReadonlyArray<SummaryEvent>): string {
  const parts: string[] = [];
  for (const ev of events) {
    parts.push(renderEvent(ev));
  }
  return parts.join("\n\n");
}

// ── trace_easy: ultra-light projection ─────────────────────────────────────
//
// Goal: an even-thinner version of buildTraceSummary so the analytics team
// can read a trace at a glance. Per spec (2026-04-30), each event keeps only:
//   - USER : the user's typed prompt
//   - AI   : the model's spoken text
//   - TOOL : `name` + `content` (= the tool's INPUT — e.g. the kubectl
//            command — not the output, since outputs can be huge and
//            "easy" means short).
// Tool output, skill scope, isError flags, lifecycle events — all dropped.

export type EasyEvent =
  | { t: "user"; text: string }
  | { t: "ai"; text: string }
  | { t: "tool"; name: string; content: string };

export interface TraceEasy {
  /** Single-string flow, human-readable. */
  line: string;
  /** Structured array, time-ordered, JSON-friendly. */
  events: EasyEvent[];
}

/**
 * Build the simplified `trace_easy` projection. Same input shape as
 * buildTraceSummary, but each tool event keeps only the invocation (input
 * args), never the output. Reuses the per-tool FORMATTERS above so a
 * `restricted-bash` call collapses to "kubectl get pods", a `Read` call
 * collapses to "{path: ...}", etc.
 */
export function buildTraceEasy(input: BuildTraceSummaryInput): TraceEasy {
  const events: EasyEvent[] = [];

  events.push({ t: "user", text: input.userMessage ?? "" });

  for (const s of input.steps) {
    if (s.kind === "tool_call") {
      const name = s.name ?? "tool";
      const inputForm = formatToolInput(name, s.args);
      events.push({
        t: "tool",
        name,
        content: stringifyToolInput(inputForm),
      });
      continue;
    }
    if (s.kind === "message" && s.role === "assistant") {
      const text = s.text ?? "";
      if (!text) continue;  // skip tool-only assistant turns
      events.push({ t: "ai", text });
      continue;
    }
    // Drop turn_*, auto_*, model_error — pure scaffolding noise.
  }

  return { events, line: renderEasyLine(events) };
}

/** Flatten formatToolInput's union return into a single short string. */
function stringifyToolInput(form: string | Record<string, unknown> | undefined): string {
  if (form === undefined) return "";
  if (typeof form === "string") return form;
  // Object form (e.g. Read → {path: ...}). Render as `k=v` pairs joined by spaces.
  const parts: string[] = [];
  for (const [k, v] of Object.entries(form)) {
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.join(" ");
}

function renderEasyLine(events: ReadonlyArray<EasyEvent>): string {
  const parts: string[] = [];
  for (const ev of events) {
    switch (ev.t) {
      case "user": parts.push(`USER: ${ev.text}`); break;
      case "ai":   parts.push(`AI: ${ev.text}`); break;
      case "tool": parts.push(ev.content ? `TOOL ${ev.name}: ${ev.content}` : `TOOL ${ev.name}`); break;
    }
  }
  return parts.join("\n\n");
}

// ── Internals ──────────────────────────────────────────────────────────────

function renderEvent(ev: SummaryEvent): string {
  switch (ev.t) {
    case "user":
      return `USER: ${ev.text}`;
    case "steer":
      return `STEER: ${ev.text}`;
    case "ai":
      return `${ev.final ? "AI(final)" : "AI"}: ${ev.text}`;
    case "tool": {
      const head = ev.skill ? `TOOL ${ev.name}(skill:${ev.skill})${ev.isError ? " !" : ""}` : `TOOL ${ev.name}${ev.isError ? " !" : ""}`;
      const lines: string[] = [head];
      if (ev.input !== undefined) {
        if (typeof ev.input === "string") {
          lines.push(`  $ ${ev.input}`);
        } else {
          for (const [k, v] of Object.entries(ev.input)) {
            lines.push(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
          }
        }
      }
      if (ev.output) {
        for (const ln of ev.output.split("\n")) {
          lines.push(`  > ${ln}`);
        }
      }
      return lines.join("\n");
    }
  }
}
