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
