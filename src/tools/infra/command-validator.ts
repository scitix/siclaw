/**
 * Unified command validation: shell parsing, context-based whitelist, and restrictions.
 *
 * Centralises logic previously duplicated across restricted-bash.ts and node-exec.ts.
 */
import {
  getContextAllowedSet,
  getCommandBinary,
  validateCommandRestrictions,
} from "./command-sets.js";

// ── Types ────────────────────────────────────────────────────────────

export type ExecContext = "local" | "node" | "pod" | "host";

export interface ValidateCommandOptions {
  /** Determines the base whitelist. Default: "node". */
  context?: ExecContext;
  /** Extra binaries allowed beyond the context whitelist (e.g. "kubectl"). */
  extraAllowed?: Set<string>;
  /** Custom predicate for commands not in any whitelist (e.g. skill scripts). */
  isAllowed?: (cmd: string) => boolean;
  /** Validators run against the full pipeline (e.g. kubectl subcommand check). */
  pipelineValidators?: Array<(cmds: string[]) => string | null>;
  /** Patterns that block commands touching sensitive paths. */
  sensitivePathPatterns?: RegExp[];
  /** Reject pipes (|), chaining (&&, ;) — for contexts where commands are passed as argv, not through a shell. */
  blockPipeline?: boolean;
}

// ── extractCommands (moved from restricted-bash.ts) ──────────────────

/**
 * Extract individual commands from a shell pipeline.
 * Splits on |, &&, ;, || while respecting quotes and subshells.
 */
export function extractCommands(input: string): string[] {
  const commands: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let parenDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      current += ch;
      if (ch === inQuote) {
        // Count consecutive preceding backslashes — char is escaped only if count is odd
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && input[j] === "\\"; j--) backslashes++;
        if (backslashes % 2 === 0) {
          inQuote = null;
        }
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inQuote = ch;
      current += ch;
      continue;
    }

    // Handle backslash escape outside quotes (e.g., \; in find -exec ... \;)
    // Prevents escaped metacharacters from being treated as command separators.
    if (ch === "\\" && i + 1 < input.length) {
      const next = input[i + 1];
      if (next === ";" || next === "|" || next === "&" || next === "\\") {
        current += ch + next;
        i++;
        continue;
      }
    }

    if (ch === "(") {
      parenDepth++;
      current += ch;
      continue;
    }
    if (ch === ")") {
      parenDepth--;
      current += ch;
      continue;
    }

    // Only split at top-level (not inside subshells)
    if (parenDepth === 0) {
      // Check for ||, &&
      if (
        (ch === "&" && input[i + 1] === "&") ||
        (ch === "|" && input[i + 1] === "|")
      ) {
        if (current.trim()) commands.push(current.trim());
        current = "";
        i++; // skip next char
        continue;
      }
      // Check for single & (background), | and ;
      // But skip & when preceded by > (fd redirection like >&2, 2>&1)
      if (ch === "&" && current.length > 0 && current[current.length - 1] === ">") {
        current += ch;
        continue;
      }
      if (ch === "&" || ch === "|" || ch === ";") {
        if (current.trim()) commands.push(current.trim());
        current = "";
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) commands.push(current.trim());
  return commands;
}

// ── extractPipeline (pipe-position-aware command extraction) ──────────

export interface PipelineSegment {
  command: string;
  /** true if this command was preceded by a pipe operator | (not ||) */
  piped: boolean;
}

/**
 * Extract individual commands from a shell pipeline, tracking whether each
 * command follows a pipe (|) operator vs other separators (&&, ||, ;, &).
 * Used by validateCommand to pass pipe position to COMMANDS + CONTEXT_POLICIES.
 */
export function extractPipeline(input: string): PipelineSegment[] {
  const segments: PipelineSegment[] = [];
  let current = "";
  let inQuote: string | null = null;
  let parenDepth = 0;
  let nextIsPiped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      current += ch;
      if (ch === inQuote) {
        // Count consecutive preceding backslashes — char is escaped only if count is odd
        let backslashes = 0;
        for (let j = i - 1; j >= 0 && input[j] === "\\"; j--) backslashes++;
        if (backslashes % 2 === 0) {
          inQuote = null;
        }
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      inQuote = ch;
      current += ch;
      continue;
    }

    // Handle backslash escape outside quotes (e.g., \; in find -exec ... \;)
    if (ch === "\\" && i + 1 < input.length) {
      const next = input[i + 1];
      if (next === ";" || next === "|" || next === "&" || next === "\\") {
        current += ch + next;
        i++;
        continue;
      }
    }

    if (ch === "(") { parenDepth++; current += ch; continue; }
    if (ch === ")") { parenDepth--; current += ch; continue; }

    if (parenDepth === 0) {
      // Check for || and &&
      if (
        (ch === "&" && input[i + 1] === "&") ||
        (ch === "|" && input[i + 1] === "|")
      ) {
        if (current.trim()) segments.push({ command: current.trim(), piped: nextIsPiped });
        current = "";
        nextIsPiped = false; // || and && are not pipes
        i++; // skip next char
        continue;
      }
      // Skip & when preceded by > (fd redirection like >&2, 2>&1)
      if (ch === "&" && current.length > 0 && current[current.length - 1] === ">") {
        current += ch;
        continue;
      }
      // Single | — next command receives piped input
      if (ch === "|") {
        if (current.trim()) segments.push({ command: current.trim(), piped: nextIsPiped });
        current = "";
        nextIsPiped = true;
        continue;
      }
      // & or ; — not pipes
      if (ch === "&" || ch === ";") {
        if (current.trim()) segments.push({ command: current.trim(), piped: nextIsPiped });
        current = "";
        nextIsPiped = false;
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) segments.push({ command: current.trim(), piped: nextIsPiped });
  return segments;
}

// ── validateShellOperators (moved from restricted-bash.ts) ───────────

/**
 * Validate that a command does not use dangerous shell operators.
 * Scans character-by-character respecting quotes.
 * Blocks: > >> (output redirection, except >&N fd duplication and >/dev/null),
 *         $() and backticks (command substitution), <() >() (process substitution).
 * Returns an error message if blocked, or null if safe.
 */
export function validateShellOperators(command: string): string | null {
  let inQuote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // Block newline/carriage-return characters — bash interprets them as command
    // separators, but extractCommands() does not split on them, so they can be
    // used to smuggle commands past whitelist validation.
    if (ch === "\n" || ch === "\r") {
      return JSON.stringify({
        error: "Newline characters are not allowed in commands.",
      }, null, 2);
    }

    // Block backtick command substitution everywhere (including inside quotes)
    if (ch === "`") {
      return JSON.stringify({
        error: "Backtick command substitution is not allowed.",
      }, null, 2);
    }

    // Block $() command substitution everywhere (including inside quotes)
    if (ch === "$" && command[i + 1] === "(") {
      return JSON.stringify({
        error: "$() command substitution is not allowed.",
      }, null, 2);
    }

    // Track quote state for redirection checks only
    if (inQuote) {
      if (ch === inQuote && command[i - 1] !== "\\") {
        inQuote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      inQuote = ch;
      continue;
    }

    // Block <() process substitution
    if (ch === "<" && command[i + 1] === "(") {
      return JSON.stringify({
        error: "<() process substitution is not allowed.",
      }, null, 2);
    }

    // Block bare < input redirection (but not <( which is already handled above)
    if (ch === "<" && command[i + 1] !== "(") {
      return JSON.stringify({
        error: "Input redirection (<) is not allowed.",
      }, null, 2);
    }

    // Check output redirection: > and >>
    if (ch === ">") {
      // Allow >() process substitution — already blocked above when preceded by nothing,
      // but >( after a word is process substitution too
      if (command[i + 1] === "(") {
        return JSON.stringify({
          error: ">() process substitution is not allowed.",
        }, null, 2);
      }

      // Allow fd duplication: >&N (e.g. 2>&1, >&2)
      if (command[i + 1] === "&") continue;

      // Determine the redirect target (skip optional second > for >>)
      let j = i + 1;
      if (command[j] === ">") j++; // >>
      // Skip whitespace
      while (j < command.length && command[j] === " ") j++;

      // Allow redirect to /dev/null
      const target = command.substring(j);
      if (/^\/dev\/null\b/.test(target)) continue;

      return JSON.stringify({
        error: "Output redirection (> or >>) to files is not allowed.",
      }, null, 2);
    }
  }

  return null;
}

// ── Context-based command whitelist ──────────────────────────────────

/**
 * Get the set of commands allowed for a given execution context.
 * Delegates to getContextAllowedSet (cached in command-sets.ts).
 */
export function getContextCommands(context: ExecContext): ReadonlySet<string> {
  return getContextAllowedSet(context);
}

// ── Sensitive path patterns (secondary defense) ──────────────────────

const FILE_READING_CMDS = new Set([
  "cat", "head", "tail", "less", "more",
  "grep", "egrep", "fgrep", "awk", "gawk",
  "cut", "sort", "wc", "uniq", "column",
  "jq", "yq", "strings", "diff",
]);

// ── Unified validation entry point ──────────────────────────────────

/**
 * Validate a command string against context-based whitelist and restrictions.
 * Pipeline:
 *   1. validateShellOperators()
 *   2. extractPipeline() (with pipe position tracking)
 *   3. Per-command: context whitelist + extraAllowed + isAllowed
 *   4. pipelineValidators (e.g. validateKubectlInPipeline)
 *   5. validateCommandRestrictions() — includes pipeOnly, noFilePaths,
 *      COMMANDS constraints + CONTEXT_POLICIES
 *   6. sensitivePathPatterns check
 *
 * Returns an error message string if blocked, or null if allowed.
 */

/**
 * What to do INSTEAD, per kind of secret. A refusal that names no alternative gets retried with a
 * different command and refused again — which is the loop this exists to break.
 *
 * The advice is about the diagnostic goal behind the read, not about getting the file: nothing here
 * offers a way to obtain the material.
 */
function sensitivePathHint(matched: string): string {
  if (/\.ssh|id_rsa|id_ed25519|id_ecdsa/.test(matched)) {
    return "To reach a host, use host_exec — it acquires the key through the broker. Private keys are never readable.";
  }
  if (/secrets\//.test(matched)) {
    return "For a mounted secret, check that it is mounted and non-empty (ls -l on the directory, stat on the file) "
      + "rather than reading its contents; for a Secret's keys use kubectl get secret -o jsonpath over the key NAMES.";
  }
  if (/\.key$|\.p12$|\.pfx$|\.jks$/.test(matched)) {
    return "To check a certificate, read its public half instead (the .crt/.pem) — expiry, subject and issuer are all "
      + "there. A private key is never needed to diagnose TLS.";
  }
  if (/\/proc\//.test(matched)) {
    return "This process file exposes another process's memory, environment or descriptors. For diagnostics use ps, "
      + "lsof or /proc/<pid>/status, which are permitted.";
  }
  if (/shadow|passwd/.test(matched)) {
    return "For account questions use getent with a name-resolution database, or id <user>.";
  }
  if (/\.aws|\.gcp|\.azure|\.docker/.test(matched)) {
    return "Cloud and registry credentials are not readable. For an image-pull problem, read the pod's events and the "
      + "kubelet log — they name the failure without the credential.";
  }
  return "Read the artefact that answers the question rather than the secret itself; if the credential is genuinely "
    + "the subject, that is a Portal operation, not a diagnostic one.";
}

export function validateCommand(command: string, options?: ValidateCommandOptions): string | null {
  if (!command || !command.trim()) {
    return "Command must not be empty.";
  }

  // 1. Shell operator validation
  const shellOpErr = validateShellOperators(command);
  if (shellOpErr) return shellOpErr;

  // 2. Split pipeline (with pipe position tracking)
  const pipeline = extractPipeline(command);
  const commands = pipeline.map(s => s.command);
  if (commands.length === 0) {
    return "Command must not be empty.";
  }

  // 2b. Block pipelines for contexts where commands are passed as argv
  if (options?.blockPipeline && pipeline.length > 1) {
    return JSON.stringify({
      error: "Pipes (|), chaining (&&, ;) are not supported — only single commands are allowed.",
    }, null, 2);
  }

  // 3. Per-command whitelist check
  const context = options?.context ?? "node";
  const contextCmds = getContextCommands(context);
  const violations: string[] = [];

  for (const cmd of commands) {
    const binary = getCommandBinary(cmd);
    if (!binary) continue;

    // Check extraAllowed first (e.g., kubectl for local)
    if (options?.extraAllowed?.has(binary)) continue;

    // Check context whitelist
    if (contextCmds.has(binary)) continue;

    // Check custom isAllowed (e.g., skill scripts)
    if (options?.isAllowed?.(cmd)) continue;

    violations.push(binary);
  }

  if (violations.length > 0) {
    return JSON.stringify({
      error: `Blocked: disallowed command(s) — "${[...new Set(violations)].join(", ")}" is not in the allowed command list`,
      allowed: [...contextCmds, ...(options?.extraAllowed ?? [])].sort(),
    }, null, 2);
  }

  // 4. Pipeline validators (e.g., kubectl subcommand checks)
  if (options?.pipelineValidators) {
    for (const validator of options.pipelineValidators) {
      const err = validator(commands);
      if (err) return err;
    }
  }

  // 5. Per-command restrictions (pipeOnly, noFilePaths, blockedFlags,
  //    allowedFlags, positionals, etc. — via COMMANDS + CONTEXT_POLICIES)
  for (const seg of pipeline) {
    const err = validateCommandRestrictions(seg.command, {
      context,
      piped: seg.piped,
    });
    if (err) return err;
  }

  // 6. Sensitive path patterns (secondary defense layer)
  // Check ALL commands against sensitive path patterns — not gated by
  // FILE_READING_CMDS, because any command with a sensitive path in its
  // arguments is a potential leak vector.
  if (options?.sensitivePathPatterns) {
    for (const cmd of commands) {
      for (const re of options.sensitivePathPatterns) {
        const hit = re.exec(cmd);
        if (!hit) continue;
        // Name WHAT matched and what to do instead. "Accessing sensitive paths is not allowed" told
        // the agent nothing: not which argument was the problem, not whether the command itself was
        // rejected — so the usual response was to try a different command and be refused again.
        // The matched text is the caller's own input, so echoing it leaks nothing.
        return JSON.stringify({
          error: `"${hit[0]}" is credential or secret material, which is not readable through this tool.`,
          matched: hit[0],
          rejected_by: "sensitive_path",
          hint: sensitivePathHint(hit[0]),
        }, null, 2);
      }
    }
  }

  return null;
}
