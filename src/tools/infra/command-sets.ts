import {
  getOutputFormat,
  kubectlAllNamespaces,
  kubectlOutputFormats,
  kubectlPositionals,
  normalizeResourceToken,
} from "./kubectl-sanitize.js";
/**
 * Shared command whitelist and command-level validators used by
 * restricted-bash, pod-exec, and node-exec tools.
 *
 * Cross-reference: src/gateway/skills/script-evaluator.ts (DANGER_PATTERNS).
 * When modifying either file, verify the other still makes sense.
 */

// ── Utility functions ────────────────────────────────────────────

/**
 * Shell-escape a single argument by wrapping in single quotes.
 * Handles embedded single quotes via the standard '\'' idiom.
 * Safe for embedding in sh -c "..." strings passed to remote execution.
 */
export function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

/** One parsed argument, plus whether the shell will rewrite it before the command sees it. */
export interface ParsedArg {
  value: string;
  /**
   * The first metacharacter that is ACTIVE in this argument — one the shell will act on — or
   * undefined when the argument reaches the command exactly as written.
   *
   * "Active" is a per-character property, not a per-argument one, because quoting is applied per
   * character: in `'$CRED'/clusters/*` the `$` is inert and the `*` is not. See
   * `docs/design/2026-09-02-exec-classification-and-operand-quoting.md` for why this is the right
   * question to ask of a stdin-only command's expression.
   */
  expansion?: string;
}

/** Metacharacters the shell acts on only when they are UNQUOTED. Double quotes suppress all of these. */
const GLOB_METACHARS = new Set(["*", "?", "[", "]", "{", "}", "~"]);

/**
 * Would `$` here begin an expansion?
 *
 * A `$` is only special when something expandable follows: a name, a brace, a paren, or one of the
 * special parameters. A trailing `$` is a literal — which matters more than it sounds, because
 * `grep "error$"` and `grep "^$"` are two of the most common things anyone greps for, and treating
 * every `$` in double quotes as live refuses both.
 */
function beginsExpansion(next: string | undefined): boolean {
  return next !== undefined && /[A-Za-z_{(@*#?\-$!0-9]/.test(next);
}

/**
 * Which metacharacter, if any, is live at this position.
 *
 * `inQuote` is the state machine's own mode: `'` and the `$'…'` sentinel suppress everything, while
 * double quotes suppress globbing but NOT parameter or command substitution — `"$HOME/x"` really
 * does become a path. Characters reached through a backslash never reach here at all; the caller
 * appends them directly, which is what makes `"\$HOME"` a literal.
 */
function activeMetachar(ch: string, next: string | undefined, inQuote: string | null): string | null {
  if (inQuote === "'" || inQuote === "\u0001") return null;
  if (ch === "$") return beginsExpansion(next) ? "$" : null;
  // Backticks are rejected outright by validateShellOperators, so this arm never fires today. It is
  // here so the rule reads completely, not as a defence anything relies on.
  if (ch === "`") return "`";
  if (GLOB_METACHARS.has(ch)) return inQuote === null ? ch : null;
  return null;
}

/**
 * Parse a command string into an array of arguments, respecting quotes.
 * Moved from kubectl.ts to be shared.
 *
 * Callers that need to know whether the SHELL will rewrite an argument want
 * `parseArgsWithExpansion`; this wrapper exists because most callers only want the values.
 */
export function parseArgs(command: string): string[] {
  return parseArgsWithExpansion(command).map((a) => a.value);
}

export function parseArgsWithExpansion(command: string): ParsedArg[] {
  const args: ParsedArg[] = [];
  let current = "";
  let expansion: string | undefined;
  let inQuote: string | null = null;
  // An explicitly quoted argument survives even when it is EMPTY. Dropping it silently renumbered
  // every positional after it: `grep "" .siclaw/*/*/*` arrived as ["grep", ".siclaw/*/*/*"], so the
  // credential glob became the first positional and was exempted as grep's pattern — while the shell
  // passes the empty pattern through and grep prints every line of the files behind the glob.
  let quotedEmpty = false;
  const flush = () => {
    if (current || quotedEmpty) args.push(expansion === undefined ? { value: current } : { value: current, expansion });
    current = "";
    quotedEmpty = false;
    expansion = undefined;
  };
  const chars = [...command];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (inQuote) {
      // ANSI-C quoting ($'…') decodes escapes; a single-quoted string does not, and inside double
      // quotes a backslash escapes only a few characters. Handled where the quote was opened.
      if (ch === "\\" && (inQuote === '"' || inQuote === "\u0001")) {
        const next = chars[i + 1];
        if (next !== undefined) { current += decodeShellEscape(chars, i + 1, (n) => { i = n; }); continue; }
      }
      if (ch === inQuote || (inQuote === "\u0001" && ch === "'")) {
        inQuote = null;
      } else {
        expansion ??= activeMetachar(ch, chars[i + 1], inQuote) ?? undefined;
        current += ch;
      }
    } else if (ch === "$" && chars[i + 1] === "'") {
      // $'…' — the shell DECODES \057 and \x2f here, so `$'\057etc\057shadow'` reaches the process as
      // /etc/shadow. Treating it as literal text let the sensitive-path check miss the real path
      // entirely. A sentinel marks the mode so the closing quote is still `'`.
      inQuote = "\u0001";
      quotedEmpty = true;
      i++;
    } else if (ch === "\\") {
      // An UNQUOTED backslash escapes the next character and disappears: `cat /etc/shado\w` opens
      // /etc/shadow. Screening the text as written saw `shado\w` and matched nothing.
      const next = chars[i + 1];
      if (next !== undefined) { current += next; i++; }
      continue;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
      quotedEmpty = true;
    } else if (ch === " " || ch === "\t") {
      flush();
    } else {
      expansion ??= activeMetachar(ch, chars[i + 1], inQuote) ?? undefined;
      current += ch;
    }
  }
  flush();
  return args;
}

/**
 * Decode one backslash escape at `chars[at]`, advancing the caller's index past what it consumed.
 *
 * Only the forms that can rewrite a PATH: octal, hex, and the common control letters. Anything else
 * yields the character itself, which is what bash does for an unrecognised escape.
 */
function decodeShellEscape(chars: string[], at: number, advance: (to: number) => void): string {
  const c = chars[at];
  if (c === "x" || c === "X") {
    let hex = "";
    let j = at + 1;
    while (j < chars.length && hex.length < 2 && /[0-9a-fA-F]/.test(chars[j])) hex += chars[j++];
    if (hex) { advance(j - 1); return String.fromCharCode(parseInt(hex, 16)); }
  }
  // `\uHHHH` and `\UHHHHHHHH`. bash 4.2+ decodes both — measured in bash 5.2, where
  // `cat $'/etc/hostname'` reads the real file. Only `\x` and octal were decoded here, so
  // `$'/etc/shadow'` reached the sensitive-path check as the literal `u002fetcu002fshadow`
  // while the shell opened `/etc/shadow`. `cut`, `hexdump` and `od` are whitelisted and have no content
  // redactor, so that was a readable path to a credential file.
  if (c === "u" || c === "U") {
    const width = c === "u" ? 4 : 8;
    let hex = "";
    let j = at + 1;
    while (j < chars.length && hex.length < width && /[0-9a-fA-F]/.test(chars[j])) hex += chars[j++];
    if (hex) {
      const cp = parseInt(hex, 16);
      // Reject what String.fromCodePoint would throw on; bash prints those unchanged too.
      if (cp <= 0x10ffff) { advance(j - 1); return String.fromCodePoint(cp); }
    }
  }
  if (/[0-7]/.test(c)) {
    let oct = "";
    let j = at;
    while (j < chars.length && oct.length < 3 && /[0-7]/.test(chars[j])) oct += chars[j++];
    advance(j - 1);
    return String.fromCharCode(parseInt(oct, 8));
  }
  const simple: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", "\\": "\\", "'": "'", '"': '"' };
  advance(at);
  return simple[c] ?? c;
}

/**
 * Get the base binary name from a command string.
 * Strips env vars, leading whitespace, and path prefixes.
 * Moved from restricted-bash.ts to be shared.
 */
export function getCommandBinary(cmd: string): string {
  // Strip inline env assignments (FOO=bar cmd ...)
  let stripped = cmd;
  while (/^\s*\w+=\S*\s+/.test(stripped)) {
    stripped = stripped.replace(/^\s*\w+=\S*\s+/, "");
  }
  const first = stripped.trim().split(/\s+/)[0] ?? "";
  // Extract basename from absolute path
  return first.split("/").pop() ?? first;
}

/**
 * Check if arg starts with any of the given prefixes.
 */
function startsWithAny(arg: string, prefixes: string[]): boolean {
  return prefixes.some((p) => arg.startsWith(p));
}

/**
 * Extract the flag name from a --flag=value or -f form.
 */
function extractFlag(arg: string): string {
  const eqIdx = arg.indexOf("=");
  return eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
}



// Perftest: 11 binaries share one flag set (referenced by COMMANDS entries)
const PERFTEST_FLAGS = [
  "-s", "--size", "-D", "--duration", "-n", "--iters",
  "-p", "--port", "-d", "--ib-dev", "-i", "--ib-port",
  "-m", "--mtu", "-x", "--gid-index", "--sl",
  "-a", "--all", "-b", "--bidirectional",
  "-F", "--CPU-freq", "-c", "--connection",
  "-R", "--rdma_cm", "-q", "--qp",
  "-r", "--rx-depth", "-t", "--tx-depth", "--inline_size",
  "--run_infinitely", "--report_gbits", "--report_per_port",
  "-l", "--post_list", "--use_cuda", "--use_rocm", "--output_format",
  "-h", "--help", "-V", "--version",
];

// tcpdump: read-only LIVE packet capture to STDOUT. Default-deny allow-list — every
// file-writing / code-executing flag is intentionally OMITTED, so it is auto-rejected:
//   -w (write pcap), -W/-G/-C (rotate + write to files), -z (post-rotate command
//   EXECUTION), -r/-F/-V (read a pcap/filter/list FILE → arbitrary file read), -Z
//   (drop privileges to an arbitrary user). Only interface-selection, capture-control,
//   and on-screen format flags are permitted; the BPF filter expression is positional
//   and passes through. For a bounded capture use `-c <count>` or run_in_background +
//   job_stop — an unbounded tcpdump is killed by the per-call timeout / debug-pod TTL.
const TCPDUMP_FLAGS = [
  "-i", "--interface", "-c", "--count", "-s", "--snapshot-length",
  "-n", "-N", "-e", "-q", "-v", "-A", "-x", "-X", "-S", "-t", "-K",
  "-p", "--no-promiscuous-mode", "-l", "--packet-buffered", "-U",
  "-Q", "--direction", "--immediate-mode", "-B", "--buffer-size",
  "-d", "-D", "--list-interfaces", "-L", "--list-data-link-types",
  "-h", "--help", "--version",
];

// mlxlink (Mellanox link diagnostics) — read-only flag allow-list. mlxlink can CHANGE
// port state and WRITE files (--port_state, --amber_collect, --write_to_file, --reset,
// and the --set_* family); those are OMITTED → auto-rejected. Only link/PHY/FEC/eye/
// counter *read* flags are permitted. -d takes a device (positional value), passes through.
const MLXLINK_FLAGS = [
  "-d", "--device", "-p", "--port", "-c", "--counters",
  "-e", "--errors_show", "-m", "--module_info",
  "--show_module", "--show_serdes_tx", "--show_fec", "--show_eye",
  "--show_counters", "--rx_fec_histogram", "--port_type", "--json",
  "--use_csv", "-h", "--help",
];

// smartctl — read-only SMART/health flags only. -t (run self-test) and -s (SET features:
// SMART enable/disable, security, write-cache) are OMITTED → auto-rejected.
const SMARTCTL_FLAGS = [
  "-a", "--all", "-i", "--info", "-H", "--health",
  "-A", "--attributes", "-x", "--xall", "-c", "--capabilities",
  "-l", "--log", "-j", "--json", "-d", "--device", "-n", "--nocheck",
  "-f", "--format", "-q", "--quietmode",
];

// nvme-cli — read-only subcommands only (information/log queries). Destructive subcommands
// (format, sanitize, write, write-zeroes, create-ns, delete-ns, fw-download, fw-commit,
// reset, set-feature, security-send) are NOT listed → auto-rejected.
const NVME_READ_SUBCMDS = [
  "list", "list-subsys", "list-ns", "list-ctrl", "id-ctrl", "id-ns", "ns-descs",
  "smart-log", "error-log", "fw-log", "ana-log", "endurance-log", "self-test-log",
  "telemetry-log", "get-feature", "get-log", "show-regs", "version", "help",
];

// perfquery (IB/RoCE port counters) — read-only flag allow-list. Counter-reset flags
// (-R/--Reset_only, -r/--reset_after_read) are OMITTED → auto-rejected. The legacy
// positional form `<lid> <port> <reset_mask>` ALSO resets via a 3rd positional, so the
// rule caps positionals at 2 (lid + port, or two flag values) — a 3rd is rejected.
const PERFQUERY_FLAGS = [
  "-x", "--extended", "-X", "--xmtsl", "-D", "--Direct", "-G", "--Guid",
  "-C", "--Ca", "-P", "--Port", "-a", "--all_ports", "-l", "--loop_ports",
  "-t", "--timeout", "-h", "--help", "-V", "--version",
];

// ibqueryerrors — read-only flag allow-list. Counter-clear flags (-c/--clear_errors,
// -k/--clear_port_counters) and file-reading flags (-t/--threshold-file, --node-name-map)
// are OMITTED → auto-rejected.
const IBQUERYERRORS_FLAGS = [
  "-s", "--suppress", "-S", "--suppress-common", "-D", "--Direct", "-G", "--Guid",
  "-C", "--Ca", "-P", "--Port", "-r", "--report-port", "-d", "--details",
  "--counters", "--data", "--switch", "-h", "--help", "-V", "--version",
];

// tree — read/display flag allow-list. -o (write tree output to a file) is OMITTED →
// auto-rejected. Positional directory paths are read targets (allowed).
const TREE_FLAGS = [
  "-a", "-d", "-l", "-f", "-i", "-L", "-P", "-I", "-p", "-u", "-g", "-s",
  "-h", "-D", "-F", "-C", "-n", "-Q", "-N", "-r", "-t", "-v", "-x", "-J", "-X", "-H",
  "--du", "--dirsfirst", "--noreport", "--filelimit", "--charset", "--timefmt",
  "--inodes", "--device", "--prune", "--help", "--version",
];

// ── Generic rule engine ──────────────────────────────────────────

/** Internal rule shape consumed by validateByRule. Subset of the old CommandRule. */
interface InternalRule {
  command: string;
  pipeOnly?: boolean;
  noFilePaths?: boolean;
  /**
   * Flags whose value may begin with "-" (a negative number). Only consulted to stop the value being
   * validated as a flag — see the note in validateByRule.
   */
  /**
   * Flags after which a value beginning with `-` is a VALUE and not a flag (`journalctl -b -1`).
   *
   * Narrower than it sounds, and NOT the same field as `TextExpressionArgs.valueFlags` further down
   * this file, which answers "how many tokens does this flag consume" for the stdin-only layer. This
   * one only suppresses the flag-shaped reading of a negative number.
   */
  valueFlags?: readonly string[];
  blockedFlags?: string[];
  /**
   * Values that turn an otherwise-permitted flag into a blocked one.
   *
   *
   * `blockedFlags` names a SWITCH, which is not always where the capability lives: GNU grep spells
   * recursion both `-r` and `-d recurse`, so blocking only the former left the identical capability
   * one synonym away — and a recursive grep started at `.` walks into the credential tree without
   * the command ever naming a path, which is the one thing the stdin-only operand rules exist to
   * prevent. Keyed by a Map because both the flag and the value come from the caller.
   */
  blockedFlagValues?: ReadonlyMap<string, readonly string[]>;
  allowedFlags?: string[];
  allowedSubcommands?: { position: number; allowed: string[] };
  positionals?: "allow" | "block" | number;
  requiredFlags?: string[];
}

function validateByRule(
  args: string[],
  rule: InternalRule,
  options?: { piped?: boolean },
): string | null {
  const cmd = rule.command;

  // 0. pipeOnly: must appear after a pipe |
  if (rule.pipeOnly && options?.piped !== undefined && !options.piped) {
    return JSON.stringify({
      error: `"${cmd}" can only be used after a pipe (|). Direct file reading is not allowed — use the dedicated file tools instead.`,
    }, null, 2);
  }

  // 1. requiredFlags: at least one must be present
  if (rule.requiredFlags?.length) {
    if (!rule.requiredFlags.some((f) => args.includes(f))) {
      return JSON.stringify({
        error: `${cmd} requires one of: ${rule.requiredFlags.join(", ")}`,
      }, null, 2);
    }
  }

  // 2. allowedSubcommands: check the Nth positional
  if (rule.allowedSubcommands) {
    const { position, allowed } = rule.allowedSubcommands;
    let posCount = 0;
    for (const arg of args.slice(1)) {
      if (arg.startsWith("-")) continue;
      if (posCount === position) {
        if (!allowed.includes(arg)) {
          return JSON.stringify({
            error: `${cmd} ${position === 0 ? "subcommand" : "action"} "${arg}" is not allowed.`,
            // Listing what IS permitted turns a dead end into a next step. A review reports `crictl exec`
            // being refused clearly and the caller then guessing at kubelet volume paths, because the
            // refusal named nothing.
            allowed: [...allowed],
            ...(SUBCOMMAND_ALTERNATIVES.get(`${cmd} ${arg}`)
              ? { hint: SUBCOMMAND_ALTERNATIVES.get(`${cmd} ${arg}`) }
              : {}),
          }, null, 2);
        }
        return null;
      }
      posCount++;
    }
    return null; // not enough positionals → safe default
  }

  // 3. check flags + positionals
  const positionalPolicy = rule.positionals ?? "allow";
  let positionalCount = 0;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    // A flag's VALUE that begins with "-" is not a flag. `journalctl -b -1` (the previous boot) was
    // refused with `"-1" is not allowed`, which names the value rather than the parse — an agent
    // reading that drops the -1 and loses the intent, and never discovers that `-b-1` works.
    //
    // Narrow on purpose: only a value matching a NEGATIVE NUMBER is consumed, and only directly after
    // a flag the command declares as value-taking. Anything else keeps being validated as a flag, so
    // this cannot become a hole through which an arbitrary token slips past the whitelist.
    if (
      rule.valueFlags?.includes(args[i - 1]) &&
      /^-\d+$/.test(arg)
    ) {
      continue;
    }

    if (!arg.startsWith("-")) {
      positionalCount++;
      if (positionalPolicy === "block") {
        return JSON.stringify({
          error: `${cmd} "${arg}" is not allowed.`,
        }, null, 2);
      }
      if (typeof positionalPolicy === "number" && positionalCount > positionalPolicy) {
        return JSON.stringify({
          error: `${cmd} does not allow more than ${positionalPolicy} positional argument(s).`,
        }, null, 2);
      }
      // noFilePaths: block positional args that look like file/directory paths
      if (rule.noFilePaths && arg !== "") {
        if (
          arg.startsWith("/") ||
          arg.startsWith("./") ||
          arg.startsWith("../") ||
          arg.startsWith("~")
        ) {
          return JSON.stringify({
            error: `${cmd} cannot take file path arguments — it should only process piped input. Use the dedicated file tools instead.`,
          }, null, 2);
        }
      }
      continue;
    }

    // blockedFlags: explicitly forbidden flags (checked before allowedFlags)
    if (rule.blockedFlags) {
      if (arg.startsWith("--")) {
        const named = extractFlag(arg);
        const blocked = rule.blockedFlags.includes(named)
          ? named
          : blockedLongAbbrev(named, rule.blockedFlags);
        if (blocked) {
          return JSON.stringify({
            error: `${cmd} "${named}" is not allowed`
              + (blocked === named ? "." : ` — the shell's option parser reads it as "${blocked}".`),
          }, null, 2);
        }
      } else if (arg.length > 1) {
        // Combined short flags: -rl → check each char against blocked list
        for (const ch of arg.slice(1)) {
          if (rule.blockedFlags.includes(`-${ch}`)) {
            return JSON.stringify({
              error: `${cmd} "-${ch}" is not allowed.`,
            }, null, 2);
          }
        }
      }
    }

    // blockedFlagValues: the flag is fine, this value is not. Handles all three spellings the shell
    // allows for a value — `--directories=recurse`, `-d recurse` and `-drecurse`.
    if (rule.blockedFlagValues && arg.startsWith("-")) {
      const named = extractFlag(arg);
      const flag = rule.blockedFlagValues.has(named)
        ? named
        : blockedLongAbbrev(named, rule.blockedFlagValues.keys()) ?? named;
      const banned = rule.blockedFlagValues.get(flag);
      if (banned) {
        // Sliced by the length of what was WRITTEN, not of the canonical flag it resolves to:
        // `--di=recurse` is 12 characters and `--directories` is 13, so slicing by the canonical
        // length yielded "" and the check fell through to the next token. `--directorie=recurse`
        // happened to survive that bug because the two lengths differed by exactly one.
        const attached = arg.length > named.length ? arg.slice(named.length).replace(/^=/, "") : "";
        const value = attached || args[i + 1] || "";
        if (banned.includes(value.toLowerCase())) {
          return JSON.stringify({
            error: `${cmd} "${flag} ${value}" is not allowed — it is the same capability as the blocked `
              + `flags on this command, spelled differently.`,
          }, null, 2);
        }
      }
    }

    // allowedFlags check — skip if no allowedFlags defined
    if (!rule.allowedFlags) continue;

    const flag = extractFlag(arg);
    if (rule.allowedFlags.includes(flag)) continue;

    // Handle multi-char short flags: either combined flags (-rn) or
    // flag with attached value (-k2,3).
    if (!arg.startsWith("--") && arg.length > 2) {
      const chars = arg.slice(1);
      if (/^[a-zA-Z]+$/.test(chars)) {
        // Combined short flags: -rn → accept only if every char is allowed
        if ([...chars].every(ch => rule.allowedFlags!.includes(`-${ch}`))) continue;
        // Report the first disallowed char for better agent self-correction
        const bad = [...chars].find(ch => !rule.allowedFlags!.includes(`-${ch}`));
        return JSON.stringify({
          error: `${cmd} "-${bad}" (in "${arg}") is not allowed.`,
        }, null, 2);
      } else {
        // Short flag with attached value: -k2,3 → check "-k"
        const shortFlag = arg.slice(0, 2);
        if (rule.allowedFlags.includes(shortFlag)) continue;
      }
    }

    return JSON.stringify({
      error: `${cmd} "${arg}" is not allowed.`,
    }, null, 2);
  }

  return null;
}

// ── Custom validator functions ───────────────────────────────────

// ─── find ────────────────────────────────────────────────────────

const FIND_SAFE_ACTIONS = new Set(["-print", "-print0", "-printf", "-ls", "-prune", "-quit"]);
const FIND_SAFE_TESTS = new Set([
  "-name", "-iname", "-path", "-ipath", "-regex", "-iregex",
  "-type", "-size", "-mtime", "-atime", "-ctime", "-mmin", "-amin", "-cmin",
  "-newer", "-newermt", "-newerat", "-newerct",
  "-perm", "-user", "-group", "-uid", "-gid", "-nouser", "-nogroup",
  "-empty", "-readable", "-writable", "-executable",
  "-maxdepth", "-mindepth", "-mount", "-xdev",
  "-not", "-and", "-or", "-a", "-o",
  "-true", "-false", "-depth", "-daystart",
  "-samefile", "-inum", "-links", "-lname", "-ilname",
  "-wholename", "-iwholename",
  "-fstype", "-xtype",
]);

function validateFind(args: string[]): string | null {
  for (const arg of args.slice(1)) {
    if (!arg.startsWith("-")) continue; // path arguments are ok
    if (arg === "-") continue; // stdin marker
    if (!FIND_SAFE_ACTIONS.has(arg) && !FIND_SAFE_TESTS.has(arg)) {
      return JSON.stringify({
        error: `find "${arg}" is not allowed. Only read-only find operations are permitted.`,
        allowed_actions: [...FIND_SAFE_ACTIONS],
      }, null, 2);
    }
  }
  return null;
}

// ─── conntrack ───────────────────────────────────────────────────

const CONNTRACK_SAFE_OPS = new Set([
  "-L", "--dump", "-G", "--get", "-C", "--count", "-S", "--stats", "-E", "--event",
]);
const CONNTRACK_SAFE_FLAGS = new Set([
  "-p", "--proto", "-s", "--src", "-d", "--dst", "--sport", "--dport",
  "-m", "--mark", "-f", "--family", "-z", "--zero",
  "-o", "--output", "-e", "--event-mask", "-b", "--buffer-size",
  "-n", "--src-nat", "-g", "--dst-nat",
  "--orig-src", "--orig-dst", "--reply-src", "--reply-dst",
  "--orig-port-src", "--orig-port-dst", "--reply-port-src", "--reply-port-dst",
  "--state", "--status", "--timeout",
]);
const CONNTRACK_SAFE_PREFIXES = [
  "-p=", "--proto=", "-s=", "--src=", "-d=", "--dst=", "--sport=", "--dport=",
  "-m=", "--mark=", "-f=", "--family=", "-o=", "--output=", "-e=", "--event-mask=",
  "-b=", "--buffer-size=", "--state=", "--status=", "--timeout=",
];

function validateConntrack(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue;
    if (CONNTRACK_SAFE_OPS.has(arg)) {
      continue;
    }
    const flag = extractFlag(arg);
    if (!CONNTRACK_SAFE_FLAGS.has(flag) && !startsWithAny(arg, CONNTRACK_SAFE_PREFIXES)) {
      return JSON.stringify({
        error: `conntrack "${arg}" is not allowed. Only read-only operations are permitted.`,
        allowed_ops: [...CONNTRACK_SAFE_OPS],
      }, null, 2);
    }
  }
  return null;
}

// ─── curl ────────────────────────────────────────────────────────

const CURL_SAFE_FLAGS = new Set([
  "-s", "--silent", "-S", "--show-error", "-k", "--insecure", "-v", "--verbose",
  "-H", "--header", "-m", "--max-time", "--connect-timeout",
  "-L", "--location", "-I", "--head", "-w", "--write-out", "--compressed",
  "-A", "--user-agent", "-b", "--cookie", "-e", "--referer",
  "-u", "--user", "--cacert", "--cert", "-x", "--proxy",
  "--retry", "--retry-delay", "--retry-max-time",
  "-f", "--fail", "-4", "-6", "-N", "--no-buffer",
]);
const CURL_SAFE_PREFIXES = [
  "-H=", "--header=", "-m=", "--max-time=", "--connect-timeout=",
  "-w=", "--write-out=",
  "-A=", "--user-agent=", "-b=", "--cookie=", "-e=", "--referer=",
  "-u=", "--user=", "--cacert=", "--cert=", "-x=", "--proxy=",
  "--retry=", "--retry-delay=", "--retry-max-time=",
];
const CURL_REQUEST_FLAGS = new Set(["-X", "--request"]);
const CURL_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CURL_SAFE_SHORT_CHARS = new Set([
  "s", "S", "k", "v", "H", "X", "m", "L", "I", "w", "A", "b", "e", "u", "x", "f", "N",
  "4", "6",
]);

function checkCurlMethod(method: string | undefined): string | null {
  if (method && !CURL_SAFE_METHODS.has(method.toUpperCase())) {
    return JSON.stringify({
      error: `curl -X ${method.toUpperCase()} is not allowed. Only safe HTTP methods (${[...CURL_SAFE_METHODS].join(", ")}) are permitted.`,
    }, null, 2);
  }
  return null;
}

function validateCurl(args: string[]): string | null {
  // A leading `@` on ANY curl value means "read this local file" — `-w @fmt`, `-H @hdrs`, `-d @body`,
  // `-F f=@path`, `--config @file`. The flag allow-list only decided WHICH flags were permitted, so `-w`
  // and `-H` passed and their values read a kubeconfig — printing it, or POSTing it to whatever host the
  // same command named. Checked first, and for every argument shape, because the flag it rides on is not
  // what makes it dangerous.
  //
  // Refused rather than path-screened: `@` has exactly this one meaning in curl, the file forms have no
  // read-only use through this tool, and screening the path would still leave `-H @<passing path>
  // https://attacker` available.
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf("=");
    const candidates = [
      arg.startsWith("@") ? arg : undefined,                                  // bare @file
      eq > 0 ? arg.slice(eq + 1) : undefined,                                 // --data=@file, -F n=@file
      /^-[A-Za-z]@/.test(arg) ? arg.slice(2) : undefined,                     // -d@file
      /^-{1,2}[A-Za-z][A-Za-z-]*$/.test(arg) ? args[i + 1] : undefined,       // -H @file
    ];
    for (const candidate of candidates) {
      if (candidate?.startsWith("@")) {
        return JSON.stringify({
          error: `curl "${candidate}" is not allowed — a leading @ tells curl to read that local file, `
            + "which can print a credential or send it to a remote host.",
          hint: "Pass the value inline instead of @file. To read a file, use the dedicated file tools.",
        }, null, 2);
      }
    }
  }

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      // Positional argument — must be a URL. Only allow http(s)://.
      // Block file://, ftp://, dict://, gopher://, etc.
      const lower = arg.toLowerCase();
      if (lower.includes("://") && !lower.startsWith("http://") && !lower.startsWith("https://")) {
        return JSON.stringify({
          error: `curl "${arg}" uses a blocked protocol. Only http:// and https:// URLs are allowed.`,
        }, null, 2);
      }
      continue;
    }

    // ── Long flags (--xxx) ──────────────────────────────────
    if (arg.startsWith("--")) {
      const flag = extractFlag(arg);
      const hasValue = arg.includes("=");
      const inlineValue = hasValue ? arg.slice(flag.length + 1) : undefined;

      if (CURL_REQUEST_FLAGS.has(flag)) {
        if (!hasValue && i + 1 >= args.length) {
          return JSON.stringify({ error: `curl "${flag}" requires a value` }, null, 2);
        }
        const method = hasValue ? inlineValue : args[i + 1];
        const err = checkCurlMethod(method);
        if (err) return err;
        if (!hasValue) i++;
        continue;
      }

      if (!CURL_SAFE_FLAGS.has(flag) && !startsWithAny(arg, CURL_SAFE_PREFIXES)) {
        return JSON.stringify({
          error: `curl "${arg}" is not allowed. Only read-only curl flags are permitted.`,
        }, null, 2);
      }
      if (!hasValue && CURL_SAFE_FLAGS.has(flag) && (
        ["-H", "--header", "-m", "--max-time", "--connect-timeout",
         "-w", "--write-out", "-A", "--user-agent", "-b", "--cookie",
         "-e", "--referer", "-u", "--user", "--cacert", "--cert",
         "-x", "--proxy", "--retry", "--retry-delay", "--retry-max-time",
        ].includes(flag)
      )) {
        i++;
      }
      continue;
    }

    // ── Short flags with = (e.g. -m=10, -X=GET) ────────────
    if (arg.includes("=")) {
      const flag = extractFlag(arg);
      const inlineValue = arg.slice(flag.length + 1);

      if (flag === "-X") {
        const err = checkCurlMethod(inlineValue);
        if (err) return err;
        continue;
      }

      if (!CURL_SAFE_FLAGS.has(flag) && !startsWithAny(arg, CURL_SAFE_PREFIXES)) {
        return JSON.stringify({
          error: `curl "${arg}" is not allowed. Only read-only curl flags are permitted.`,
        }, null, 2);
      }
      continue;
    }

    // ── Combined short flags (e.g. -sS, -sSX, -vk) ─────────
    const chars = arg.slice(1);
    for (const ch of chars) {
      if (!CURL_SAFE_SHORT_CHARS.has(ch)) {
        return JSON.stringify({
          error: `curl "-${ch}" (in "${arg}") is not allowed. Only read-only curl flags are permitted.`,
        }, null, 2);
      }
    }

    const lastChar = chars[chars.length - 1];
    if (lastChar && "HXmwAbeux".includes(lastChar)) {
      if (lastChar === "X") {
        const err = checkCurlMethod(args[i + 1]);
        if (err) return err;
      }
      i++;
    }
  }
  return null;
}

// ─── ibportstate ─────────────────────────────────────────────────

const IBPORTSTATE_SAFE_ACTIONS = new Set(["query"]);

function validateIbportstate(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) continue;
    if (/^\d+$/.test(arg)) continue;
    if (!IBPORTSTATE_SAFE_ACTIONS.has(arg)) {
      return JSON.stringify({
        error: `ibportstate "${arg}" is not allowed. Only query operations are permitted.`,
        allowed: [...IBPORTSTATE_SAFE_ACTIONS],
      }, null, 2);
    }
  }
  return null;
}

// ─── perfquery ───────────────────────────────────────────────────
// Custom validator (not declarative) so we have a flag-argument model: the generic rule
// engine counts a flag's VALUE (e.g. the "mlx5_0" in "-C mlx5_0") as a positional, which
// both over-blocked legit reads and couldn't see the legacy positional reset form. Here we
// skip value-flag values, default-deny unknown/reset flags, and cap BARE positionals at 2
// (<lid> <port>) — a 3rd positional is the reset_mask, which RESETS the counters.
const PERFQUERY_VALUE_FLAGS = new Set(["-C", "--Ca", "-P", "--Port", "-t", "--timeout"]);

function validatePerfquery(args: string[]): string | null {
  let positionals = 0;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      const flag = extractFlag(arg);
      if (!PERFQUERY_FLAGS.includes(flag)) {
        return JSON.stringify({
          error: `perfquery "${arg}" is not allowed (counter-reset and unknown flags are blocked; read-only only).`,
        }, null, 2);
      }
      // Consume the value of a value-taking flag so it isn't miscounted as a positional.
      if (PERFQUERY_VALUE_FLAGS.has(flag) && !arg.includes("=")) i++;
      continue;
    }
    if (++positionals > 2) {
      return JSON.stringify({
        error: `perfquery positional "${arg}" is not allowed: a 3rd positional is a reset_mask that RESETS counters. Only <lid> <port> are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

// ─── dcgmi ───────────────────────────────────────────────────────
// Read-oriented subcommands only, AND (unlike a bare allowedSubcommands, which stops at the
// verb) reject the setter flags that mutate DCGM state — so "dcgmi health -s" / "dcgmi stats
// --enable" can't slip through and break the read-only invariant.
const DCGMI_READ_SUBCMDS = new Set(["discovery", "topo", "modules", "nvlink", "health", "stats"]);
const DCGMI_SETTER_FLAGS = new Set(["-s", "--set", "-e", "--enable", "--unwatch"]);

function validateDcgmi(args: string[]): string | null {
  const sub = args.slice(1).find((a) => !a.startsWith("-"));
  if (sub !== undefined && !DCGMI_READ_SUBCMDS.has(sub)) {
    return JSON.stringify({
      error: `dcgmi "${sub}" is not allowed. Only read subcommands are permitted.`,
      allowed: [...DCGMI_READ_SUBCMDS],
    }, null, 2);
  }
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-") && DCGMI_SETTER_FLAGS.has(extractFlag(arg))) {
      return JSON.stringify({
        error: `dcgmi "${arg}" is not allowed (it changes DCGM state; this tool is read-only).`,
      }, null, 2);
    }
  }
  return null;
}

// ─── nvidia-smi ──────────────────────────────────────────────────

const NVIDIA_SMI_SAFE_FLAGS = new Set([
  "-q", "--query", "-L", "--list-gpus", "-i",
  // Display-section FILTER for -q (MEMORY, UTILIZATION, TEMPERATURE, POWER, ECC, CLOCK, PIDS, …).
  // Read-only: the setters live under different flags (-e/--ecc-config writes ECC, -dm the driver
  // model, -pl the power limit) and stay blocked because matching is exact-token — extractFlag
  // only splits on "=", so "-d" never widens to "-dm".
  "-d", "--display",
]);
const NVIDIA_SMI_SAFE_PREFIXES = [
  "--query-gpu=", "--query-compute-apps=", "--id=", "--format=",
  "-i=", "--display=",
];

/**
 * Read-only flags PER SUBCOMMAND.
 *
 * Seeing a subcommand used to return null, which accepted the whole invocation and stopped
 * checking the rest of the argv — so `nvidia-smi nvlink --setcontrol …` and `nvidia-smi nvlink -r`
 * passed a validator whose own error message promises "only read-only queries". Subcommands carry
 * their own writes, so each gets its own allowlist (the shape validateDcgmi already uses).
 */
/**
 * Read-only option sets for the nvidia-smi subcommands that have their own.
 *
 * Transcribed from a REAL `nvidia-smi topo --help` / `nvlink --help` on a GPU node, not from the
 * online documentation: the docs list `topo -nvme / -gpu / -nic / -all`, which that driver does not
 * have, and they give long forms (`--path`, `--nvlink`, `--list`) that do not exist either. Only what
 * a real binary confirms is listed here — an allowlist that names options nothing accepts is a claim
 * we cannot back, and the cost of omitting a genuine option is a refusal, not a leak.
 *
 * Every WRITE and RESET option is excluded, and the help text is what identifies them:
 *   nvlink -sc/--setcontrol, -r/--resetcounters, -re/--reseterrorcounters,
 *          -sLowPwrThres/--setLowPowerThreshold, -sBwMode/--setBandwidthMode
 * `-re` is the reason this is an allow-list rather than a deny-list: it resets every error counter,
 * and it was refused before anyone noticed it existed, simply by not being named.
 *
 * The deprecated getters (`-gc/--getcontrol`, `-g/--getcounters`) are also left out — nvidia-smi
 * itself directs callers to `-gt/--getthroughput`.
 */
const NVIDIA_SMI_SUBCMD_FLAGS = new Map<string, Set<string>>(Object.entries({
  topo: new Set([
    "-m", "--matrix", "-mp", "--matrix_pci",
    "-i", "--id", "-c", "--cpu", "-n", "--nearest_gpus", "-p", "--gpu_path",
    "-p2p", "--p2pstatus",
    "-C", "--get-numa-id-of-nearby-cpu", "-M", "--get-numa-id-of-nearby-mem",
    "-gnid", "--gpu-numa-id", "-h", "--help",
  ]),
  nvlink: new Set([
    "-h", "--help", "-i", "--id", "-l", "--link",
    "-s", "--status", "-c", "--capabilities",
    "-p", "--pcibusid", "-R", "--remotelinkinfo",
    "-e", "--errorcounters", "-ec", "--crcerrorcounters",
    "-gt", "--getthroughput",
    "-gLowPwrInfo", "--getLowPowerInfo", "-gBwMode", "--getBandwidthMode",
    "-cBridge", "--checkBridge",
  ]),
}));

/**
 * mikefarah yq screens its EXPRESSION, not just its argv.
 *
 * The expression language opens files and reads the environment on its own: `load`, `load_str`,
 * `strload`, `load_xml`, `load_props` and `load_base64` each take a path, and `env` / `strenv` /
 * `envsubst` reach the environment. None of that is visible to a flag or operand check —
 * `yq 'load_str(env(SICLAW_CREDENTIALS_DIR) + "/clusters/default.kubeconfig")'` is a single
 * quoted argument with no path in it.
 *
 * `eval` is rejected for the same reason, and rejecting it is what makes screening the literal
 * text sound: it compiles a STRING as an expression, so `eval("lo" + "ad_str(\"/x\")")` rebuilds a
 * blocked operator from fragments no token scan can match. Without `eval`, concatenating an
 * operator name is a yq parse error, so the operator has to appear literally to run at all.
 *
 * Key ACCESS is deliberately untouched: an operator call always carries `(`, while
 * `.spec.containers[].env` — the most common k8s query there is — never does.
 */
const YQ_BLOCKED_OPERATORS: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /(?<![.\w-])(?:str)?load\w*\s*\(/i, what: "a file operator (load / load_str / strload / load_xml / load_props / load_base64)" },
  { pattern: /(?<![.\w-])(?:str)?env\w*\s*\(/i, what: "an environment operator (env / strenv)" },
  { pattern: /(?<![.\w-])envsubst/i, what: "the envsubst operator" },
  { pattern: /(?<![.\w-])eval\s*\(/i, what: "the eval operator, which can reconstruct any blocked operator from string fragments" },
  { pattern: /(?<![.\w-])system\s*\(/i, what: "the system operator" },
];

const YQ_ALLOWED_FLAGS = [
  "-r", "--raw-output", "-e", "--exit-status", "-o", "--output-format",
  "-P", "--prettyprint", "-C", "--colors", "-M", "--no-colors",
  "-N", "--no-doc", "-j", "--tojson", "-p", "--input-format",
  "--xml-attribute-prefix", "--xml-content-name",
  "--unwrapScalar", "--nul-output", "--header-preprocess",
  // NOTE: -s/--split-exp intentionally excluded — mikefarah yq's --split-exp writes each
  // document to a separate FILE (write capability); output must stay on stdout.
];

/**
 * validate() takes full responsibility for a command, so the flag whitelist is applied here
 * explicitly rather than declaratively — the two are mutually exclusive by design.
 */
function validateYq(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) continue;
    for (const { pattern, what } of YQ_BLOCKED_OPERATORS) {
      if (pattern.test(arg)) {
        return JSON.stringify({
          error: `yq expression uses ${what}. These read files and the environment from inside the expression, independent of the arguments, so they are not permitted. Query the piped document instead, and use the dedicated file tools to read a file.`,
        }, null, 2);
      }
    }
  }
  return validateByRule(args, { command: "yq", allowedFlags: YQ_ALLOWED_FLAGS });
}

function validateNvidiaSmi(args: string[]): string | null {
  if (args.length <= 1) return null;

  // nvidia-smi takes its subcommand FIRST, so an unrecognised leading word is a subcommand we do
  // not permit — not a stray operand to be skipped. `nvidia-smi daemon` starts a root background
  // daemon and used to be accepted, because the argv walk below only ever inspected flags. Later
  // positionals stay unchecked on purpose: they are flag values, and every mutating nvidia-smi
  // operation is either a flag or a leading subcommand.
  if (!args[1].startsWith("-") && !NVIDIA_SMI_SUBCMD_FLAGS.has(args[1])) {
    return JSON.stringify({
      error: `nvidia-smi "${args[1]}" is not an allowed subcommand. Only read-only queries and the ${[...NVIDIA_SMI_SUBCMD_FLAGS.keys()].sort().join(" / ")} subcommands are permitted.`,
    }, null, 2);
  }

  // A subcommand switches the whole invocation to that subcommand's flag set. Looked up in a
  // Map, not an object: `"constructor" in obj` is true through the prototype chain, and the
  // Function it returns has no .has — a caller could throw the validator by typing that word.
  const subcmd = args.slice(1).find((a) => !a.startsWith("-") && NVIDIA_SMI_SUBCMD_FLAGS.has(a));
  const allowed = (subcmd && NVIDIA_SMI_SUBCMD_FLAGS.get(subcmd)) || NVIDIA_SMI_SAFE_FLAGS;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue;
    const flag = extractFlag(arg);
    if (allowed.has(flag)) continue;
    if (!subcmd && startsWithAny(arg, NVIDIA_SMI_SAFE_PREFIXES)) continue;
    return JSON.stringify({
      error: subcmd
        ? `nvidia-smi ${subcmd} "${arg}" is not allowed. Only read-only ${subcmd} queries are permitted.`
        : `nvidia-smi "${arg}" is not allowed. Only read-only nvidia-smi queries are permitted.`,
      ...(subcmd && { allowed: [...allowed].sort() }),
    }, null, 2);
  }
  return null;
}

// ─── date ────────────────────────────────────────────────────────

const DATE_SAFE_FLAGS = new Set([
  "-d", "--date", "-u", "--utc", "--universal",
  "-I", "--iso-8601", "-R", "--rfc-email", "--rfc-3339",
  "-r", "--reference",
]);
const DATE_SAFE_PREFIXES = [
  "-d=", "--date=", "-I=", "--iso-8601=", "--rfc-3339=", "-r=", "--reference=",
];

function validateDate(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("+")) continue; // format string
    if (arg.startsWith("-")) {
      const flag = extractFlag(arg);
      if (!DATE_SAFE_FLAGS.has(flag) && !startsWithAny(arg, DATE_SAFE_PREFIXES)) {
        return JSON.stringify({
          error: `date "${arg}" is not allowed. Only read-only date queries are permitted.`,
        }, null, 2);
      }
      if (DATE_SAFE_FLAGS.has(arg) && (arg === "-d" || arg === "--date" || arg === "-r" || arg === "--reference")) {
        i++;
      }
    } else {
      return JSON.stringify({
        error: `date "${arg}" is not allowed. Only format strings (+...) and read-only flags are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

// ─── sysctl ──────────────────────────────────────────────────────

const SYSCTL_SAFE_FLAGS = new Set([
  "-a", "--all", "-n", "--values", "-e", "--ignore",
  "-N", "--names", "-q", "--quiet", "-b", "--binary",
  "--pattern", "-d", "--deprecated", "-r",
]);
const SYSCTL_SAFE_PREFIXES = ["--pattern=", "-r="];

function validateSysctl(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      const flag = extractFlag(arg);
      if (!SYSCTL_SAFE_FLAGS.has(flag) && !startsWithAny(arg, SYSCTL_SAFE_PREFIXES)) {
        return JSON.stringify({
          error: `sysctl "${arg}" is not allowed. Only read-only sysctl queries are permitted.`,
        }, null, 2);
      }
    } else {
      if (arg.includes("=")) {
        return JSON.stringify({
          error: `sysctl write ("${arg}") is not allowed. Only read-only sysctl queries are permitted.`,
        }, null, 2);
      }
    }
  }
  return null;
}

// ─── ip ──────────────────────────────────────────────────────────

const IP_SAFE_ACTIONS = new Set(["show", "list", "ls", "get"]);

function validateIp(cmd: string): string | null {
  const parts = cmd.trim().split(/\s+/);
  let objectIdx = 1;
  while (objectIdx < parts.length && parts[objectIdx].startsWith("-")) {
    objectIdx++;
  }
  const action = parts[objectIdx + 1];
  if (!action) return null;

  let actionStr = action;
  if (action.startsWith("-")) {
    let i = objectIdx + 2;
    while (i < parts.length && parts[i].startsWith("-")) i++;
    actionStr = parts[i] ?? "";
    if (!actionStr) return null;
  }

  if (!IP_SAFE_ACTIONS.has(actionStr)) {
    return JSON.stringify({
      error: `ip action "${actionStr}" is not allowed. Only read-only actions are permitted.`,
      allowed: [...IP_SAFE_ACTIONS],
    }, null, 2);
  }
  return null;
}

// ─── mount ───────────────────────────────────────────────────────

const MOUNT_SAFE_FLAGS = new Set([
  "-l", "--list", "-t", "--types", "-v", "--verbose", "-n", "--no-mtab",
  "-r", "--read-only",
]);
const MOUNT_SAFE_PREFIXES = ["-t=", "--types="];

function validateMount(args: string[]): string | null {
  let nonFlagCount = 0;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      nonFlagCount++;
      // ONE operand is already an action, not a listing: `mount /mnt` looks the target up in fstab and
      // mounts it. The threshold was two — device AND mountpoint — which let the fstab form through.
      // There is no read-only use for `mount <target>`; listing is the bare command or `-l`.
      if (nonFlagCount >= 1) {
        return JSON.stringify({
          error: `mount with an operand ("${arg}") is not allowed — it mounts a filesystem, and this `
            + "tool is read-only.",
          hint: "A bare `mount` (or `mount -l`) lists mounted filesystems; `findmnt` gives the same "
            + "information with structure.",
        }, null, 2);
      }
      continue;
    }
    const flag = extractFlag(arg);
    if (MOUNT_SAFE_FLAGS.has(flag) || startsWithAny(arg, MOUNT_SAFE_PREFIXES)) {
      // -t/--types consumes next arg as value
      if (!arg.includes("=") && (flag === "-t" || flag === "--types")) {
        i++;
      }
      continue;
    }
    return JSON.stringify({
      error: `mount "${arg}" is not allowed. Only listing mounts is permitted.`,
    }, null, 2);
  }
  return null;
}

// ─── env ─────────────────────────────────────────────────────────

function validateEnv(args: string[]): string | null {
  const restArgs = args.slice(1);
  for (let i = 0; i < restArgs.length; i++) {
    const arg = restArgs[i];
    if (arg === "-u" || arg === "--unset") {
      i++;
      continue;
    }
    if (arg.startsWith("-")) continue;
    if (arg.includes("=")) continue;
    return 'env cannot be used to execute commands. Use "printenv" to view environment variables.';
  }
  return null;
}

// ─── ctr ─────────────────────────────────────────────────────────

const CTR_SAFE_ACTIONS = new Set(["ls", "list", "info", "check"]);

function validateCtr(args: string[]): string | null {
  const positional: string[] = [];
  const skipNext = new Set(["-n", "--namespace", "-a", "--address"]);
  for (let i = 1; i < args.length; i++) {
    if (skipNext.has(args[i])) { i++; continue; }
    if (args[i].startsWith("-")) continue;
    positional.push(args[i]);
  }

  if (positional.length === 0) return null;

  if (positional[0] === "version" || positional[0] === "info") return null;

  const action = positional[1];
  if (!action) return null;

  if (!CTR_SAFE_ACTIONS.has(action)) {
    return JSON.stringify({
      error: `ctr action "${action}" on "${positional[0]}" is not allowed. Only read-only actions are permitted.`,
      allowed: [...CTR_SAFE_ACTIONS].sort(),
    }, null, 2);
  }
  return null;
}

// ─── tee ─────────────────────────────────────────────────────────

function validateTee(args: string[]): string | null {
  for (const arg of args.slice(1)) {
    if (arg.startsWith("-")) continue;
    if (arg !== "/dev/null") {
      return JSON.stringify({
        error: `tee to "${arg}" is not allowed. Only "tee" or "tee /dev/null" is permitted.`,
      }, null, 2);
    }
  }
  return null;
}

// ── Stdin-only text commands: file operands ──────────────────────

/**
 * Args of a stdin-only text command that are NOT file operands, and may therefore legitimately
 * carry shell metacharacters: the grep pattern, the jq/yq expression, tr's two SETs.
 *
 * `valueFlags` keeps a flag's value from being counted as the expression (`grep -m 5 PATTERN` —
 * `5` is not the pattern) and lists only flags whose value is NOT a path; a file-taking flag such
 * as `grep -f` or `jq --rawfile` is left out on purpose so its value is screened like any other
 * file operand. `patternFlags` supply the pattern themselves, so once one appears there is no
 * expression left among the positionals and every one of them is a FILE.
 */
interface TextExpressionArgs {
  /**
   * Flags that CONSUME following tokens, mapped to how many. Distinct from `shortValueFlags`, which
   * is about a value ATTACHED inside a short-option cluster (`-ie.`); this is the separated form.
   *
   * Not to be confused with `CommandDef.valueFlags` in this same file, which answers a narrower
   * question — "may a value beginning with `-` follow this flag" — and is consulted by the general
   * flag validator, not here.
   *
   * Without it the value was read as a positional and spent the expression quota: `grep -m 5 PATTERN`
   * treated `5` as the pattern, so the real pattern was screened as a file operand and every regex
   * containing a metacharacter was refused. `jq --arg NAME VALUE` consumes two, which is why this is
   * an arity rather than a set.
   */
  valueFlags?: ReadonlyMap<string, number>;
  /**
   * Single-letter options that CONSUME a value, in getopt terms. Needed because a short-option cluster
   * carries its value inline from the FIRST value-taking letter onward: grep reads `-ie.` as
   * `-i -e '.'`, and `-ifoo` as `-i -f oo` — a pattern FILE, not "-i plus a pattern".
   *
   * Without this, only the letter at position 1 was examined, so `grep -ie. .siclaw/*\/*\/*` looked
   * like an unknown boolean flag: the expression quota stayed unspent and the credential glob behind it
   * was exempted as the pattern.
   */
  shortValueFlags?: readonly string[];
  /** Leading positionals that are an expression, not a file: the grep pattern, jq/yq filter, tr SETs. */
  positionals: number;
  /** Flags that supply the expression themselves; their value is a pattern, and no positional is left. */
  patternFlags?: readonly string[];
  /**
   * Flags whose value names a file to READ. In a stdin-only context the flag IS the file read, so it
   * is refused outright rather than screened. Per command, because the same letter differs: `grep -f`
   * is a pattern file, `cut -f` is a field list, `sort -f` is --ignore-case.
   */
  fileFlags?: readonly string[];
}

const GREP_VALUE_FLAGS = new Map<string, number>([
  ["-m", 1], ["--max-count", 1],
  ["-A", 1], ["--after-context", 1],
  ["-B", 1], ["--before-context", 1],
  ["-C", 1], ["--context", 1],
  ["-d", 1], ["--directories", 1],
  ["-D", 1], ["--devices", 1],
]);

const GREP_EXPRESSION_ARGS: TextExpressionArgs = {
  positionals: 1,
  patternFlags: ["-e", "--regexp"],
  fileFlags: ["-f", "--file"],
  valueFlags: GREP_VALUE_FLAGS,
  // e=pattern f=pattern-file m=max-count A/B/C=context d=directories D=devices
  shortValueFlags: ["e", "f", "m", "A", "B", "C", "d", "D"],
};

// Keyed by a Map, not a plain object: both the command name and the flag come from the caller, and
// `obj["constructor"]` resolves through the prototype chain to something that is not a rule.
const TEXT_EXPRESSION_ARGS = new Map<string, TextExpressionArgs>([
  ["grep", GREP_EXPRESSION_ARGS],
  ["egrep", GREP_EXPRESSION_ARGS],
  ["fgrep", GREP_EXPRESSION_ARGS],
  ["jq", { positionals: 1, fileFlags: ["-f", "--from-file", "--rawfile", "--slurpfile"], shortValueFlags: ["f"],
    valueFlags: new Map([["--arg", 2], ["--argjson", 2], ["--indent", 1]]) }],
  ["yq", { positionals: 1, fileFlags: ["--from-file"], shortValueFlags: ["o", "p"],
    valueFlags: new Map([["-o", 1], ["--output-format", 1], ["-p", 1], ["--input-format", 1], ["-I", 1], ["--indent", 1]]) }],
  ["wc", { positionals: 0, fileFlags: ["--files0-from"] }],
  ["sort", { positionals: 0, fileFlags: ["--files0-from"] }],
  ["tr", { positionals: 2 }],
]);

/**
 * A stdin-only text command may not name a path, and the check has to hold BEFORE the shell
 * expands anything.
 *
 * The literal-prefix rule (`/`, `./`, `../`, `~`) and the sensitive-path patterns both match text,
 * so every form of expansion defeats them. The credentials sit INSIDE the workdir — `WORKDIR /app`,
 * credentials at `/app/.siclaw/credentials/` — which is what makes this reachable without ever
 * spelling a credential path:
 *
 *     printf x | head .siclaw/*\/*\/*                    ← glob, no literal, no leading /
 *     printf x | column .sic*\/credentials/clusters/*     ← partial component
 *     printf x | head .siclaw/{credentials,x}/clusters/*  ← brace expansion
 *     printf x | column "$SICLAW_CREDENTIALS_DIR"/clusters/*
 *
 * So the rule is not "reject things that look expanded" but: **a file operand may not contain a
 * path separator or any construct the shell rewrites.** Reaching a credential from the workdir
 * requires at least one `/` (the tree is two levels down, and nothing in the whitelist can create a
 * symlink or change directory), which is what makes screening for `/` plus the expansion
 * metacharacters sufficient rather than a guess about which shapes are dangerous.
 *
 * An earlier revision of this rule allowed globs, reasoning that `*` cannot match `..` and so cannot
 * climb out of the workdir. That is true and irrelevant: the credentials are BELOW the workdir, not
 * above it. The exception is gone — the payloads above are regression tests.
 *
 * Values of flags are screened the same way, since `--file=$SICLAW_CREDENTIALS_DIR/x` hides the
 * operand inside a token that starts with `-`. Expression values are exempt: a grep pattern
 * legitimately contains `$`, `[` and `/`.
 *
 * Scope note: this is defense in depth, not the boundary. The same payloads work on `sort`, `cut`,
 * `head`, `tail` and `grep`, which have shipped in the image all along, and the documented boundary
 * for credentials is filesystem permissions — see security.md §4.6 for why that boundary is not
 * currently where ADR-010 says it is.
 */
const TEXT_OPERAND_FORBIDDEN = /[/*?[\]{}~`]|\$/;

/**
 * An expression the SHELL will rewrite before the command ever sees it.
 *
 * The expression slot — grep's pattern, jq's filter, tr's SETs — is exempt from the operand rule
 * because a regex legitimately contains `$`, `[` and `/`. That exemption was total, so an UNQUOTED
 * glob placed there was exempt too: a downward glob into the credential tree reaches grep as an
 * expanded list of paths, the first becoming the pattern and the rest becoming files it reads.
 *
 * Quoting is the discriminator, not shape: a quoted `a.*b` cannot expand, a bare glob must. That also
 * makes the refusal actionable, which is why the hint carries the corrected command rather than a
 * rule — an unquoted regex is a latent bug in its own right, since a matching filename in the
 * working directory silently replaces the pattern.
 */
function rejectUnquotedExpansion(baseName: string, arg: string, expansion: string | undefined): string | null {
  if (!expansion) return null;
  return JSON.stringify({
    error: `${baseName} expression "${arg}" contains an unquoted "${expansion}", which the shell expands `
      + `into file names before ${baseName} runs — so this would be a list of paths, not a pattern.`,
    matched: expansion,
    rejected_by: "unquoted_expansion",
    hint: `Quote the expression so the shell passes it through literally: ${baseName} ... '${arg}'`,
  }, null, 2);
}

/**
 * The blocked long option this one abbreviates, if any.
 *
 * `getopt_long` accepts any unambiguous PREFIX, so a denylist keyed on full spellings is two
 * characters away from useless: real GNU grep 3.8 runs `--recursi` as `--recursive` and
 * `--di=recurse` as `--directories=recurse`. Measured in the agentbox base image, not assumed.
 *
 * Resolution is deliberately one-sided — it only ever maps an abbreviation ONTO something already
 * blocked, so an ambiguous prefix that real grep would refuse anyway is refused here too, while a
 * prefix that cannot mean a blocked flag (`--reg` for `--regexp`) is untouched.
 */
function blockedLongAbbrev(flag: string, blocked: Iterable<string>): string | null {
  if (!flag.startsWith("--") || flag.length <= 2) return null;
  for (const candidate of blocked) {
    if (candidate.startsWith("--") && candidate !== flag && candidate.startsWith(flag)) return candidate;
  }
  return null;
}

function rejectPathishOperand(baseName: string, arg: string, what: string): string | null {
  const bare = arg.replace(/["']/g, "");
  if (!TEXT_OPERAND_FORBIDDEN.test(bare)) return null;
  return JSON.stringify({
    error: `${baseName} ${what} "${arg}" names a path, or contains a glob or expansion that the shell would turn into one. ${baseName} may only process piped input — use the dedicated file tools to read a file.`,
  }, null, 2);
}

// ── Entry point ──────────────────────────────────────────────────

/**
 * Apply context policy constraints for a command.
 * Checks pipeOnly, noFilePaths, and categoryBlockedFlags from CONTEXT_POLICIES.
 * Skipped when context is undefined.
 */
function applyContextPolicy(
  baseName: string,
  parsed: ParsedArg[],
  context: string | undefined,
  piped: boolean | undefined,
): string | null {
  if (!context) return null;
  const args = parsed.map((a) => a.value);
  const def = getCommandDef(baseName);
  if (!def) return null;
  const policy = CONTEXT_POLICIES[context];
  if (!policy) return null;

  // pipeOnly: text commands in local must be piped (implies noFilePaths)
  if (policy.pipeOnlyCategories?.includes(def.category)) {
    if (piped !== undefined && !piped) {
      return JSON.stringify({
        error: `"${baseName}" can only be used after a pipe (|). Direct file reading is not allowed — use the dedicated file tools instead.`,
      }, null, 2);
    }
    // noFilePaths (implicit): no operand, and no flag value, may name a path.
    //
    // Two different questions are asked here, of two different sets of arguments, and keeping them
    // apart is what makes this safe to relax:
    //
    //   Q1  will the SHELL turn this into a path?      — asked of the EXPRESSION slot only
    //   Q2  does this argument name a file?            — asked of everything else, unchanged
    //
    // Q1 is new. The expression slot used to be exempt from everything, which is how an unquoted
    // glob reached grep as a list of files. Q2 is untouched, and needs no Q1 of its own: its
    // character class is a strict superset of the expansion metacharacters AND it matches after
    // quotes are stripped, so anything Q1 would catch there is already refused.
    const spec = TEXT_EXPRESSION_ARGS.get(baseName);
    let expressionsLeft = spec?.positionals ?? 0;
    let expressionValueFollows = false;
    let plainValuesLeft = 0;
    let plainValueFlag = "";
    for (let i = 1; i < parsed.length; i++) {
      const { value: arg, expansion } = parsed[i];

      // The value of a pattern-supplying flag is an expression, not a path — `grep -e 'foo$bar'`
      // and `grep -e '/var/log/pods'` are ordinary regexes. Exempt from Q2, subject to Q1.
      if (expressionValueFollows) {
        expressionValueFollows = false;
        const err = rejectUnquotedExpansion(baseName, arg, expansion);
        if (err) return err;
        continue;
      }

      // A value-flag's value is neither an expression nor a positional. CONSUMING it is what stops
      // `grep -m 5 PATTERN` from spending the pattern quota on `5`; SCREENING it is what stops
      // `grep -m /etc/shadow` from hiding a path there. Both halves are load-bearing.
      if (plainValuesLeft > 0) {
        plainValuesLeft--;
        const err = rejectPathishOperand(baseName, arg, `flag value for "${plainValueFlag}"`);
        if (err) return err;
        continue;
      }

      // `-` means stdin, which is the only input these commands are supposed to have.
      if (arg === "-") continue;

      if (arg.startsWith("-")) {
        // Short options cluster, and the value belongs to the FIRST letter that takes one: grep reads
        // `-ie.` as `-i -e '.'` and `-ifoo` as `-i -f oo`. extractFlag only splits on `=`, and an
        // earlier revision only examined the letter at position 1 — so `-ie.` read as an unknown
        // boolean, the expression quota stayed unspent, and a credential glob behind it was accepted.
        let flag = extractFlag(arg);
        let inlineValue = arg.length > flag.length ? arg.slice(flag.length).replace(/^=/, "") : "";
        if (!inlineValue && !arg.startsWith("--") && arg.length > 2 && spec?.shortValueFlags) {
          for (let c = 1; c < arg.length; c++) {
            if (!spec.shortValueFlags.includes(arg[c])) continue;
            flag = `-${arg[c]}`;
            inlineValue = arg.slice(c + 1);   // "" means the value is the NEXT token
            break;
          }
        }

        if (spec?.fileFlags?.includes(flag)) {
          return JSON.stringify({
            error: `${baseName} "${flag}" reads a file, which is not allowed here — ${baseName} may only process piped input. Use the dedicated file tools to read a file.`,
          }, null, 2);
        }

        if (spec?.patternFlags?.includes(flag)) {
          // The pattern came from the flag, so no positional is the expression any more.
          expressionsLeft = 0;
          if (!inlineValue) { expressionValueFollows = true; continue; }
          // An attached pattern (`-e.siclaw/…`) is still an expression, and still must not expand.
          const err = rejectUnquotedExpansion(baseName, arg, expansion);
          if (err) return err;
          continue;
        }

        const arity = spec?.valueFlags?.get(flag);
        if (arity !== undefined && !inlineValue) {
          plainValuesLeft = arity;
          plainValueFlag = flag;
          continue;
        }

        // Any other flag's value is screened like an operand: `--file=$DIR/x` hides a path inside a
        // token that starts with `-`, which an operand-only check never looks at.
        if (inlineValue) {
          const err = rejectPathishOperand(baseName, inlineValue, `flag value for "${flag}"`);
          if (err) return err;
        }
        continue;
      }

      if (expressionsLeft > 0) {
        expressionsLeft--;
        const err = rejectUnquotedExpansion(baseName, arg, expansion);
        if (err) return err;
        continue;
      }
      const err = rejectPathishOperand(baseName, arg, "file operand");
      if (err) return err;
    }
  }

  // categoryBlockedFlags: context-specific flag blocking (e.g., -r/-R for text in local)
  const ctxBlocked = policy.categoryBlockedFlags?.[def.category];
  if (ctxBlocked) {
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (!arg.startsWith("-")) continue;
      if (arg.startsWith("--")) {
        if (ctxBlocked.includes(extractFlag(arg))) {
          return JSON.stringify({
            error: `${baseName} "${extractFlag(arg)}" is not allowed.`,
          }, null, 2);
        }
      } else if (arg.length > 1) {
        for (const ch of arg.slice(1)) {
          if (ctxBlocked.includes(`-${ch}`)) {
            return JSON.stringify({
              error: `${baseName} "-${ch}" is not allowed.`,
            }, null, 2);
          }
        }
      }
    }
  }

  return null;
}

/**
 * Apply command-intrinsic constraints from CommandDef.
 * These are global (context-independent): allowedFlags, blockedFlags,
 * allowedSubcommands, positionals, requiredFlags, validate.
 */
function applyCommandConstraints(
  baseName: string,
  args: string[],
  def: CommandDef,
): string | null {
  const hasDeclarative = def.blockedFlags || def.blockedFlagValues || def.allowedFlags ||
    def.allowedSubcommands || def.positionals || def.requiredFlags || def.valueFlags;

  // Custom validator takes priority (escape hatch for complex commands)
  if (def.validate) {
    // Dev-time guard: validate and declarative constraints are mutually exclusive
    if (hasDeclarative) {
      throw new Error(
        `CommandDef "${baseName}" has both validate() and declarative constraints. ` +
        `These are mutually exclusive — validate() takes full responsibility.`,
      );
    }
    return def.validate(args);
  }

  // Declarative constraints — reuse the existing validateByRule logic
  // by constructing a compatible rule object from CommandDef fields.
  if (!hasDeclarative) return null;

  return validateByRule(args, {
    command: baseName,
    blockedFlags: def.blockedFlags,
    blockedFlagValues: def.blockedFlagValues,
    allowedFlags: def.allowedFlags,
    allowedSubcommands: def.allowedSubcommands,
    positionals: def.positionals,
    requiredFlags: def.requiredFlags,
    valueFlags: def.valueFlags,
  });
}

/**
 * Apply extra security restrictions to whitelisted commands.
 * Takes a raw command string, parses it internally.
 * Optionally accepts context (for context-specific rules) and piped
 * (for pipe-only enforcement).
 * Returns an error message string if blocked, or null if allowed.
 */
/**
 * What to do instead, for the refusals a review saw someone work around by guessing.
 *
 * Keyed on `command subcommand`. Only entries where a real substitute exists — an empty hint is worse
 * than none, and the `allowed` list beside it already covers the general case.
 */
// Also a Map, for the same reason.
const SUBCOMMAND_ALTERNATIVES = new Map<string, string>(Object.entries({
  "crictl exec": "Entering a container is not available here. Use `pod_exec` (which enters through the "
    + "Kubernetes API with the same read-only validation), or read what you need from outside with "
    + "`crictl inspect` / `crictl logs`.",
  "crictl run": "This tool does not start containers. `crictl inspect`, `crictl ps` and `crictl logs` "
    + "cover inspection of what is already running.",
  "crictl rm": "This tool is read-only; container lifecycle changes are out of scope.",
  "crictl rmi": "This tool is read-only; image removal is out of scope.",
  "crictl stop": "This tool is read-only; stopping a container is out of scope.",
}));

/**
 * Flags that turn a read-only tool into a command RUNNER, and other write switches that survive an
 * `allowedSubcommands` match.
 *
 * `allowedSubcommands` returns as soon as the subcommand is in the set, so nothing after it is examined.
 * That is how `ip -batch /tmp/commands` passed: `-batch` reads a FILE OF COMMANDS and executes them, so
 * the whole read-only argument collapses. `bridge`, `tc` and `rdma` share the switch. `conntrack -z`
 * zeroes counters, and `nvme`'s `--output-file` writes to disk.
 */
// A Map, not an object literal: a command named `constructor` or `toString` reads a Function off
// Object.prototype, and the `.flags.test()` below then throws. This PR already fixed that class of bug
// in the rule lookups and an existing test caught me reintroducing it here.
const WRITE_FLAGS_BY_COMMAND = new Map<string, { flags: RegExp; why: string }>(Object.entries({
  ip:        { flags: /^(-batch|-b|--batch)$/, why: "-batch reads a file of commands and executes them" },
  bridge:    { flags: /^(-batch|-b|--batch)$/, why: "-batch reads a file of commands and executes them" },
  tc:        { flags: /^(-batch|-b|--batch)$/, why: "-batch reads a file of commands and executes them" },
  rdma:      { flags: /^(-batch|-b|--batch)$/, why: "-batch reads a file of commands and executes them" },
  conntrack: { flags: /^(-z|--zero|-D|--delete|-F|--flush|-U|--update|-I|--create)$/,
               why: "it modifies or clears connection tracking state" },
  nvme:      { flags: /^(--output-file|-o|--fw-file)(=.*)?$/, why: "it writes to a file on the target" },
}));

/** A write switch present on an otherwise read-only command. */
function checkWriteFlags(cmd: string, args: string[]): string | null {
  const rule = WRITE_FLAGS_BY_COMMAND.get(cmd);
  if (!rule) return null;
  const hit = args.slice(1).find((a) => rule.flags.test(a));
  if (!hit) return null;
  return JSON.stringify({
    error: `${cmd} "${hit}" is not allowed — ${rule.why}.`,
    hint: "This tool is read-only. Issue the individual read commands instead of a batch or a write.",
  }, null, 2);
}

export function validateCommandRestrictions(
  cmd: string,
  options?: { context?: string; piped?: boolean },
): string | null {
  const parsed = parseArgsWithExpansion(cmd);
  const args = parsed.map((a) => a.value);
  if (args.length === 0) return null;

  const baseName = args[0].split("/").pop()?.toLowerCase() ?? "";
  const def = getCommandDef(baseName);
  if (!def) return null;

  // 1. Context policy constraints (pipeOnly, categoryBlockedFlags)
  const ctxErr = applyContextPolicy(baseName, parsed, options?.context, options?.piped);
  if (ctxErr) return ctxErr;

  // 2. Write switches, BEFORE any per-command validator or allowedSubcommands match. Both of those
  //    return as soon as the subcommand/action looks read-only and never examine the rest of the
  //    argument list — which is how `ip -batch <file>` passed: validateIp skips leading flags to find
  //    the object, so it never saw that `-batch` makes the whole thing a command runner. A permitted
  //    verb does not make its flags safe.
  const writeFlag = checkWriteFlags(baseName, args);
  if (writeFlag) return writeFlag;

  // 3. Command-intrinsic constraints (validate function or declarative rules)
  return applyCommandConstraints(baseName, args, def);
}

// ── kubectl subcommand validation ────────────────────────────────
//
// Moved from kubectl.ts (which held createKubectlTool — dead code,
// never registered in agent-factory). These functions are consumed
// by restricted-bash.ts for pipeline-level kubectl validation.

export const SAFE_SUBCOMMANDS = new Set([
  "get",
  "describe",
  "logs",
  "top",
  "events",
  "api-resources",
  "api-versions",
  "cluster-info",
  "config",
  "version",
  "explain",
  "auth",
]);

/**
 * Subcommands where -A/--all-namespaces is restricted:
 * - "get": only blocked when combined with -o yaml/json (bulk serialization)
 * - "describe", "events", "top": always blocked without selectors
 */
const ALL_NS_ALWAYS_NEED_SELECTOR = new Set(["describe", "events", "top"]);

/**
 * Detect if a kubectl -A/--all-namespaces usage should be blocked.
 *
 * Rules:
 * - `get -A` is allowed UNLESS combined with `-o yaml` or `-o json`
 *   (bulk serialization can return GBs of data on large clusters).
 * - `describe/events/top -A` without a selector (-l, --field-selector) is always blocked.
 * - Other subcommands (logs, exec, etc.) are not affected.
 *
 * Returns a descriptive reason string if blocked, or null if allowed.
 */
/**
 * Does this argv name Secrets as a resource?
 *
 * Scans EVERY non-flag token rather than trying to find "the resource", which is what an earlier version
 * did — and it picked flag VALUES: `kubectl get -o yaml secret demo` and
 * `kubectl get -n default secret demo -o yaml` both slipped through with `yaml` / `default` mistaken for
 * the resource. Scanning every positional makes flag arity irrelevant, and arity is exactly the thing
 * that cannot be tracked reliably across kubectl versions.
 *
 * Handles the forms kubectl actually accepts: `secret`, `secrets`, `secret/name`, and comma lists
 * (`secret,pod`). NOT abbreviations — verified against a live cluster, `kubectl get sec` is rejected by
 * kubectl itself ("the server doesn't have a resource type"), and Secrets have no registered short name.
 *
 * Deliberate false positive: a ConfigMap literally named `secret` (`kubectl get cm secret -o yaml`) is
 * refused. The wrong direction here leaks a credential; the wrong direction there is one confusing
 * refusal, so this is the trade taken on purpose.
 */
export function argsNameSecrets(args: string[], subcommand: string): boolean {
  // `get --raw /api/v1/namespaces/x/secrets/y` names a Secret in a PATH, not a resource token: the
  // loop below takes `split("/")[0]` and gets "" for an absolute path, so it saw nothing. Any
  // `/secrets` segment counts.
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const rawPath = a === "--raw" ? args[i + 1] : a.startsWith("--raw=") ? a.slice("--raw=".length) : undefined;
    if (rawPath && rawPath.split("?")[0].split("/").some((seg) => seg === "secrets" || seg === "secret")) {
      return true;
    }
  }
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-") || a === subcommand) continue;
    for (const part of a.split(",")) {
      // `type/name`, then `type.version[.group]` — kubectl accepts both, and the second needs the
      // TRAILING dot for a core-group resource. Checked against a live cluster rather than assumed:
      //
      //   secrets.v1.   leaks      secrets.v1     rejected by kubectl ("no resource type")
      //   secret.v1.    leaks      secrets.core   rejected
      //   secrets.      leaks
      //
      // So the review's spelling (`secrets.v1`) is not itself reachable, but the family is — taking the
      // segment before the first dot covers every form kubectl actually accepts.
      const type = normalizeResourceToken(part);
      if (type === "secret" || type === "secrets") return true;
    }
  }
  return false;
}

/**
 * Output formats a Secret may be printed in.
 *
 * `-o json` is safe because the structural sanitizer redacts EVERY value under `data`/`stringData`
 * unconditionally — it does not try to judge the value. Table, `wide` and `name` never print `data` at
 * all. Everything else must be refused, because it can emit a bare value with no key beside it:
 *
 *     kubectl get secret demo -o 'jsonpath={.data.password}'   →  c3VwZXItc2VjcmV0
 *
 * A text redactor cannot save that. It keys on sensitive NAMES or on value shapes, and one base64 blob
 * on its own has neither — nor should it be asked to, since guessing whether an arbitrary string is a
 * secret is not a decidable problem. `-o yaml` is refused for the same reason and not an obvious one:
 * a Secret whose data key is not itself sensitive-sounding (`config: <base64>`) sails through the key
 * matcher.
 */
const SECRET_SAFE_FORMATS = new Set([null, "wide", "name", "json"]);

/**
 * Refuse a Secret read whose output format could print the secret itself.
 * Returns a reason string, or null when the command is fine.
 */
export function checkSecretOutputFormat(args: string[], subcommand: string): string | null {
  if (subcommand !== "get") return null;
  if (!argsNameSecrets(args, subcommand)) return null;

  // EVERY declared format is checked, not the first and not only the effective one.
  //
  // kubectl is last-wins: `-o json -o jsonpath={.data.password}` prints the bare base64, measured against
  // a live cluster. Reading the first format let a safe `-o json` in front of an unsafe one through. And
  // a command that declares an unsafe format is not worth defending even when kubectl would ignore it —
  // refusing on ANY unsafe entry costs nothing real and removes a whole class of ordering tricks.
  const formats = kubectlOutputFormats(args);
  const unsafe = formats.find((f) => !SECRET_SAFE_FORMATS.has(f));
  if (formats.length === 0 || unsafe === undefined) return null;
  const format = unsafe;

  return `"kubectl get secret -o ${format}" can print the secret's own values, which no output filter `
    + `can reliably redact — a lone base64 value carries no key name and no recognisable shape. `
    + `Use one of:\n`
    + `  kubectl get secret <name> -o json      (values redacted, structure intact)\n`
    + `  kubectl get secret <name>              (type, key count, age)\n`
    + `  kubectl describe secret <name>         (key names and byte counts, no values)`;
}

/**
 * Does a field selector pin the result to ONE node or ONE object identity?
 *
 * `-A -o json` is refused because serializing every object of a kind is the concern. A server-side
 * `--field-selector spec.nodeName=<exact>` removes that concern rather than papering over it: the
 * apiserver returns one node's pods, which is the same order of magnitude as `-n <namespace> -o json`
 * — already permitted. `involvedObject.uid=<exact>` is the Event equivalent: one immutable object
 * incarnation, across namespaces. Seven separate review findings hit the node case, all of them
 * node-scoped triage that then had to fall back to custom-columns and lose the nested fields it needed.
 *
 * `involvedObject.name=<exact>` is admitted only IN CONJUNCTION with `involvedObject.kind`, and only on
 * the Events resource. It is needed because the kubelet does not build a node's event reference from
 * the node object: it writes `ObjectReference{Kind:"Node", Name:nodeName, UID:types.UID(nodeName)}`, so
 * every kubelet-emitted node event carries the node NAME in the uid field. A uid selector therefore
 * silently misses exactly the events node triage needs — NodeNotReady, Rebooted, ImageGCFailed,
 * FreeDiskSpaceFailed — while the controller-manager's events (real uid) still match, so the result
 * looks like a short list rather than a broken query.
 *
 * Why the conjunction, and not the name alone. The first version of this rule admitted the bare name on
 * the argument that it was "the same order as `metadata.name`", and that argument was WRONG. On Events
 * the two fields bound completely different things: `metadata.name` names ONE event object, while
 * `involvedObject.name` names every event about anything called that — of any Kind, in every namespace,
 * and Events are many-per-object. So the bare name bounds neither the namespace count nor the Kind, and
 * `-A -o json` with it is not "a single object identity" in any sense. Pinning the Kind restores the
 * bound to the accepted shape: for a cluster-scoped Kind exactly one object, for a namespaced one at
 * most one per namespace, which is the same structure as the already-permitted `spec.nodeName` (one
 * node's pods across all namespaces).
 *
 * The unbounded case is a STRUCTURAL claim, not an observation: the cluster available for measurement
 * held 59 events in its whole TTL window with no name spanning two namespaces, which is too idle to
 * demonstrate the fan-out. A selector that places no bound on namespace or Kind is refused on the
 * structure, not on a measured blast radius.
 *
 * Narrow on purpose. `status.phase=Running` across all namespaces is NOT bounded and stays refused, and
 * neither is a set or a negation (`!=`, comma-joined alternatives on the same field). The rule is "this
 * selector names a single node or a single object identity", nothing looser.
 */
function hasBoundingFieldSelector(args: string[]): boolean {
  const selector = effectiveFieldSelector(args);
  if (selector === undefined) return false;
  const pinned = pinnedSelectorFields(selector);
  // `metadata.name` needs no resource check: every resource has it, and a name is unique within a
  // namespace whatever the Kind, so the bound holds universally.
  if (pinned.has("metadata.name")) return true;
  // `spec.nodeName` does NOT. The bound being claimed is "one node's pods", which is a fact about Pods —
  // a CRD can declare a `spec.nodeName` selectable field carrying no such bound, and this rule would
  // then be authorising a full `-A -o json` of that CRD.
  if (pinned.has("spec.nodeName") && namesCoreResource(args, CORE_POD_NAMES)) return true;
  // `involvedObject` is a field of core/v1 Event and describes an identity nowhere else, so the rest of
  // this rule is scoped to that exact resource — read from the resource POSITION, not matched as a
  // substring anywhere in the argv.
  if (!namesCoreResource(args, CORE_EVENT_NAMES)) return false;
  // A uid is globally unique to one object incarnation, so it needs no companion.
  if (pinned.has("involvedObject.uid")) return true;
  return pinned.has("involvedObject.name") && pinned.has("involvedObject.kind");
}

/**
 * The selector that will actually RUN. `--field-selector` is a plain string flag, so a repeat REPLACES
 * rather than intersects — exactly the last-wins semantics `getOutputFormat` already had to model for
 * `-o`. An earlier version OR-ed every occurrence, which made
 * `--field-selector metadata.name=x --field-selector status.phase=Running` pass the check while kubectl
 * ran the unbounded second one.
 */
function effectiveFieldSelector(args: string[]): string | undefined {
  let last: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--field-selector" && args[i + 1] !== undefined) last = args[i + 1];
    else if (a.startsWith("--field-selector=")) last = a.slice("--field-selector=".length);
  }
  return last;
}

/**
 * Fields pinned to ONE exact value. A negation pins nothing, an empty value pins nothing, and two terms
 * naming the same field are a SET rather than a pin — `a=1,a=2` matches nothing at the apiserver but
 * must not read here as "a is pinned twice".
 */
function pinnedSelectorFields(selector: string): Map<string, string> {
  const pinned = new Map<string, string>();
  const seen = new Set<string>();
  for (const term of selector.split(",")) {
    const m = /^\s*([A-Za-z][\w.]*)\s*(!=|==|=)\s*([^,!=]*?)\s*$/.exec(term);
    if (!m) continue;
    const [, field, op, value] = m;
    if (seen.has(field)) { pinned.delete(field); continue; }
    seen.add(field);
    if (op === "!=" || value.length === 0) continue;
    pinned.set(field, value);
  }
  return pinned;
}

const CORE_EVENT_NAMES = new Set(["event", "events", "ev"]);
const CORE_POD_NAMES = new Set(["pod", "pods", "po"]);

/** `v1`, `v2beta1` — an API VERSION, which is what sits between a core resource and its trailing dot. */
const API_VERSION_RE = /^v\d+((alpha|beta)\d+)?$/;

/**
 * Is the query's resource one of `names`, in the CORE group, and nothing else?
 *
 * Every exception in `hasBoundingFieldSelector` is a claim about a specific resource's fields, so each
 * one has to know which resource actually ran. Two earlier versions of this got it wrong in different
 * ways, and both are worth stating because the shape of the mistake recurs:
 *
 *   a SUBSTRING scan over every non-flag token, taking the segment before the first dot. It granted the
 *   exception to `events.example.com` (a CRD that merely starts with the word), to
 *   `events.events.k8s.io` (a different API group, whose corresponding field is `regarding`), and to any
 *   command with `events` sitting in a flag's VALUE — `--sort-by events` is not a query against Events.
 *
 *   then a POSITIONAL read that trusted the position. `kubectlPositionals` consumes kubectl's GLOBAL
 *   value flags, not each subcommand's own, so `get --label-columns events widgets.example.com` left
 *   `events` sitting in the resource slot while the real resource was the CRD behind it.
 *
 * Hence the exact-length requirement rather than an ever-growing flag table: an unconsumed flag value can
 * only ADD a positional, never remove one, so demanding exactly `[subcommand, resource]` turns every such
 * shape into a refusal instead of a fail-open. It costs the legitimate
 * `kubectl get events <name> -A …` its exception, which is a command that makes little sense anyway, and
 * a refusal here only withdraws the exception — the ordinary refusal it falls back to names a runnable
 * alternative.
 *
 * The TRAILING DOT is load-bearing. kubectl spells a core-group resource `events` or `events.` or
 * `events.v1.`; `events.v1` means resource `events` in an API GROUP called `v1`, which is a legal group
 * name a CRD can use. An earlier version filtered empty segments away, which erased exactly that
 * distinction and let `events.v1`, `events.v2` and `events.v1beta1` all pass as core.
 *
 * The very first version leaned on "the apiserver rejects these selectors on anything else anyway". That
 * is defence by downstream, which is not how this file works: the predicate has to be right on its own,
 * and ambiguity FAILS CLOSED.
 */
function namesCoreResource(args: string[], names: ReadonlySet<string>): boolean {
  const positionals = kubectlPositionals(args);
  if (positionals.length !== 2) return false;
  const resource = positionals[1];
  // `events,pods` is several resources at once and the bound would have to hold for every one of them;
  // `events/x` is the type/name form, which this rule does not reason about.
  if (resource.includes(",") || resource.includes("/")) return false;
  const parts = resource.split(".");
  if (!names.has(parts[0])) return false;
  if (parts.length === 1) return true;                      // `events`
  if (parts[parts.length - 1] !== "") return false;         // `events.v1` / `events.example.com`
  return parts.slice(1, -1).every((part) => API_VERSION_RE.test(part));  // `events.` / `events.v1.`
}

export function checkAllNamespacesRestriction(args: string[], subcommand: string): string | null {
  // pflag reads `-Ao json` as `-A -o json`, so an exact-token match missed it — and the format reader
  // missed the `-o` in the same cluster, which made `kubectl get secrets -Ao json` a permitted,
  // unsanitized dump of every Secret. One reader for both now.
  if (!kubectlAllNamespaces(args)) return null;

  const hasSelector = args.some(a =>
    a === "-l" ||
    a === "--selector" || a.startsWith("--selector=") ||
    a === "--field-selector" || a.startsWith("--field-selector="),
  );

  // describe/events/top -A without selector → always blocked
  if (ALL_NS_ALWAYS_NEED_SELECTOR.has(subcommand)) {
    if (!hasSelector) {
      return `"kubectl ${subcommand} --all-namespaces" without selectors can overload the API server on `
        + `large clusters. Add a selector, or name a namespace:\n`
        + `  kubectl ${subcommand} -A -l <key>=<value>\n`
        + `  kubectl ${subcommand} -A --field-selector <field>=<value>\n`
        + `  kubectl ${subcommand} -n <namespace>`;
    }
    return null;
  }

  // get -A + -o yaml/json → blocked (even with selector — bulk serialization is the concern)
  if (subcommand === "get") {
    // The EFFECTIVE format, from the shared reader: last-wins, and it decomposes `-Ao json`. A local
    // first-wins copy lived here and is what made the clustered form a permitted, unsanitized dump.
    const format = getOutputFormat(args);
    if (format === "yaml" || format === "json") {
      // An exact server-side node or name selector bounds the response, which is the concern this rule
      // exists for — so the rule is satisfied rather than waived.
      if (hasBoundingFieldSelector(args)) return null;
      // A refusal that names no runnable alternative gets retried in another shape and refused again.
      // The resource is echoed back so the suggestion is copy-pasteable rather than a template.
      const resource = args.find((a, i) => i > 0 && !a.startsWith("-") && a !== subcommand) ?? "<resource>";
      // custom-columns and yaml are refused outright for a Secret (checkSecretOutputFormat), so do not
      // suggest them there — a hint that names a refused command is worse than no hint.
      if (argsNameSecrets(args, subcommand)) {
        return `"kubectl get secrets --all-namespaces -o ${format}" can return excessive data, and for `
          + `Secrets only -o json is permitted at all (values redacted, structure intact):\n`
          + `  kubectl get secrets -n <namespace> -o json\n`
          + `  kubectl get secrets -n <namespace>`;
      }
      return `"kubectl get --all-namespaces -o ${format}" can return excessive data — serializing every `
        + `${resource} in the cluster is the concern, so a client-side selector does not lift it. A `
        + `server-side --field-selector that pins spec.nodeName or metadata.name to ONE exact value IS `
        + `accepted, because it bounds what the apiserver serializes. On events, involvedObject.uid `
        + `alone is accepted, and involvedObject.name only TOGETHER with involvedObject.kind — a name `
        + `with no kind matches events for any Kind in every namespace. A label selector or a phase `
        + `filter is not accepted — those can still match the whole cluster. Instead:\n`
        + `  kubectl get ${resource} -A --field-selector spec.nodeName=<node> -o json   (accepted)\n`
        + `  kubectl get ${resource} -A -o custom-columns=NS:.metadata.namespace,NAME:.metadata.name`
        + `   (add the fields you need — these two exist on every resource)\n`
        + `  kubectl get ${resource} -A -o wide                     (a fixed, bounded set of columns)\n`
        + `  kubectl get ${resource} -n <namespace> -o ${format}    (full serialization, one namespace)`;
    }
  }

  return null;
}



// Keep backward-compatible export for any external callers
export function hasAllNamespacesWithoutSelector(args: string[], subcommand: string): boolean {
  return checkAllNamespacesRestriction(args, subcommand) !== null;
}

// ══════════════════════════════════════════════════════════════════
// ── Unified Command Registry (COMMANDS + CONTEXT_POLICIES) ──────
// ══════════════════════════════════════════════════════════════════
//
// Single source of truth for which commands are allowed, what category
// they belong to, and what constraints apply. Replaces the legacy
// ALLOWED_COMMANDS + COMMAND_CATEGORIES + COMMAND_RULES + CUSTOM_VALIDATORS.

export type CommandCategory =
  | "text" | "network" | "rdma" | "perftest" | "gpu"
  | "hardware" | "kernel" | "process" | "file"
  | "diagnostic" | "services" | "container" | "firewall"
  | "inspection" | "compressed" | "activity" | "stream"
  | "general" | "general-env" | "flow";

/**
 * A single command's complete security definition.
 *
 * - `category`: determines context availability (via CONTEXT_POLICIES)
 * - Declarative constraints: global, enforced in ALL contexts
 * - `validate`: escape hatch for commands too complex for declarative rules
 *
 * Context-specific constraints (pipeOnly in local, text blockedFlags in local)
 * are NOT here — they live in CONTEXT_POLICIES.
 *
 * **Serializability**: Unlike the old `CommandRule`, `CommandDef` is NOT
 * JSON-serializable when `validate` is set. This is a deliberate trade-off —
 * direct function references give type safety and refactoring support over
 * the old string-key-based `customValidator` + runtime registry lookup.
 *
 * **Mutual exclusion**: `validate` and declarative constraints (blockedFlags,
 * allowedFlags, etc.) are mutually exclusive. When `validate` is set, it takes
 * full responsibility for the command's validation — declarative fields are
 * ignored. Do not combine both on the same command.
 */
export interface CommandDef {
  category: CommandCategory;
  blockedFlags?: string[];
  /**
   * Values that turn an otherwise-permitted flag into a blocked one.
   *
   *
   * `blockedFlags` names a SWITCH, which is not always where the capability lives: GNU grep spells
   * recursion both `-r` and `-d recurse`, so blocking only the former left the identical capability
   * one synonym away — and a recursive grep started at `.` walks into the credential tree without
   * the command ever naming a path, which is the one thing the stdin-only operand rules exist to
   * prevent. Keyed by a Map because both the flag and the value come from the caller.
   */
  blockedFlagValues?: ReadonlyMap<string, readonly string[]>;
  allowedFlags?: string[];
  allowedSubcommands?: { position: number; allowed: string[] };
  positionals?: "allow" | "block" | number;
  requiredFlags?: string[];
  /** Custom validator — mutually exclusive with declarative constraint fields above. */
  validate?: (args: string[]) => string | null;
  /** Flags whose value may begin with "-" (e.g. journalctl -b -1). */
  valueFlags?: readonly string[];
}

/**
 * Unified command registry.
 *
 * NOTE: sed and awk/gawk are intentionally excluded — they are Turing-complete
 * scripting languages with built-in capabilities for command execution (system(),
 * pipe-to-command), file writes, and shell escapes that cannot be reliably
 * whitelisted. Use grep + cut/tr/head/tail/jq for text processing instead.
 */
export const COMMANDS: Record<string, CommandDef> = {
  // ── text processing ──
  grep:   { category: "text", blockedFlags: ["-r", "-R", "--recursive"],
    blockedFlagValues: new Map([["-d", ["recurse"]], ["--directories", ["recurse"]]]) },
  egrep:  { category: "text", blockedFlags: ["-r", "-R", "--recursive"],
    blockedFlagValues: new Map([["-d", ["recurse"]], ["--directories", ["recurse"]]]) },
  fgrep:  { category: "text", blockedFlags: ["-r", "-R", "--recursive"],
    blockedFlagValues: new Map([["-d", ["recurse"]], ["--directories", ["recurse"]]]) },
  sort:   { category: "text", allowedFlags: [
    "-r", "-n", "-k", "-t", "-u", "-f", "-h", "-V", "-s", "-b", "-g", "-M", "-d", "-i",
    "--reverse", "--numeric-sort", "--key", "--field-separator", "--unique",
    "--human-numeric-sort", "--version-sort", "--stable", "--ignore-leading-blanks",
    "--general-numeric-sort", "--month-sort", "--dictionary-order", "--ignore-case",
  ] },
  uniq:   { category: "text", positionals: 1 },
  wc:     { category: "text" },
  head:   { category: "text" },
  tail:   { category: "text" },
  cut:    { category: "text" },
  tr:     { category: "text" },
  jq:     { category: "text" },
  tac:    { category: "text" }, // reverse-cat — read-only
  nl:     { category: "text" }, // number lines — read-only
  // validateYq screens the EXPRESSION — yq's file and env operators need no flag and no path
  // argument — and applies YQ_ALLOWED_FLAGS itself, since validate() takes full responsibility.
  yq:     { category: "text", validate: validateYq },
  column: { category: "text" },

  // ── network diagnostics ──
  ip:         { category: "network", validate: (args) => validateIp(args.join(" ")) },
  ifconfig:   { category: "network", allowedFlags: ["-a", "-s", "--all", "--short"], positionals: 1 },
  ping:       { category: "network" },
  traceroute: { category: "network" },
  tracepath:  { category: "network" },
  ss:         { category: "network", blockedFlags: ["-K", "--kill"] }, // -K/--kill destroys matching sockets → blocked; reads still allowed
  netstat:    { category: "network" },
  route:      { category: "network", allowedFlags: ["-n", "-e", "-v", "-F", "-C", "--numeric", "--extend", "--verbose"], positionals: "block" },
  arp:        { category: "network", allowedFlags: ["-a", "-n", "-e", "-v", "--all", "--numeric", "--verbose"] },
  ethtool:    { category: "network", allowedFlags: ["-i", "-S", "-T", "-a", "-c", "-g", "-k", "-l", "-P", "-m", "-d", "--phy-statistics"] },
  mtr:        { category: "network" },
  nslookup:   { category: "network" },
  dig:        { category: "network" },
  host:       { category: "network" },
  bridge:     { category: "network", allowedSubcommands: { position: 1, allowed: ["show", "list", "ls"] } },
  tc:         { category: "network", allowedSubcommands: { position: 1, allowed: ["show", "list", "ls"] } },
  conntrack:  { category: "network", validate: validateConntrack },
  curl:       { category: "network", validate: validateCurl },
  tcpdump:    { category: "network", allowedFlags: TCPDUMP_FLAGS },
  nstat:      { category: "network", allowedFlags: ["-a", "--ignore", "-z", "--zeros", "-s", "--noupdate", "-j", "--json"] }, // -d (daemon) rejected
  // getent: nsswitch real resolution path (hosts/networks). Restricted to name-resolution
  // databases so "getent shadow"/"passwd"/"group" can't leak /etc/shadow or enumerate users.
  getent:     { category: "network", allowedSubcommands: { position: 0, allowed: ["hosts", "ahosts", "ahostsv4", "ahostsv6", "networks"] } },
  // resolvectl: systemd-resolved stub resolver. Read-only subcommands only; write subcommands
  // (flush-caches / dns / domain / revert / reset-*) are rejected. Bare `resolvectl` = status → allowed.
  resolvectl: { category: "network", allowedSubcommands: { position: 0, allowed: ["query", "status", "statistics", "service"] } },

  // ── RDMA / RoCE ──
  ibstat:       { category: "rdma" },
  ibstatus:     { category: "rdma" },
  ibv_devinfo:  { category: "rdma" },
  ibv_devices:  { category: "rdma" },
  rdma:         { category: "rdma", allowedSubcommands: { position: 1, allowed: ["show", "list", "ls"] } },
  ibaddr:       { category: "rdma" },
  iblinkinfo:   { category: "rdma" },
  ibportstate:  { category: "rdma", validate: validateIbportstate },
  ibswitches:   { category: "rdma" },
  ibroute:      { category: "rdma" },
  show_gids:    { category: "rdma" },
  ibdev2netdev: { category: "rdma" },
  // ── read-only fabric / link diagnostics (added) ──
  saquery:      { category: "rdma" }, // subnet-admin queries — read-only, no write path
  ibping:       { category: "rdma" }, // RDMA ping — read-only
  perfquery:    { category: "rdma", validate: validatePerfquery }, // flag-aware: blocks reset (flag + 3rd positional), no longer over-blocks flagged reads
  ibqueryerrors:{ category: "rdma", allowedFlags: IBQUERYERRORS_FLAGS }, // default-deny: clear/threshold-file flags rejected
  mst:          { category: "rdma", allowedSubcommands: { position: 0, allowed: ["status", "version"] } }, // start/stop load/unload drivers → not allowed
  mlxlink:      { category: "rdma", allowedFlags: MLXLINK_FLAGS }, // default-deny: only read-only link/PHY/FEC/eye/counter flags

  // ── perftest (11 binaries, shared flags) ──
  ib_write_bw:          { category: "perftest", allowedFlags: PERFTEST_FLAGS },
  ib_write_lat:         { category: "perftest", allowedFlags: PERFTEST_FLAGS },
  ib_read_bw:           { category: "perftest", allowedFlags: PERFTEST_FLAGS },
  ib_read_lat:          { category: "perftest", allowedFlags: PERFTEST_FLAGS },
  ib_send_bw:           { category: "perftest", allowedFlags: PERFTEST_FLAGS },
  ib_send_lat:          { category: "perftest", allowedFlags: PERFTEST_FLAGS },
  ib_atomic_bw:         { category: "perftest", allowedFlags: PERFTEST_FLAGS },
  ib_atomic_lat:        { category: "perftest", allowedFlags: PERFTEST_FLAGS },
  raw_ethernet_bw:      { category: "perftest", allowedFlags: PERFTEST_FLAGS },
  raw_ethernet_lat:     { category: "perftest", allowedFlags: PERFTEST_FLAGS },
  raw_ethernet_burst_lat: { category: "perftest", allowedFlags: PERFTEST_FLAGS },

  // ── GPU ──
  "nvidia-smi": { category: "gpu", validate: validateNvidiaSmi },
  gpustat:      { category: "gpu" },
  nvtopo:       { category: "gpu" },
  // dcgmi: read subcommands AND setter-flag rejection (validateDcgmi) so health/stats can't
  // toggle DCGM watches. "config"/"policy"/"set"/"profile"/"group"/"diag" are not allowed.
  dcgmi:        { category: "gpu", validate: validateDcgmi },

  // ── hardware info ──
  lspci:     { category: "hardware" },
  lsusb:     { category: "hardware" },
  lsblk:     { category: "hardware" },
  lscpu:     { category: "hardware" },
  lsmem:     { category: "hardware" },
  lshw:      { category: "hardware" },
  dmidecode: { category: "hardware", blockedFlags: ["--dump-bin"] }, // --dump-bin <file> writes SMBIOS binary to an arbitrary file → blocked; -u/--dump (stdout) kept
  // ── storage / sensor / topology health (added, read-only) ──
  smartctl:  { category: "hardware", allowedFlags: SMARTCTL_FLAGS }, // default-deny: -t (self-test) / -s (set) rejected
  nvme:      { category: "hardware", allowedSubcommands: { position: 0, allowed: NVME_READ_SUBCMDS } }, // format/sanitize/write/set-feature/fw-* rejected
  sensors:   { category: "hardware", allowedFlags: ["-A", "-u", "-f", "-j", "--no-adapter"] }, // -s (apply config) / -c (read arbitrary file) rejected

  // ── kernel / system ──
  uname:    { category: "kernel" },
  hostname: { category: "kernel", allowedFlags: [
    "-f", "-d", "-s", "-i", "-I", "-A",
    "--fqdn", "--domain", "--short", "--ip-address", "--all-ip-addresses",
  ], positionals: "block" },
  uptime:   { category: "kernel" },
  dmesg:    { category: "kernel", allowedFlags: [
    "-T", "--ctime", "-H", "--human", "-l", "--level", "-f", "--facility",
    "-k", "--kernel", "-x", "--decode", "-L", "--color", "--time-format",
    "--nopager",
    "--since", "--until", "-S", "--syslog", "-t", "--notime", "-P",
  ] },
  sysctl:   { category: "kernel", validate: validateSysctl },
  lsmod:    { category: "kernel" },
  modinfo:  { category: "kernel" },
  getconf:  { category: "kernel" }, // prints system configuration values — read-only

  // ── process / resource ──
  ps:      { category: "process" },
  pgrep:   { category: "process" },
  top:     { category: "process", allowedFlags: [
    "-b", "--batch", "-n", "-d", "-p", "-H", "-c", "-o", "-O",
    "-w", "-1", "-e", "-E", "-i", "-S", "-s", "-u", "-U",
  ], requiredFlags: ["-b", "--batch"] },
  free:    { category: "process" },
  vmstat:  { category: "process" },
  iostat:  { category: "process" },
  mpstat:  { category: "process" },
  df:      { category: "process" },
  du:      { category: "process" },
  mount:   { category: "process", validate: validateMount },
  findmnt: { category: "process" },
  nproc:   { category: "process" },
  // ── added (read-only) ──
  pidstat:  { category: "process" },
  pstree:   { category: "process" },
  numastat: { category: "process" },
  ipcs:     { category: "process" }, // ipcs reads IPC status; ipcrm (the writer) is a separate, un-whitelisted binary

  // ── file inspection (read-only) — category blocked in local context ──
  cat:       { category: "file" },
  ls:        { category: "file" },
  pwd:       { category: "file" },
  stat:      { category: "file" },
  file:      { category: "file" },
  find:      { category: "file", validate: validateFind },
  readlink:  { category: "file" },
  realpath:  { category: "file" },
  basename:  { category: "file" },
  dirname:   { category: "file" },
  diff:      { category: "file" },
  md5sum:    { category: "file" },
  sha256sum: { category: "file" },
  tree:      { category: "file", allowedFlags: TREE_FLAGS }, // default-deny: -o (write output to file) rejected; positional dirs are read targets

  // ── system logs & services ──
  // valueFlags: `-b -1` / `-n -100` pass a NEGATIVE value; without this the value is read as a flag.
  journalctl:  { category: "services", valueFlags: ["-b", "--boot", "-n", "--lines", "-p", "--priority"], allowedFlags: [
    "-u", "--unit", "-n", "--lines", "--since", "--until",
    "-p", "--priority", "-b", "--boot", "-k", "--dmesg",
    "--no-pager", "-o", "--output", "-r", "--reverse",
    "-x", "--catalog", "--system", "--user",
    "-t", "--identifier", "-g", "--grep", "--case-sensitive",
    "-S", "-U", "-e", "--pager-end", "-a", "--all",
    "-q", "--quiet", "--no-hostname", "--no-full",
    "-m", "--merge", "-D", "--directory", "--file", "--list-boots",
  ] },
  systemctl:   { category: "services", allowedSubcommands: { position: 0, allowed: [
    "status", "show", "list-units", "list-unit-files",
    "is-active", "is-enabled", "is-failed", "cat",
    "list-dependencies", "list-sockets", "list-timers",
  ] } },
  timedatectl: { category: "services", allowedSubcommands: { position: 0, allowed: ["status", "show", "list-timezones", "timesync-status"] } },
  hostnamectl: { category: "services", allowedSubcommands: { position: 0, allowed: ["status", "show"] } },

  // ── container runtime ──
  crictl: { category: "container", allowedSubcommands: { position: 0, allowed: [
    "ps", "images", "inspect", "inspecti", "inspectp",
    "logs", "stats", "info", "version", "pods",
  ] } },
  ctr: { category: "container", validate: validateCtr },

  // ── firewall (read-only via allowedFlags) ──
  iptables:  { category: "firewall", allowedFlags: [
    "-L", "--list", "-S", "--list-rules",
    "-n", "--numeric", "-v", "--verbose",
    "-x", "--exact", "--line-numbers", "-t", "--table",
  ] },
  ip6tables: { category: "firewall", allowedFlags: [
    "-L", "--list", "-S", "--list-rules",
    "-n", "--numeric", "-v", "--verbose",
    "-x", "--exact", "--line-numbers", "-t", "--table",
  ] },

  // ── file / process inspection — category blocked in local context ──
  lsof:    { category: "inspection" },
  lsns:    { category: "inspection" },
  strings: { category: "inspection" },
  hexdump: { category: "inspection" }, // reads file/stdin → stdout; no output-file arg
  od:      { category: "inspection" }, // octal/hex dump → stdout; no output-file arg

  // ── compressed file reading — category blocked in local context ──
  zcat:  { category: "compressed" },
  zgrep: { category: "compressed" },
  bzcat: { category: "compressed" },
  xzcat: { category: "compressed" },

  // ── system activity ──
  sar:   { category: "activity", blockedFlags: ["-o"] }, // -o <file> writes sar binary data to a file → blocked; -f (read) unaffected
  blkid: { category: "activity" },

  // ── stream utility ──
  tee: { category: "stream", validate: validateTee },

  // ── general ──
  date:   { category: "general", validate: validateDate },
  whoami: { category: "general" },
  id:     { category: "general" },
  which:  { category: "general" },

  // ── general-env — category blocked in local context ──
  env:      { category: "general-env", validate: validateEnv },
  printenv: { category: "general-env" },

  // ── flow control ──
  echo:   { category: "flow" },
  printf: { category: "flow" },
  true:   { category: "flow" },
  false:  { category: "flow" },
  sleep:  { category: "flow" },
  wait:   { category: "flow" },
  test:   { category: "flow" },
  expr:   { category: "flow" },
  seq:    { category: "flow" },
};

// ── Extra commands (deployment-configured, additive-only) ───────
//
// Loaded from a JSON config at agent startup (see extra-commands.ts and
// docs/design/2026-06-10-extra-command-whitelist.md). Stored SEPARATELY
// from the built-in registry: lookups consult COMMANDS first, so an extra
// entry can never replace or relax a built-in definition.

let extraCommands: Record<string, CommandDef> = {};

export interface SetExtraCommandsResult {
  /** Extra command names now active. */
  applied: string[];
  /** Names dropped because they collide with built-in COMMANDS entries. */
  skipped: string[];
}

/**
 * Replace the active set of extra commands. Built-in collisions are skipped
 * (additive-only contract). Invalidates the per-context allowed-set cache.
 */
export function setExtraCommands(extra: Record<string, CommandDef>): SetExtraCommandsResult {
  const applied: string[] = [];
  const skipped: string[] = [];
  const accepted: Record<string, CommandDef> = {};
  for (const [name, def] of Object.entries(extra)) {
    if (name in COMMANDS) {
      skipped.push(name);
    } else {
      accepted[name] = def;
      applied.push(name);
    }
  }
  extraCommands = accepted;
  contextAllowedCache.clear();
  return { applied, skipped };
}

/** Resolve a command definition: built-in registry first, then extras. */
function getCommandDef(baseName: string): CommandDef | undefined {
  return COMMANDS[baseName] ?? extraCommands[baseName];
}

// ── Context Policies (internal) ─────────────────────────────────
//
// Environment-level constraints. Not exported — only consumed by
// validateCommandRestrictions() internally.

export const ALL_COMMAND_CATEGORIES: readonly CommandCategory[] = [
  "text", "network", "rdma", "perftest", "gpu", "hardware", "kernel",
  "process", "file", "diagnostic", "services", "container", "firewall",
  "inspection", "compressed", "activity", "stream", "general", "general-env",
  "flow",
];

interface ContextPolicy {
  available: readonly CommandCategory[];
  pipeOnlyCategories?: readonly CommandCategory[];
  categoryBlockedFlags?: Partial<Record<CommandCategory, string[]>>;
}

const CONTEXT_POLICIES: Record<string, ContextPolicy> = {
  local: {
    available: [
      "text", "network", "rdma", "perftest", "gpu", "hardware", "kernel",
      "process", "diagnostic", "services", "container", "firewall",
      "activity", "stream", "general", "flow",
    ],
    pipeOnlyCategories: ["text"],
    categoryBlockedFlags: {},
  },
  node: { available: ALL_COMMAND_CATEGORIES },
  pod:  { available: ALL_COMMAND_CATEGORIES },
  host: { available: ALL_COMMAND_CATEGORIES },
};

/**
 * Commands the AgentBox IMAGE must actually provide.
 *
 * This is the one execution context whose binaries we control, so here — and only here — the
 * whitelist can be an availability promise rather than an admission policy. node_exec resolves
 * binaries in the node's namespaces and pod_exec inside the target container, so no image of ours
 * can make a guarantee for them.
 *
 * Scoped to what restricted-bash ADVERTISES: the text-processing category plus kubectl. The
 * `local` context permits ~128 commands because it shares the category table with the node tools,
 * and requiring `nvidia-smi`, `crictl` or `ib_write_bw` in this image would be meaningless — those
 * are permitted there only because the table is shared, and nothing tells the agent they exist.
 *
 * Consumed by docker/agentbox-capability-check.sh, which fails the build on a missing entry: `yq`
 * and `column` were whitelisted and advertised for a long time while no image ever shipped them,
 * and the only symptom was exit 127 at runtime.
 */
export function agentboxRequiredCommands(): string[] {
  const text = Object.entries(COMMANDS)
    .filter(([, def]) => def.category === "text")
    .map(([cmd]) => cmd);
  return [...text, "kubectl"].sort();
}

// ── Context-based allowed command set ──────────────────────────

const contextAllowedCache = new Map<string, ReadonlySet<string>>();

/**
 * Get the set of command names allowed for a given execution context.
 * Computed from COMMANDS + CONTEXT_POLICIES; cached after first call.
 */
export function getContextAllowedSet(context: string): ReadonlySet<string> {
  const cached = contextAllowedCache.get(context);
  if (cached) return cached;

  const policy = CONTEXT_POLICIES[context];
  if (!policy) {
    // Unknown context → all commands
    const all = new Set([...Object.keys(COMMANDS), ...Object.keys(extraCommands)]);
    contextAllowedCache.set(context, all);
    return all;
  }

  const categorySet = new Set<string>(policy.available);
  const cmds = new Set<string>();
  for (const [cmd, def] of [...Object.entries(COMMANDS), ...Object.entries(extraCommands)]) {
    if (categorySet.has(def.category)) cmds.add(cmd);
  }

  contextAllowedCache.set(context, cmds);
  return cmds;
}

// ── Container-context sensitive path patterns ────────────────────

/**
 * Paths that must never be accessed through exec tools.
 * Used by validateCommand (Pass 6).
 *
 * These are paths whose content cannot be reliably sanitized post-execution
 * (binary data, unstructured secrets, password hashes, etc.).
 * Commands whose output CAN be sanitized (env, printenv, crictl inspect)
 * are handled by output-sanitizer instead.
 */
export const CONTAINER_SENSITIVE_PATHS: RegExp[] = [
  // K8s SA token & mounted secrets
  /\/run\/secrets\//,
  /\/var\/run\/secrets\//,
  // Process info (anchored to avoid over-matching)
  /\/proc\/[^/]+\/environ$/,
  /\/proc\/[^/]+\/cmdline$/,
  /\/proc\/[^/]+\/fd\/\d/,   // block reading specific fd (cat /proc/1/fd/3); allow listing (ls /proc/*/fd/)
  /\/proc\/[^/]+\/mem$/,
  /\/proc\/[^/]+\/maps$/,
  /\/proc\/[^/]+\/smaps$/,
  /\/proc\/kcore$/,
  // System credentials
  /\/etc\/shadow$/,
  /\/etc\/gshadow$/,
  /\/etc\/master\.passwd$/,
  // SSH
  /[/]\.ssh\//,
  /id_rsa$/,
  /id_ed25519$/,
  /id_ecdsa$/,
  // TLS key material (.pem excluded — CA certs are public and needed for SRE diagnostics)
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,
  // Cloud provider credentials
  /[/]\.aws\//,
  /[/]\.gcp\//,
  /[/]\.azure\//,
  /[/]\.docker\/config\.json/,
  // K8s control plane
  /\/etc\/kubernetes\/pki\//,
  /\/etc\/kubernetes\/admin\.conf/,
  /\/var\/lib\/kubelet\/pki\//,                         // kubelet certificates
  /\/var\/lib\/kubelet\/pods\/[^/]+\/volumes\/.*secret/, // mounted secrets in pod volumes
  /\/var\/lib\/etcd\//,
  // Shell/DB history
  /\.bash_history/,
  /\.zsh_history/,
  /\.mysql_history/,
  /\.psql_history/,
  /\.node_repl_history/,
];

/**
 * One concrete path per pattern above.
 *
 * The patterns are regexes, so nothing can be intersected with them directly — deciding whether a glob
 * and a regex can match a common string is not something to attempt at validation time. A glob is
 * therefore tested against these literals instead: `cat /etc/*` compiles to `^/etc/(?!\.)[^/]*$`, which
 * matches `/etc/shadow`, so it is refused; `cat /etc/*release*` compiles to a regex that matches none of
 * them, so it runs.
 *
 * The list can drift from the patterns, so it is pinned in both directions: every pattern must match at
 * least one example, and every example must be matched by some pattern. Adding a pattern without an
 * example fails the test rather than silently leaving globs unscreened for it.
 *
 * These are EXAMPLES, not the protected set — the patterns remain authoritative for literal paths.
 */
export const SENSITIVE_PATH_EXAMPLES: readonly string[] = [
  "/run/secrets/kubernetes.io/serviceaccount/token",
  "/var/run/secrets/kubernetes.io/serviceaccount/token",
  "/proc/1/environ",
  "/proc/1/cmdline",
  "/proc/1/fd/3",
  "/proc/1/mem",
  "/proc/1/maps",
  "/proc/1/smaps",
  "/proc/kcore",
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/master.passwd",
  "/root/.ssh/config",
  "/root/.ssh/id_rsa",
  "/root/.ssh/id_ed25519",
  "/root/.ssh/id_ecdsa",
  "/etc/ssl/private/server.key",
  "/etc/ssl/private/keystore.p12",
  "/etc/ssl/private/keystore.pfx",
  "/etc/ssl/private/keystore.jks",
  "/root/.aws/credentials",
  "/root/.gcp/application_default_credentials.json",
  "/root/.azure/accessTokens.json",
  "/root/.docker/config.json",
  "/etc/kubernetes/pki/apiserver.crt",
  "/etc/kubernetes/admin.conf",
  "/var/lib/kubelet/pki/kubelet-client-current.pem",
  "/var/lib/kubelet/pods/2b1f/volumes/kubernetes.io~secret/default-token/token",
  "/var/lib/etcd/member/snap/db",
  "/root/.bash_history",
  "/root/.zsh_history",
  "/root/.mysql_history",
  "/root/.psql_history",
  "/root/.node_repl_history",
];
