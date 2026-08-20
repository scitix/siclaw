/**
 * Unified command validation: shell parsing, context-based whitelist, and restrictions.
 *
 * Centralises logic previously duplicated across restricted-bash.ts and node-exec.ts.
 */
import {
  getContextAllowedSet,
  getCommandBinary,
  parseArgs,
  SENSITIVE_PATH_EXAMPLES,
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


const GLOB_METACHARS = /[*?[{]/;

/** Regex-escape a literal run. */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a shell glob to the regex of the paths it can expand to.
 *
 * Two semantics are load-bearing and were confirmed by running a shell rather than recalled:
 *
 *   - `*` and `?` do NOT cross `/`. `/etc/*` cannot reach `/etc/kubernetes/admin.conf`.
 *   - `*` and `?` do NOT match a leading `.`. Without that, `ls /root/*` would be refused because
 *     `/root/.bash_history` is on the example list, while the shell can never expand it there.
 *
 * `**` is treated as crossing separators (globstar), which is the permissive reading: it can only make
 * the compiled regex match MORE examples, so a shell without globstar is refused slightly more often
 * rather than less.
 */
export function globToPathRegExp(glob: string): RegExp | null {
  let out = "^";
  let atSegmentStart = true;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      const globstar = glob[i + 1] === "*";
      if (globstar) i++;
      // A leading dot is only protected when the wildcard opens the segment.
      out += globstar ? (atSegmentStart ? "(?!\\.)(?:.*)" : ".*")
                      : (atSegmentStart ? "(?!\\.)[^/]*" : "[^/]*");
      atSegmentStart = false;
    } else if (ch === "?") {
      out += atSegmentStart ? "[^/.]" : "[^/]";
      atSegmentStart = false;
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 1);
      if (close === -1) { out += "\\["; atSegmentStart = false; continue; }
      // Character classes carry over as-is; `!` is the shell's negation, `^` the regex's.
      const body = glob.slice(i + 1, close).replace(/^!/, "^");
      out += `[${body}]`;
      i = close;
      atSegmentStart = false;
    } else if (ch === "{") {
      const close = glob.indexOf("}", i + 1);
      if (close === -1) { out += "\\{"; atSegmentStart = false; continue; }
      const alts = glob.slice(i + 1, close).split(",").map(escapeLiteral);
      out += `(?:${alts.join("|")})`;
      i = close;
      atSegmentStart = false;
    } else {
      out += escapeLiteral(ch);
      atSegmentStart = ch === "/";
    }
  }
  try {
    return new RegExp(out + "$");
  } catch {
    return null;   // a class the shell accepts and JS does not: fall through to the literal checks
  }
}

/**
 * Could this glob expand onto a sensitive path?
 *
 * The gap this closes: `cat /etc/shadow` was refused while `cat /etc/*` was not, and the shell expands
 * the second onto the first. Screening the glob's literal prefix instead would refuse
 * `cat /etc/*release*`, which names no secret and is an ordinary diagnostic — hence the compile-and-test
 * approach rather than a prefix rule.
 */
function globReachesSensitivePath(arg: string, examples: readonly string[]): string | null {
  if (!GLOB_METACHARS.test(arg)) return null;
  const rx = globToPathRegExp(arg);
  if (!rx) return null;
  return examples.find((example) => rx.test(example)) ?? null;
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
      // Match the raw text AND each quote-stripped argument that looks like a path. Raw text alone let
      // a single quote character defeat every `$`-anchored pattern: `cat /etc/shadow` was refused,
      // `cat "/etc/shadow"` was not, because the text the regex saw ended in `"`. Measured across the
      // pattern list, 11 of 13 sensitive paths were reachable that way — /etc/shadow, /etc/gshadow,
      // /proc/N/{environ,cmdline,maps}, /proc/kcore and every TLS key form (.key/.p12/.pfx/.jks). The
      // two that held did so by accident: an unanchored rule (`/.ssh/`) happened to cover them.
      //
      // Only arguments containing `/` are re-checked, and that restriction is load-bearing: the
      // patterns describe paths, but several of them (`id_rsa$`, `\.key$`) also match a bare word, so
      // checking every argument would refuse `grep -r id_rsa /var/log` — searching for the string is a
      // legitimate diagnostic and names no path. A bare relative filename (`cat "id_rsa"`) therefore
      // still slips through this pass; the owner-side controls remain, and widening it needs per-command
      // operand knowledge rather than a text rule.
      const pathish = parseArgs(cmd).filter((a) => a.includes("/"));

      // A glob the shell expands ONTO a sensitive path: `cat /etc/shadow` was refused and `cat /etc/*`
      // was not. Compiled and tested against representative literals rather than screened by prefix,
      // so `cat /etc/*release*` — which names no secret — still runs.
      for (const arg of pathish) {
        const reached = globReachesSensitivePath(arg, SENSITIVE_PATH_EXAMPLES);
        if (!reached) continue;
        return JSON.stringify({
          error: `"${arg}" expands onto credential or secret material (for example "${reached}"), `
            + `which is not readable through this tool.`,
          matched: arg,
          expands_onto: reached,
          rejected_by: "sensitive_path",
          hint: sensitivePathHint(reached),
        }, null, 2);
      }

      for (const re of options.sensitivePathPatterns) {
        const hit = re.exec(cmd) ?? pathish.map((a) => re.exec(a)).find((m) => m !== null) ?? null;
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
