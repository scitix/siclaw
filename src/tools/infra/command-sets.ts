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

/**
 * Parse a command string into an array of arguments, respecting quotes.
 * Moved from kubectl.ts to be shared.
 */
export function parseArgs(command: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (const ch of command) {
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
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
  blockedFlags?: string[];
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
        if (rule.blockedFlags.includes(extractFlag(arg))) {
          return JSON.stringify({
            error: `${cmd} "${extractFlag(arg)}" is not allowed.`,
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
 * Read-only option sets for the nvidia-smi subcommands that have their own, taken from NVIDIA's
 * documented option lists rather than from what happened to be needed:
 * https://docs.nvidia.com/deploy/nvidia-smi/index.html
 *
 * Every documented `topo` option is a query, so the set is complete rather than minimal. For
 * `nvlink` the documented queries are listed and the counter-control and counter-reset options are
 * left out — `-sc/--setcontrol` and `-r/--resetcounters` WRITE counter state.
 *
 * These are allowlists, so an option the docs do not show (NVIDIA's page truncates the `nvlink`
 * list) fails closed: the command is refused, never silently widened.
 */
const NVIDIA_SMI_SUBCMD_FLAGS = new Map<string, Set<string>>(Object.entries({
  topo: new Set([
    "-m", "--matrix", "-mp", "-p", "--path", "-i", "-c", "-n", "--nvlink",
    "-p2p", "-C", "-M", "-gnid", "-nvme", "-cpu", "--cpu", "-gpu", "-nic", "-all", "-h",
  ]),
  nvlink: new Set([
    "-s", "--status", "-c", "--capabilities", "-i", "--id", "-l", "--list",
    "-e", "--errorcounters", "-p", "-pcibusid", "-R", "-remotelinkinfo",
    "-gt", "--getthroughput", "-h",
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
      if (nonFlagCount >= 2) {
        return "mount with device and mountpoint arguments is not allowed. Only listing mounts (mount without arguments or with -l) is permitted.";
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

const GREP_EXPRESSION_ARGS: TextExpressionArgs = {
  positionals: 1,
  patternFlags: ["-e", "--regexp"],
  fileFlags: ["-f", "--file"],
};

// Keyed by a Map, not a plain object: both the command name and the flag come from the caller, and
// `obj["constructor"]` resolves through the prototype chain to something that is not a rule.
const TEXT_EXPRESSION_ARGS = new Map<string, TextExpressionArgs>([
  ["grep", GREP_EXPRESSION_ARGS],
  ["egrep", GREP_EXPRESSION_ARGS],
  ["fgrep", GREP_EXPRESSION_ARGS],
  ["jq", { positionals: 1, fileFlags: ["-f", "--from-file", "--rawfile", "--slurpfile"] }],
  ["yq", { positionals: 1, fileFlags: ["--from-file"] }],
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
  args: string[],
  context: string | undefined,
  piped: boolean | undefined,
): string | null {
  if (!context) return null;
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
    const spec = TEXT_EXPRESSION_ARGS.get(baseName);
    let expressionsLeft = spec?.positionals ?? 0;
    let expressionValueFollows = false;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];

      // The value of a pattern-supplying flag is an expression, not a path — `grep -e 'foo$bar'`
      // and `grep -e '/var/log/pods'` are ordinary regexes and must not be screened as operands.
      if (expressionValueFollows) { expressionValueFollows = false; continue; }

      // `-` means stdin, which is the only input these commands are supposed to have.
      if (arg === "-") continue;

      if (arg.startsWith("-")) {
        const flag = extractFlag(arg);
        const inlineValue = arg.length > flag.length ? arg.slice(flag.length).replace(/^=/, "") : "";

        if (spec?.fileFlags?.includes(flag)) {
          return JSON.stringify({
            error: `${baseName} "${flag}" reads a file, which is not allowed here — ${baseName} may only process piped input. Use the dedicated file tools to read a file.`,
          }, null, 2);
        }

        if (spec?.patternFlags?.includes(flag)) {
          // The pattern came from the flag, so no positional is the expression any more.
          expressionsLeft = 0;
          if (!inlineValue) expressionValueFollows = true;
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

      if (expressionsLeft > 0) { expressionsLeft--; continue; }
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
  const hasDeclarative = def.blockedFlags || def.allowedFlags ||
    def.allowedSubcommands || def.positionals || def.requiredFlags;

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
    allowedFlags: def.allowedFlags,
    allowedSubcommands: def.allowedSubcommands,
    positionals: def.positionals,
    requiredFlags: def.requiredFlags,
  });
}

/**
 * Apply extra security restrictions to whitelisted commands.
 * Takes a raw command string, parses it internally.
 * Optionally accepts context (for context-specific rules) and piped
 * (for pipe-only enforcement).
 * Returns an error message string if blocked, or null if allowed.
 */
export function validateCommandRestrictions(
  cmd: string,
  options?: { context?: string; piped?: boolean },
): string | null {
  const args = parseArgs(cmd);
  if (args.length === 0) return null;

  const baseName = args[0].split("/").pop()?.toLowerCase() ?? "";
  const def = getCommandDef(baseName);
  if (!def) return null;

  // 1. Context policy constraints (pipeOnly, categoryBlockedFlags)
  const ctxErr = applyContextPolicy(baseName, args, options?.context, options?.piped);
  if (ctxErr) return ctxErr;

  // 2. Command-intrinsic constraints (validate function or declarative rules)
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
export function checkAllNamespacesRestriction(args: string[], subcommand: string): string | null {
  const hasAllNs = args.includes("-A") || args.includes("--all-namespaces");
  if (!hasAllNs) return null;

  const hasSelector = args.some(a =>
    a === "-l" ||
    a === "--selector" || a.startsWith("--selector=") ||
    a === "--field-selector" || a.startsWith("--field-selector="),
  );

  // describe/events/top -A without selector → always blocked
  if (ALL_NS_ALWAYS_NEED_SELECTOR.has(subcommand)) {
    if (!hasSelector) {
      return `"kubectl ${subcommand} --all-namespaces" without selectors can overload the API server on large clusters.`;
    }
    return null;
  }

  // get -A + -o yaml/json → blocked (even with selector — bulk serialization is the concern)
  if (subcommand === "get") {
    const format = getKubectlOutputFormat(args);
    if (format === "yaml" || format === "json") {
      return `"kubectl get --all-namespaces -o ${format}" can return excessive data. Use -n <namespace> to target a specific namespace, or use -o wide/name/custom-columns instead.`;
    }
  }

  return null;
}

/** Extract kubectl output format from args. Handles -o yaml, -oyaml, -o=yaml, --output=yaml. */
function getKubectlOutputFormat(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "-o" || a === "--output") && args[i + 1] && !args[i + 1].startsWith("-")) {
      return extractKubectlFormatName(args[i + 1]);
    }
    if (a.startsWith("--output=")) return extractKubectlFormatName(a.slice(9));
    if (a.startsWith("-o=")) return extractKubectlFormatName(a.slice(3));
    if (a.startsWith("-o") && a.length > 2 && !a.startsWith("--")) return extractKubectlFormatName(a.slice(2));
  }
  return null;
}

function extractKubectlFormatName(value: string): string {
  const eq = value.indexOf("=");
  return eq > 0 ? value.slice(0, eq) : value;
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
  allowedFlags?: string[];
  allowedSubcommands?: { position: number; allowed: string[] };
  positionals?: "allow" | "block" | number;
  requiredFlags?: string[];
  /** Custom validator — mutually exclusive with declarative constraint fields above. */
  validate?: (args: string[]) => string | null;
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
  grep:   { category: "text", blockedFlags: ["-r", "-R", "--recursive"] },
  egrep:  { category: "text", blockedFlags: ["-r", "-R", "--recursive"] },
  fgrep:  { category: "text", blockedFlags: ["-r", "-R", "--recursive"] },
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
  journalctl:  { category: "services", allowedFlags: [
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
