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
  getOutputFormat,
  sanitizeJSON,
  SENSITIVE_ENV_NAME_PATTERNS,
  SENSITIVE_VALUE_PATTERNS,
  type SensitiveResourceType,
} from "./kubectl-sanitize.js";

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
  const sub = args.find((a) => !a.startsWith("-"))?.toLowerCase();

  // describe: sanitize configmap/pod output; secret describe is safe (shows byte counts only)
  if (sub === "describe") {
    const resource = detectSensitiveResource(args);
    if (resource && resource !== "secret") {
      return { type: "sanitize", sanitize: redactSensitiveContent, lineSafe: true };
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
  return { type: "sanitize", sanitize: redactSensitiveContent, lineSafe: true };
};

// ── File-reading command rules ──────────────────────────────────────

const REDACTED = "**REDACTED**";

/**
 * Advisory footer appended (once) by the line-based redactors when anything was
 * redacted. Exported so streaming sanitization (background bash) can strip the
 * per-batch duplicates — the inline **REDACTED** markers carry the actual security
 * property; the footer is cosmetic.
 */
export const REDACTION_NOTICE = "\n\n⚠️ Sensitive values have been redacted for security.";

/**
 * Redact sensitive content from file-reading command output.
 * Scans each line for:
 *   - KEY=VALUE or KEY: VALUE where KEY matches SENSITIVE_ENV_NAME_PATTERNS
 *   - Values matching SENSITIVE_VALUE_PATTERNS (JWT, PEM, connection strings, etc.)
 */
/** @public Used by restricted-bash pipeline fallback sanitization */
export function redactSensitiveContent(output: string): string {
  const lines = output.split("\n");
  let redacted = false;

  const result = lines.map((line) => {
    // Check value patterns first (JWT, PEM, connection string, known prefixes)
    for (const pattern of SENSITIVE_VALUE_PATTERNS) {
      if (pattern.test(line)) {
        redacted = true;
        return REDACTED;
      }
    }

    // Check KEY=VALUE format
    const eqMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)/);
    if (eqMatch) {
      const key = eqMatch[1];
      if (SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(key))) {
        redacted = true;
        return `${key}=${REDACTED}`;
      }
    }

    // Check KEY: VALUE format (YAML-like)
    const colonMatch = line.match(/^(\s*[A-Za-z_][A-Za-z0-9_.-]*):\s+(.*)/);
    if (colonMatch) {
      const key = colonMatch[1].trim();
      if (SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(key))) {
        redacted = true;
        return `${colonMatch[1]}: ${REDACTED}`;
      }
    }

    return line;
  });

  const sanitized = result.join("\n");
  return redacted ? sanitized + REDACTION_NOTICE : sanitized;
}

/** Rule for file-reading commands: always sanitize output */
const fileReadingRule: OutputRuleFn = (_args) => ({
  type: "sanitize",
  sanitize: redactSensitiveContent,
  lineSafe: true,
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
function redactEnvOutput(output: string): string {
  const lines = output.split("\n");
  let redacted = false;

  const result = lines.map((line) => {
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) return line;

    const key = line.slice(0, eqIdx);
    if (SENSITIVE_ENV_NAME_PATTERNS.some((p) => p.test(key))) {
      redacted = true;
      return `${key}=${REDACTED}`;
    }

    // Also check value patterns (JWT, PEM, etc.)
    const value = line.slice(eqIdx + 1);
    if (SENSITIVE_VALUE_PATTERNS.some((p) => p.test(value))) {
      redacted = true;
      return `${key}=${REDACTED}`;
    }

    return line;
  });

  const sanitized = result.join("\n");
  return redacted ? sanitized + REDACTION_NOTICE : sanitized;
}

OUTPUT_RULES["env"] = (_args) => ({
  type: "sanitize",
  sanitize: redactEnvOutput,
  lineSafe: true,
});

OUTPUT_RULES["printenv"] = (_args) => ({
  type: "sanitize",
  sanitize: redactEnvOutput,
  lineSafe: true,
});

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
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub === "inspect" || sub === "inspecti" || sub === "inspectp") {
    return { type: "sanitize", sanitize: sanitizeCrictlInspect, lineSafe: false };
  }
  return null;
};
