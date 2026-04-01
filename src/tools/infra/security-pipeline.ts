/**
 * Security pipeline facade — unified entry for pre-exec and post-exec security.
 *
 * Replaces the manual 4-step assembly (validateCommand → analyzeOutput →
 * applySanitizer → processToolOutput) with two calls: preExecSecurity() and
 * postExecSecurity(). processToolOutput is called ONLY inside postExecSecurity —
 * no other code should call it directly.
 */
import type { ValidateCommandOptions } from "./command-validator.js";
import { validateCommand, extractCommands } from "./command-validator.js";
import {
  analyzeOutput,
  applySanitizer,
  redactSensitiveContent,
  type OutputAction,
} from "./output-sanitizer.js";
import { processToolOutput } from "./tool-render.js";
import { getCommandBinary, parseArgs } from "./command-sets.js";
import { detectSensitiveResource } from "./kubectl-sanitize.js";

// ── Pre-exec ────────────────────────────────────────────────────────

export interface PreExecOptions extends ValidateCommandOptions {
  /**
   * How to determine which command's output format to analyze:
   * - "single": command is a single command (no pipeline), use it directly (pod-exec)
   * - "last-in-pipeline": use last command in pipeline (node-exec)
   * - "auto": detect kubectl exec inner command, fallback to last-in-pipeline (restricted-bash)
   * Default: "single"
   */
  analyzeTarget?: "single" | "last-in-pipeline" | "auto";
}

export interface PreExecResult {
  /** null if command is allowed */
  error: string | null;
  /** Output action for post-exec sanitization (pass to postExecSecurity) */
  action: OutputAction | null;
  /** Whether pipeline contains kubectl on sensitive resource (for fallback redaction) */
  hasSensitiveKubectl: boolean;
}

export function preExecSecurity(
  command: string,
  opts?: PreExecOptions,
): PreExecResult {
  // 1. Validate command (6-pass pipeline)
  const error = validateCommand(command, opts);
  if (error) return { error, action: null, hasSensitiveKubectl: false };

  // 2. Analyze output (determine sanitizer)
  const analyzeTarget = opts?.analyzeTarget ?? "single";
  const { action, hasSensitiveKubectl } = resolveOutputAction(
    command,
    analyzeTarget,
  );

  return { error: null, action, hasSensitiveKubectl };
}

// ── Post-exec ───────────────────────────────────────────────────────

export interface PostExecOptions {
  /** Stderr output — appended after sanitization with "\n\nSTDERR:\n" prefix */
  stderr?: string;
  /** Apply pipeline fallback redaction for sensitive kubectl output */
  hasSensitiveKubectl?: boolean;
}

/**
 * Post-execution security: sanitize stdout → combine with stderr → truncate.
 *
 * Sanitization (applySanitizer, redactSensitiveContent) applies to stdout ONLY,
 * not stderr — this preserves JSON validity when kubectl outputs valid JSON to
 * stdout and deprecation warnings to stderr.
 *
 * This is the ONLY place processToolOutput is called. All tools (cmd-exec and
 * script-exec) must route their final output through this function.
 *
 * For cmd-exec tools: pass the action from preExecSecurity().
 * For script-exec tools: pass null (no command sanitization, just truncate).
 */
export function postExecSecurity(
  stdout: string,
  action: OutputAction | null,
  opts?: PostExecOptions,
): string {
  let sanitized = applySanitizer(stdout, action);
  if (opts?.hasSensitiveKubectl) {
    sanitized = redactSensitiveContent(sanitized);
  }
  const combined = opts?.stderr
    ? sanitized + `\n\nSTDERR:\n${opts.stderr}`
    : sanitized;
  return processToolOutput(combined);
}

// ── Internal: resolve output action by strategy ─────────────────────

function resolveOutputAction(
  command: string,
  strategy: "single" | "last-in-pipeline" | "auto",
): { action: OutputAction | null; hasSensitiveKubectl: boolean } {
  const commands = extractCommands(command);

  // Detect sensitive kubectl in pipeline (for fallback redaction)
  const hasSensitiveKubectl =
    commands.length > 1 &&
    commands.some((cmd) => {
      const bin = getCommandBinary(cmd);
      if (bin !== "kubectl") return false;
      const kArgs = parseArgs(cmd.replace(/^\s*kubectl\s+/, ""));
      const sub = kArgs.find((a) => !a.startsWith("-"))?.toLowerCase();
      if (sub !== "get" && sub !== "describe") return false;
      return detectSensitiveResource(kArgs) !== null;
    });

  if (strategy === "single") {
    // pod-exec: single command, no pipeline
    const args = parseArgs(command);
    const binary = args[0]?.split("/").pop() ?? "";
    return {
      action: analyzeOutput(binary, args.slice(1)),
      hasSensitiveKubectl: false,
    };
  }

  if (strategy === "auto") {
    // Defense-in-depth: detect kubectl exec inner command for output sanitization.
    // restricted-bash blocks exec via SAFE_SUBCOMMANDS, but this layer runs
    // independently (preExecSecurity can be called without pipelineValidators).
    for (const cmd of commands) {
      const bin = getCommandBinary(cmd);
      if (bin === "kubectl") {
        const args = parseArgs(cmd.replace(/^\s*kubectl\s+/, ""));
        const sub = args.find((a) => !a.startsWith("-"))?.toLowerCase();
        if (sub === "exec") {
          const dashIdx = args.indexOf("--");
          if (dashIdx >= 0 && dashIdx < args.length - 1) {
            const innerArgs = args.slice(dashIdx + 1);
            const innerBin = innerArgs[0]?.split("/").pop() ?? "";
            return {
              action: analyzeOutput(innerBin, innerArgs.slice(1)),
              hasSensitiveKubectl,
            };
          }
        }
      }
    }
    // fallthrough to last-in-pipeline
  }

  // "last-in-pipeline" (node-exec) or "auto" fallback
  const lastCmd = commands[commands.length - 1];
  const lastArgs = parseArgs(lastCmd);
  const lastBin = getCommandBinary(lastCmd);
  return {
    action: lastBin ? analyzeOutput(lastBin, lastArgs.slice(1)) : null,
    hasSensitiveKubectl,
  };
}
