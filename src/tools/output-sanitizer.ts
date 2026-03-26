/**
 * Output sanitization framework — post-execution content review.
 *
 * Complements the existing 6-pass pre-execution validation pipeline
 * (validateCommand) with post-execution output sanitization.
 *
 * Pre-execution blocking (config view --raw, describe configmap/pod,
 * jsonpath/go-template) stays in the tool-specific code (kubectl.ts,
 * validateKubectlInPipeline). This module only handles sanitize and
 * rewrite actions.
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

export type OutputAction =
  | { type: "sanitize"; sanitize: (output: string) => string }
  | { type: "rewrite"; newArgs: string[]; sanitize: (output: string) => string };

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

/** Rewrite -o yaml to -o json in kubectl args */
function rewriteYamlToJson(args: string[]): string[] {
  return args.map((a, idx) => {
    const prev = args[idx - 1];
    if (a === "yaml" && (prev === "-o" || prev === "--output")) return "json";
    if (a === "-o=yaml") return "-o=json";
    if (a === "-oyaml") return "-ojson";
    if (a === "--output=yaml") return "--output=json";
    return a;
  });
}

/** Build sanitize function for a kubectl sensitive resource */
function makeKubectlSanitizer(
  resource: SensitiveResourceType,
  convertedFromYaml: boolean,
): (output: string) => string {
  return (output: string) => {
    let sanitized = sanitizeJSON(output, resource);
    if (convertedFromYaml) {
      sanitized += "\n\nNote: Output converted from YAML to JSON for reliable sanitization.";
    }
    return sanitized;
  };
}

// ── kubectl rules ────────────────────────────────────────────────────

OUTPUT_RULES["kubectl"] = (args) => {
  // Only "get" subcommand needs output sanitization.
  // "describe" and other subcommands are handled by pre-execution
  // block logic in kubectl.ts (describe configmap/pod → block,
  // describe secret → allow as-is).
  const sub = args.find((a) => !a.startsWith("-"))?.toLowerCase();
  if (sub !== "get") return null;

  const resource = detectSensitiveResource(args);
  if (!resource) return null;

  const fmt = getOutputFormat(args);

  // -o json → execute normally, sanitize output
  if (fmt === "json") {
    return {
      type: "sanitize",
      sanitize: makeKubectlSanitizer(resource, false),
    };
  }

  // -o yaml → rewrite to -o json, then sanitize
  if (fmt === "yaml") {
    return {
      type: "rewrite",
      newArgs: rewriteYamlToJson(args),
      sanitize: makeKubectlSanitizer(resource, true),
    };
  }

  // table / wide / name → safe, no sanitization needed
  // jsonpath / go-template / custom-columns → handled by pre-execution block in kubectl.ts
  return null;
};

// ── File-reading command rules ──────────────────────────────────────

const REDACTED = "**REDACTED**";

/**
 * Redact sensitive content from file-reading command output.
 * Scans each line for:
 *   - KEY=VALUE or KEY: VALUE where KEY matches SENSITIVE_ENV_NAME_PATTERNS
 *   - Values matching SENSITIVE_VALUE_PATTERNS (JWT, PEM, connection strings, etc.)
 */
function redactSensitiveContent(output: string): string {
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
  return redacted ? sanitized + "\n\n⚠️ Sensitive values have been redacted for security." : sanitized;
}

/** Rule for file-reading commands: always sanitize output */
const fileReadingRule: OutputRuleFn = (_args) => ({
  type: "sanitize",
  sanitize: redactSensitiveContent,
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
  return redacted ? sanitized + "\n\n⚠️ Sensitive values have been redacted for security." : sanitized;
}

OUTPUT_RULES["env"] = (_args) => ({
  type: "sanitize",
  sanitize: redactEnvOutput,
});

OUTPUT_RULES["printenv"] = (_args) => ({
  type: "sanitize",
  sanitize: redactEnvOutput,
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
    return { type: "sanitize", sanitize: sanitizeCrictlInspect };
  }
  return null;
};
