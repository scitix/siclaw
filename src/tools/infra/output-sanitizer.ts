/**
 * Output sanitization framework — post-execution content review.
 *
 * Complements the existing 6-pass pre-execution validation pipeline
 * (validateCommand) with post-execution output sanitization.
 *
 * Sensitive resource handling (Secret, ConfigMap, Pod) is done entirely
 * via post-execution sanitization — no pre-execution blocking.
 * For -o json: structural sanitization via sanitizeJSON.
 * For all other formats (yaml, describe, jsonpath, etc.): line-level
 * pattern matching via redactSensitiveContent.
 */

import {
  detectSensitiveResource,
  kubectlSubcommand,
  crictlSubcommand,
  getOutputFormat,
  sanitizeJSON,
  redactSensitiveContent,
  REDACTION_NOTICE,
  SENSITIVE_ENV_NAME_PATTERNS,
  SENSITIVE_VALUE_PATTERNS,
  type SensitiveResourceType,
} from "./kubectl-sanitize.js";

// The line-level redactor lives in kubectl-sanitize.ts — the structural
// sanitizers there need it for ConfigMap entries that hold a whole config file.
// Re-exported here because this module is its public entry point.
export { redactSensitiveContent, REDACTION_NOTICE };

// ── Types ────────────────────────────────────────────────────────────

/**
 * `lineSafe` marks sanitizers that operate per complete line (split("\n") → map → join),
 * so they can be applied incrementally to streamed output (background bash) without a
 * cross-line leak. Structural sanitizers (JSON) need the whole document and are NOT
 * line-safe — background bash rejects commands resolving to such an action.
 */
export type OutputAction = {
  type: "sanitize";
  sanitize: (output: string) => string;
  lineSafe: boolean;
};

/** Rule function: analyze user command args, return action or null */
export type OutputRuleFn = (args: string[]) => OutputAction | null;

// ── Static rule table ────────────────────────────────────────────────

const OUTPUT_RULES: Record<string, OutputRuleFn> = {};

// ── Public API ───────────────────────────────────────────────────────

/**
 * Pre-execution analysis: find matching rule for the command.
 *
 * @param binary - User command binary name (e.g. "kubectl", "env")
 * @param args - User command args array (parsed from user's original command,
 *               NOT the nsenter/kubectl-exec wrapper for node-exec/pod-exec)
 * @returns OutputAction if sanitization needed, null otherwise
 */
export function analyzeOutput(
  binary: string,
  args: string[],
): OutputAction | null {
  const rule = OUTPUT_RULES[binary];
  if (!rule) return null;
  return rule(args);
}

/**
 * Post-execution sanitization: apply the sanitize function from the action.
 * Returns original output unchanged when action is null.
 */
export function applySanitizer(
  output: string,
  action: OutputAction | null,
): string {
  if (!action) return output;
  return action.sanitize(output);
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Build sanitize function for kubectl -o json output (structural sanitization) */
function makeKubectlJsonSanitizer(
  resource: SensitiveResourceType,
): (output: string) => string {
  return (output: string) => sanitizeJSON(output, resource);
}

// ── kubectl rules ────────────────────────────────────────────────────

OUTPUT_RULES["kubectl"] = (args) => {
  // Shared with detectSensitiveResource so the two cannot disagree about what a command says.
  const sub = kubectlSubcommand(args);

  // describe: sanitize configmap/pod output; secret describe is safe (shows byte counts only)
  if (sub === "describe") {
    const resource = detectSensitiveResource(args);
    if (resource && resource !== "secret") {
      return { type: "sanitize", sanitize: redactSensitiveContent, lineSafe: false };
    }
    return null;
  }

  // get: sanitize sensitive resource output based on format
  if (sub !== "get") return null;

  const resource = detectSensitiveResource(args);
  if (!resource) return null;

  const fmt = getOutputFormat(args);

  // -o json → structural sanitization (precise)
  if (fmt === "json") {
    return { type: "sanitize", sanitize: makeKubectlJsonSanitizer(resource), lineSafe: false };
  }

  // table / wide / name → safe, no sanitization needed
  const safeFormats = new Set([undefined, null, "wide", "name"]);
  if (!fmt || safeFormats.has(fmt)) return null;

  // All other formats (yaml, jsonpath, go-template, custom-columns) → line-level sanitization
  return { type: "sanitize", sanitize: redactSensitiveContent, lineSafe: false };
};

// ── File-reading command rules ──────────────────────────────────────

const REDACTED = "**REDACTED**";

/** Rule for file-reading commands: always sanitize output */
const fileReadingRule: OutputRuleFn = (_args) => ({
  type: "sanitize",
  sanitize: redactSensitiveContent,
  // NOT line-safe. `redactSensitiveContent` routes through `redactDocument`, which carries state
  // across lines so that a PEM body, a YAML block scalar and a mapping nested under a sensitive key
  // are redacted along with the marker that introduces them. The streaming sanitizer calls a
  // line-safe action once per batch of complete lines with no state between calls, so a secret split
  // across two batches had its BEGIN line redacted and its body written to the task output verbatim —
  // with the redaction notice attached. `false` makes the existing fail-closed guard in
  // SanitizingLineBuffer refuse to background these commands instead.
  lineSafe: false,
});

for (const cmd of [
  "cat", "head", "tail", "less", "more",
  "grep", "egrep", "fgrep", "strings",
  "zcat", "zgrep",
]) {
  OUTPUT_RULES[cmd] = fileReadingRule;
}

// ── env/printenv rules ──────────────────────────────────────────────

/**
 * Redact sensitive values from env/printenv output (KEY=VALUE per line).
 * Matches key names against SENSITIVE_ENV_NAME_PATTERNS.
 */
function redactEnvOutput(output: string, opts?: { separator?: string }): string {
  // `env -0` / `printenv -0` separate entries with NUL, not newline. Splitting on newlines left the whole
  // record as one "line" whose first KEY= decided everything, so `SAFE=x<NUL>API_KEY=secret` kept the
  // secret. The separator is passed in by the rule, the only place that can see the flag.
  const sep = opts?.separator ?? "\n";
  const entries = output.split(sep);
  let redacted = false;

  // An env VALUE may span lines. Per-line splitting masked only the first line of a multi-line secret
  // and let the remainder through, so a continuation line belongs to the record above it until the next
  // `KEY=`.
  const KEY_START = /^[A-Za-z_][A-Za-z0-9_]*=/;
  const records: string[] = [];
  for (const entry of entries) {
    if (sep === "\n" && records.length > 0 && !KEY_START.test(entry)) {
      records[records.length - 1] += "\n" + entry;
    } else {
      records.push(entry);
    }
  }

  const result = records.map((record) => {
    const eqIdx = record.indexOf("=");
    if (eqIdx <= 0) return record;

    const key = record.slice(0, eqIdx);
    if (SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(key))) {
      redacted = true;
      return `${key}=${REDACTED}`;
    }

    // Value patterns (JWT, PEM, …) over the WHOLE value, continuation lines included.
    const value = record.slice(eqIdx + 1);
    if (SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value))) {
      redacted = true;
      return `${key}=${REDACTED}`;
    }

    return record;
  });

  const sanitized = result.join(sep);
  return redacted ? sanitized + REDACTION_NOTICE : sanitized;
}

/**
 * `printenv NAME` prints the VALUE ALONE — no `KEY=` for the redactor to key on, so a sensitive variable
 * came back verbatim. The name is only in the argv, and the entire output is that one value: redact all
 * of it or none of it.
 */
function redactBareEnvValue(names: string[]): (output: string) => string {
  const sensitive = names.some((n) => SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(n)));
  return (output: string) => {
    if (!sensitive) return redactEnvOutput(output);
    return output.trim() ? REDACTED + REDACTION_NOTICE : output;
  };
}

/** `-0`/`--null` switches the record separator to NUL, which also removes any line structure. */
function envNulSeparated(args: string[]): boolean {
  return args.some((a) => a === "-0" || a === "--null");
}

const NUL_SEPARATOR = String.fromCharCode(0);

OUTPUT_RULES["env"] = (args) => {
  const nul = envNulSeparated(args);
  return {
    type: "sanitize",
    sanitize: (out: string) => redactEnvOutput(out, nul ? { separator: NUL_SEPARATOR } : undefined),
    // NUL-separated output has no lines, so it cannot be redacted incrementally per line.
    lineSafe: !nul,
  };
};

OUTPUT_RULES["printenv"] = (args) => {
  // `printenv NAME…` prints bare values; `printenv` alone prints KEY=VALUE records.
  const names = args.filter((a) => !a.startsWith("-"));
  const nul = envNulSeparated(args);
  if (names.length > 0) {
    return { type: "sanitize", sanitize: redactBareEnvValue(names), lineSafe: false };
  }
  return {
    type: "sanitize",
    sanitize: (out: string) => redactEnvOutput(out, nul ? { separator: NUL_SEPARATOR } : undefined),
    lineSafe: !nul,
  };
};

// ── crictl inspect rules ────────────────────────────────────────────

/**
 * Sanitize crictl inspect JSON output by redacting sensitive env vars.
 * Targets .info.config.envs (containerd) — an array of {key, value} objects.
 * On JSON parse failure, suppresses raw output (same behavior as sanitizeJSON).
 */
function sanitizeCrictlInspect(output: string): string {
  let obj: any;
  try {
    obj = JSON.parse(output);
  } catch {
    return JSON.stringify({
      error: "Failed to parse crictl inspect JSON output for sanitization. Raw output suppressed to prevent potential data leak.",
    }, null, 2);
  }

  let redacted = false;

  // containerd: .info.config.envs is an array of "KEY=VALUE" strings
  const envs = obj?.info?.config?.envs;
  if (Array.isArray(envs)) {
    for (let i = 0; i < envs.length; i++) {
      if (typeof envs[i] !== "string") continue;
      const eqIdx = envs[i].indexOf("=");
      if (eqIdx <= 0) continue;
      const key = envs[i].slice(0, eqIdx);
      if (SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(key))) {
        envs[i] = `${key}=${REDACTED}`;
        redacted = true;
      }
    }
  }

  // Also check .info.config.envs as array of {key, value} objects (CRI-O style)
  if (Array.isArray(envs)) {
    for (const env of envs) {
      if (env && typeof env === "object" && typeof env.key === "string" && typeof env.value === "string") {
        if (SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(env.key))) {
          env.value = REDACTED;
          redacted = true;
        }
      }
    }
  }

  const sanitized = JSON.stringify(obj, null, 2);
  return redacted ? sanitized + "\n\n⚠️ Sensitive values have been redacted for security." : sanitized;
}

OUTPUT_RULES["crictl"] = (args) => {
  // Skips the values of `-r`/`--runtime-endpoint` and friends: `crictl -r <sock> inspect X` otherwise
  // read as subcommand `<sock>` and no sanitizer attached, so the container's env came back verbatim.
  const sub = crictlSubcommand(args);
  if (sub === "inspect" || sub === "inspecti" || sub === "inspectp") {
    return { type: "sanitize", sanitize: sanitizeCrictlInspect, lineSafe: false };
  }
  return null;
};
