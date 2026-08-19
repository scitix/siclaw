/**
 * Project a field out of a target's JSON output, in the AgentBox.
 *
 * Why this exists: the diagnostic commands that matter most on a node emit JSON (`crictl inspect`,
 * `nvidia-smi -q -x`, `ip -j`), and `jq` is usually NOT installed there — the whitelist admits it, but
 * a node either has it or does not. Without a way to project, the agent has to pull the whole document
 * back and read it, which burns context and gets truncated exactly when the document is large.
 *
 * Deliberately NOT jq, and deliberately not a subprocess:
 *
 *   - jq would mean handing agent-authored program text to a process running as `agentbox` — the user
 *     that OWNS the credentials — and jq's `$ENV` reads the environment. A projection needs none of
 *     that power.
 *   - This evaluator has no expression language at all: no functions, no filters, no arithmetic, no
 *     I/O. It walks a parsed value along a path. There is nothing to sandbox because there is nothing
 *     that can reach outside the document.
 *
 * Path grammar (the whole of it):
 *
 *   .a.b          field access
 *   .a[0]         array index (negative counts from the end)
 *   .a[]          map the rest of the path over every element, flattening one level
 *   .a[*]         same as []
 *   .["odd key"]  quoted field, for names the bare form cannot express
 *   .             the whole document
 */

import { REDACTION_NOTICE } from "./output-sanitizer.js";

/** One step of a parsed path. */
type Step =
  | { kind: "field"; name: string }
  | { kind: "index"; index: number }
  | { kind: "each" };

const MAX_PATH_STEPS = 64;

export interface ProjectionFailure {
  error: string;
}

export interface ProjectionSuccess {
  /** Rendered projection, ready to hand to the caller. */
  text: string;
  /** False when the path resolved to nothing — reported explicitly so an empty result is not read as an empty field. */
  matched: boolean;
}

export type ProjectionOutcome = ProjectionSuccess | ProjectionFailure;

export function isProjectionFailure(o: ProjectionOutcome): o is ProjectionFailure {
  return "error" in o;
}

/**
 * Parse a path into steps. Returns an error string for anything the grammar above does not cover —
 * silently ignoring a malformed path would project the wrong thing and look like a real answer.
 */
export function parseJsonPath(path: string): Step[] | { error: string } {
  const trimmed = path.trim();
  if (!trimmed || trimmed === ".") return [];

  const steps: Step[] = [];
  let i = 0;
  // A leading dot is optional: ".a.b" and "a.b" mean the same thing.
  if (trimmed[i] === ".") i++;

  while (i < trimmed.length) {
    if (steps.length >= MAX_PATH_STEPS) {
      return { error: `json_path has more than ${MAX_PATH_STEPS} steps; that is not a projection.` };
    }

    if (trimmed[i] === "[") {
      const close = trimmed.indexOf("]", i);
      if (close < 0) return { error: `json_path "${path}" has an unclosed "[".` };
      const inner = trimmed.slice(i + 1, close).trim();
      i = close + 1;

      if (inner === "" || inner === "*") {
        steps.push({ kind: "each" });
      } else if (/^-?\d+$/.test(inner)) {
        steps.push({ kind: "index", index: Number(inner) });
      } else if (/^"(.*)"$/.test(inner) || /^'(.*)'$/.test(inner)) {
        steps.push({ kind: "field", name: inner.slice(1, -1) });
      } else {
        return {
          error: `json_path "${path}": "[${inner}]" is not an index, [] or a quoted field name. `
            + "This is a projection path, not a filter expression — there is no support for conditions.",
        };
      }
      // A `.` may follow a bracket (".a[0].b"); consume it.
      if (trimmed[i] === ".") i++;
      continue;
    }

    const match = /^[A-Za-z0-9_@$-]+/.exec(trimmed.slice(i));
    if (!match) {
      return {
        error: `json_path "${path}": unexpected "${trimmed[i]}" at position ${i}. `
          + 'Use .field, [0], [] or .["quoted name"].',
      };
    }
    steps.push({ kind: "field", name: match[0] });
    i += match[0].length;
    if (trimmed[i] === ".") i++;
  }

  return steps;
}

/** Walk one value along the steps, collecting every value the path resolves to. */
function walk(value: unknown, steps: Step[]): unknown[] {
  if (steps.length === 0) return value === undefined ? [] : [value];
  const [step, ...rest] = steps;

  if (step.kind === "each") {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => walk(item, rest));
  }

  if (step.kind === "index") {
    if (!Array.isArray(value)) return [];
    const idx = step.index < 0 ? value.length + step.index : step.index;
    return walk(value[idx], rest);
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return walk((value as Record<string, unknown>)[step.name], rest);
}

/** Render a projection so a scalar reads as a scalar — the point is to spend less context, not more. */
function render(results: unknown[]): string {
  if (results.length === 1) {
    const only = results[0];
    if (only === null) return "null";
    if (typeof only !== "object") return String(only);
    return JSON.stringify(only, null, 2);
  }
  // A list of scalars is far more readable (and smaller) one per line than as a JSON array.
  if (results.every((r) => r === null || typeof r !== "object")) {
    return results.map((r) => (r === null ? "null" : String(r))).join("\n");
  }
  return JSON.stringify(results, null, 2);
}

const NOT_JSON = Symbol("not-json");

/**
 * Parse a body that is JSON plus, possibly, trailing prose.
 *
 * A structural sanitizer appends `REDACTION_NOTICE` to what it redacted, which makes its own output
 * un-parseable — so `json_path` would fail on exactly the structured commands it exists for
 * (`crictl inspect` above all). Rather than teach the projector about one notice, it parses the
 * JSON span and ignores what follows.
 *
 * The span is the first opening brace/bracket to the last closing one, so this only rescues a
 * complete document with something appended. A genuinely malformed or truncated body still fails,
 * which is the answer the caller needs.
 */
function parseJsonBody(body: string): unknown | typeof NOT_JSON {
  try {
    return JSON.parse(body);
  } catch { /* fall through to the span attempt */ }

  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"));
  if (start < 0 || end <= start) return NOT_JSON;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return NOT_JSON;
  }
}

/**
 * Apply `path` to `body`.
 *
 * `body` must already have been through the output sanitizer: projecting first would drop the shape a
 * structural sanitizer relies on (crictl's `info.config.envs`, for one), and could surface a value the
 * sanitizer would have redacted.
 */
export function projectJson(body: string, path: string): ProjectionOutcome {
  const steps = parseJsonPath(path);
  if ("error" in steps) return steps;

  const parsed = parseJsonBody(body);
  if (parsed === NOT_JSON) {
    return {
      error: "json_path was given, but the output is not JSON — nothing was projected. "
        + "Either the command does not emit JSON (add its own JSON flag, e.g. -o json), it failed "
        + "(see the exit class and STDERR), or the output was suppressed by sanitization.",
    };
  }

  // A projection must not launder away the fact that the body was redacted: the sanitizer's notice is
  // part of the answer, and dropping it would present edited content as if it were verbatim.
  const notice = body.includes(REDACTION_NOTICE.trim()) ? REDACTION_NOTICE : "";

  const results = walk(parsed, steps);
  if (results.length === 0) {
    return {
      text: `json_path "${path}" matched nothing in the output. The document parsed as JSON, so the `
        + "path does not describe it — project a shorter prefix of the path to see the shape." + notice,
      matched: false,
    };
  }
  return { text: render(results) + notice, matched: true };
}

/**
 * The `project` hook for postExecSecurity when json_path is set. Shared by every exec tool so the
 * failure wording cannot drift between them.
 *
 * Returns a message instead of throwing on a bad path or non-JSON output: the projection is a
 * convenience over the command's result, and losing the result because the path was wrong would be a
 * worse outcome than saying so. A failure keeps a bounded head of the body, so the shape is still
 * visible and the caller can correct the path without re-running the command.
 */
export function jsonPathProjector(jsonPath: string | undefined) {
  if (!jsonPath) return undefined;
  return (sanitized: string): string => {
    const outcome = projectJson(sanitized, jsonPath);
    if (isProjectionFailure(outcome)) {
      return `${outcome.error}\n\n--- first 2000 chars of the unprojected output ---\n${sanitized.slice(0, 2000)}`;
    }
    return outcome.text;
  };
}
