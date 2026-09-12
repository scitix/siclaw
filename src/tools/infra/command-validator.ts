import { crictlSubcommand } from "./kubectl-sanitize.js";
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
/**
 * Does the quote character at `at` actually CLOSE the string?
 *
 * bash: inside `'...'` a backslash has no special meaning at all, so the next `'` always closes. Three
 * tokenizers in this file counted preceding backslashes regardless of quote type, so
 *
 *   echo 'x\'; kubectl delete pod victim
 *
 * read as ONE `echo` command — while bash runs two, which a shell confirms. Every check downstream then
 * examined only the `echo`: the disallowed-command list, the kubectl verb rules, the redirection ban.
 * It applies to restricted_bash, node_exec and host_exec, all of which hand the string to a shell.
 *
 * `"..."` and `$'...'` DO honour escapes, so the backslash count still decides there.
 */
function quoteCloses(input: string, at: number, quote: string, ansiC: boolean): boolean {
  if (quote === "'" && !ansiC) return true;
  let backslashes = 0;
  for (let j = at - 1; j >= 0 && input[j] === "\\"; j--) backslashes++;
  return backslashes % 2 === 0;
}

/**
 * OUTSIDE any quote, does the character at `at` escape the one after it?
 *
 * The companion to `quoteCloses`, and the other half of the same mistake. bash escapes ANY next character
 * here, quotes included, so `\'` is a literal apostrophe that does not open a string. Two of these
 * tokenizers escaped only `; | & \`, and the third did not escape anything — and in all three the quote
 * branch ran FIRST, so the `'` was consumed as an opening quote before the escape was ever considered.
 * Everything after it then read as quoted:
 *
 *   echo \' > /tmp/pwn        the redirection ban never saw a `>` — measured in a container, the file
 *                             really was created
 *   echo \' ; rm x            the separator never split, so `rm` was never checked
 *   echo 'x'\''y'; rm x       the same, via the ordinary idiom for an apostrophe inside single quotes
 *
 * Found by differentially testing the tokenizer against a real bash rather than by reading it: the
 * construct that exposed it is one nobody would write by hand as an attack, and it is what `'` becomes
 * when a shell-quoting helper emits it.
 *
 * The character set is deliberately unbounded. A list here is a list that will be missing something.
 */
function escapesNext(input: string, at: number): boolean {
  return input[at] === "\\" && at + 1 < input.length;
}

/**
 * Is the `'` at `quoteAt` the start of an ANSI-C string, `$'…'`?
 *
 * It matters because the two kinds of single quote follow OPPOSITE rules: in `'…'` a backslash escapes
 * nothing so the next `'` always closes, while in `$'…'` it escapes and can therefore extend the string
 * past a separator. Deciding this on `input[quoteAt - 1] === "$"` alone was wrong in both of the ways a
 * `$` can fail to introduce one:
 *
 *   echo \$'x\'; rm x      the `$` is escaped — a literal dollar, then a PLAIN single quote
 *   echo $$'x\'; rm x      `$$` is the pid, and the `'` after it is a PLAIN single quote
 *
 * bash runs two commands in both cases; we read one, and the tail was never checked. Measured, not
 * inferred.
 *
 * The rule here is deliberately narrower than bash's: only a lone `$`, itself not preceded by `$` or `\`,
 * introduces an ANSI-C string. Anything more tangled (`$$$'…'`, `\\$'…'`) falls back to the PLAIN rule,
 * which closes at the next `'` — more splits, more checks, never fewer. Getting this direction right is
 * the whole point: a wrong "plain" reading over-refuses, a wrong "ANSI-C" reading lets a command through.
 * Chasing bash's exact lexer here would mean re-deriving `$$`/`${}`/`$(` interaction, and every attempt
 * at that in this file so far has produced a new hole.
 */
function opensAnsiC(input: string, quoteAt: number): boolean {
  if (input[quoteAt - 1] !== "$") return false;
  const before = input[quoteAt - 2];
  return before !== "$" && before !== "\\";
}

export function extractCommands(input: string): string[] {
  const commands: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  let ansiC = false;
  let parenDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      current += ch;
      if (ch === inQuote && quoteCloses(input, i, inQuote, ansiC)) {
        inQuote = null;
        ansiC = false;
      }
      continue;
    }

    // Escapes are resolved BEFORE quotes: `\'` is a literal apostrophe, not an opening quote. Reversing
    // these two branches is what let a `>` and a `;` hide inside a string that bash never started.
    if (escapesNext(input, i)) {
      current += ch + input[i + 1];
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      // `$'…'` honours escapes; a plain `'…'` does not.
      ansiC = ch === "'" && opensAnsiC(input, i);
      inQuote = ch;
      current += ch;
      continue;
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
  /**
   * The operator that PRECEDED this command; absent for the first one.
   *
   * `piped` already answers "did a `|` come before me", which is all the validator needs. The
   * separator itself is needed by exit classification, which has to decide WHICH pipeline bash's
   * `PIPESTATUS` describes: `&&` and `||` short-circuit, so a command written after one may never
   * have run, while `;` and `&` always execute what follows. Without that distinction a status
   * array gets mapped onto the text of a pipeline that never ran — see
   * `docs/design/2026-09-02-exec-classification-and-operand-quoting.md`.
   */
  sep?: "|" | "&&" | "||" | ";" | "&";
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
  let ansiC = false;
  let parenDepth = 0;
  let nextIsPiped = false;
  let nextSep: PipelineSegment["sep"] | undefined;
  // Carries `sep` onto each pushed segment. The first segment has none: nothing preceded it.
  const push = (cmd: string) => {
    segments.push(nextSep === undefined
      ? { command: cmd, piped: nextIsPiped }
      : { command: cmd, piped: nextIsPiped, sep: nextSep });
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuote) {
      current += ch;
      if (ch === inQuote && quoteCloses(input, i, inQuote, ansiC)) {
        inQuote = null;
        ansiC = false;
      }
      continue;
    }

    // Escapes before quotes — see `escapesNext`.
    if (escapesNext(input, i)) {
      current += ch + input[i + 1];
      i++;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      // `$'…'` honours escapes; a plain `'…'` does not.
      ansiC = ch === "'" && opensAnsiC(input, i);
      inQuote = ch;
      current += ch;
      continue;
    }

    if (ch === "(") { parenDepth++; current += ch; continue; }
    if (ch === ")") { parenDepth--; current += ch; continue; }

    if (parenDepth === 0) {
      // Check for || and &&
      if (
        (ch === "&" && input[i + 1] === "&") ||
        (ch === "|" && input[i + 1] === "|")
      ) {
        if (current.trim()) push(current.trim());
        current = "";
        nextIsPiped = false; // || and && are not pipes
        nextSep = ch === "&" ? "&&" : "||";
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
        if (current.trim()) push(current.trim());
        current = "";
        nextIsPiped = true;
        nextSep = "|";
        continue;
      }
      // & or ; — not pipes
      if (ch === "&" || ch === ";") {
        if (current.trim()) push(current.trim());
        current = "";
        nextIsPiped = false;
        nextSep = ch === "&" ? "&" : ";";
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) push(current.trim());
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
  let ansiC3 = false;

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
      if (ch === inQuote && quoteCloses(command, i, inQuote, ansiC3)) {
        inQuote = null;
        ansiC3 = false;
      }
      continue;
    }

    // Escapes before quotes — see `escapesNext`. This function had no escape handling at all, which is
    // why `echo \' > /tmp/pwn` passed the redirection ban: the `'` opened a string bash never opened, and
    // the `>` was read as its content. Placed after the substitution checks above deliberately, so `\$(`
    // and `` \` `` keep being refused — over-refusing a substitution is not the failure mode here.
    if (escapesNext(command, i)) {
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      ansiC3 = ch === "'" && opensAnsiC(command, i);
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

      // fd duplication — `2>&1`, `>&2`, `2>&-` — is allowed. A FILE after `>&` is not.
      //
      // `[n]>&word` only duplicates a descriptor when `word` is a number or `-`. Otherwise bash treats it
      // as an ordinary output redirection, so `echo HI >& /tmp/out` writes the file — measured in a
      // container, where the file appeared with `HI` in it while this returned ALLOW. It reads as fd
      // syntax, which is why one `continue` covered it for the whole history of this check.
      //
      // Only `>&` and `1>&` actually reach a file; `2>&/tmp/x` and `3>&/tmp/x` make bash say `ambiguous
      // redirect` and write nothing. The rule here does not encode that asymmetry — refusing a form bash
      // rejects anyway costs nothing, and the reason `1` behaves like an absent fd is not a detail worth
      // depending on.
      if (command[i + 1] === "&") {
        let j = i + 2;
        while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;
        // A descriptor number, or `-` to close. Anything else — a path, a variable, a glob — is a file.
        const word = command.slice(j).match(/^(\d+|-)(?=[\s;|&)]|$)/);
        if (word) continue;
        return JSON.stringify({
          error: "Output redirection (>&) to a file is not allowed.",
          hint: "`>&` duplicates a file descriptor only when followed by a number or `-` (e.g. `2>&1`, `>&2`). Followed by anything else it writes a file, which is refused like `>`.",
        }, null, 2);
      }

      // Determine the redirect target (skip optional second > for >>)
      let j = i + 1;
      if (command[j] === ">") j++; // >>
      // A tab separates a redirection from its target exactly as a space does, so skipping only spaces
      // refused `> \t/dev/null` — over-refusal, but a pointless one, and the `>&` branch above already
      // skips both. Two whitespace rules in one function is how they end up disagreeing.
      while (j < command.length && (command[j] === " " || command[j] === "\t")) j++;

      // Allow redirect to /dev/null — and ONLY to /dev/null.
      //
      // `\b` here matched any path whose next character is not a word character, so `> /dev/null.bak`,
      // `/dev/null-x`, `/dev/null~`, `/dev/null,x` and `/dev/null:x` were all read as the discard target
      // and permitted. Measured in a container: each one wrote a real file with the payload in it. The
      // blast radius is small — the write lands under `/dev`, which only root can write, and neither
      // `sandbox` (restricted_bash) nor `agentbox` (node_exec) can — so this was a hole in the check, not
      // a reachable escalation. It is still the redirection ban failing to mean what it says.
      //
      // The target must therefore END here: whitespace, a shell separator, or end of string.
      const target = command.substring(j);
      if (/^\/dev\/null(?=[\s;|&)]|$)/.test(target)) continue;

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
    // The asymmetry is deliberate and was reported as confusing: status and stack are permitted for the
    // same PID while cmdline is not, because a command line routinely carries credentials in its
    // arguments. Naming the exact substitute is what the refusal was missing.
    return "This process file exposes another process's memory, environment or descriptors — a command "
      + "line in particular often carries credentials in its arguments. For the same information use "
      + "`ps -p <pid> -o args=` (the command line, argument-safe), `/proc/<pid>/status` (state, UIDs, "
      + "memory) or `/proc/<pid>/stack`, all of which are permitted.";
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

/**
 * A sensitive-output source feeding a PIPE has no redactor left that can reach it.
 *
 * These sources are protected by matching their SHAPE — `KEY=` for env, `.info.config.envs[]` for a
 * crictl inspect — and that protection applies to the LAST stage's output. Measured leaking:
 *
 *   printenv PASSWORD | cut -c1-                          a bare value, no key to match
 *   env | grep PASSWORD | cut -d= -f2-                     the key stripped before anything sees it
 *   crictl inspect X | jq -r '.info.config.envs[0].value'   one env value, extracted
 *
 * Same shape as a Secret read into a pipe: the guarantee belongs to the source, and the pipe moves the
 * output out from under it. Refused rather than patched downstream, because once the key is gone there is
 * nothing to key on.
 *
 * Pod and ConfigMap reads are deliberately NOT here: their redaction is pattern-based, so it still
 * applies to whatever the last stage prints, and refusing every filtered read would cost far more than it
 * protects.
 */
function checkSensitiveSourceIntoPipe(commands: string[]): string | null {
  if (commands.length < 2) return null;
  const CRICTL_INSPECT = new Set(["inspect", "inspecti", "inspectp"]);
  for (let i = 0; i < commands.length - 1; i++) {
    const bin = getCommandBinary(commands[i]).toLowerCase();
    if (bin === "env" || bin === "printenv") {
      return JSON.stringify({
        error: `Piping ${bin} into another command is not allowed — its values are redacted by matching `
          + "`KEY=`, and a later stage can strip the key (or print a bare value) so nothing is left to "
          + "match.",
        hint: `Run \`${bin}\` on its own: the output comes back with sensitive values already redacted, `
          + "and can be read directly.",
      }, null, 2);
    }
    if (bin === "crictl") {
      const sub = crictlSubcommand(parseArgs(commands[i]).slice(1));
      if (sub && CRICTL_INSPECT.has(sub)) {
        return JSON.stringify({
          error: `Piping "crictl ${sub}" into another command is not allowed — its container environment `
            + "is redacted structurally, and a filter can extract one value with nothing left to match.",
          hint: "Use the tool's own `json_path` parameter to project the document — it is applied AFTER "
            + "redaction — or run the inspect on its own and read the sanitized output.",
        }, null, 2);
      }
    }
  }
  return null;
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
    const names = [...new Set(violations)];
    // Shell KEYWORDS land here as if they were missing binaries, and the allow-list then reads as "we
    // have never heard of `for`" — which is why three reviews describe the interface as implying full
    // shell support. The refusal now separates the two and, for the loop case, names the shape that
    // actually works: a review shows `cmd1; cmd2; cmd3` running fine right after `for … done` was
    // refused, so the capability is not missing, only the guidance was.
    const KEYWORDS = new Set(["for", "do", "done", "while", "until", "if", "then", "fi", "case", "esac",
                              "function", "select", "time", "coproc"]);
    const keywords = names.filter((n) => KEYWORDS.has(n));
    const binaries = names.filter((n) => !KEYWORDS.has(n));
    return JSON.stringify({
      error: `Blocked: disallowed command(s) — "${names.join(", ")}" is not in the allowed command list`,
      ...(keywords.length > 0 && {
        shell_constructs_rejected: keywords,
        hint: "Shell loops, conditionals and command substitution are not available — every command is "
          + "checked against the allow-list, and a construct that builds commands at runtime cannot be. "
          + "Semicolon-separated commands ARE supported, so expand the loop yourself: "
          + "`cmd pod-a; cmd pod-b; cmd pod-c`. For a list you do not know in advance, read it with one "
          + "call first, then issue the expanded commands.",
      }),
      ...(binaries.length > 0 && { binaries_not_allowed: binaries }),
      allowed: [...contextCmds, ...(options?.extraAllowed ?? [])].sort(),
    }, null, 2);
  }

  // 3b. A sensitive-output source feeding a pipe: the redactor keys on the source's shape, and a
  //     downstream stage can remove it.
  const sourcePiped = checkSensitiveSourceIntoPipe(commands);
  if (sourcePiped) return sourcePiped;

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
