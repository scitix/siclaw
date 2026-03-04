/**
 * Shared command whitelist and command-level validators used by
 * restricted-bash, node-exec, and kubectl-exec tools.
 */

// ── Utility functions ────────────────────────────────────────────

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

// ── Unified command whitelist ────────────────────────────────────

/**
 * Commands allowed across all three tools (restricted-bash, node-exec, kubectl-exec).
 * restricted-bash additionally allows `kubectl` and skill scripts.
 *
 * NOTE: sed is intentionally excluded — its scripting language has built-in
 * write (w/W) and execute (e) capabilities that are too complex to validate.
 * Use grep + cut/tr/head/tail for text processing instead.
 */
export const ALLOWED_COMMANDS = new Set([
  // text processing (sed intentionally excluded)
  "grep", "egrep", "fgrep",
  "sort", "uniq", "wc", "head", "tail", "cut", "tr",
  "jq", "yq", "column",
  // network diagnostics
  "ip", "ifconfig", "ping", "traceroute", "tracepath", "ss", "netstat",
  "route", "arp", "ethtool", "mtr", "nslookup", "dig", "host",
  "bridge", "tc", "conntrack", "curl",
  // RDMA / RoCE
  "ibstat", "ibstatus", "ibv_devinfo", "ibv_devices", "rdma",
  "ibaddr", "iblinkinfo", "ibportstate", "ibswitches", "ibroute",
  "show_gids", "ibdev2netdev",
  // perftest
  "ib_write_bw", "ib_write_lat", "ib_read_bw", "ib_read_lat",
  "ib_send_bw", "ib_send_lat", "ib_atomic_bw", "ib_atomic_lat",
  "raw_ethernet_bw", "raw_ethernet_lat", "raw_ethernet_burst_lat",
  // GPU
  "nvidia-smi", "gpustat", "nvtopo",
  // hardware info
  "lspci", "lsusb", "lsblk", "lscpu", "lsmem", "lshw", "dmidecode",
  // kernel / system
  "uname", "hostname", "uptime", "dmesg", "sysctl", "lsmod", "modinfo",
  // process / resource
  "ps", "pgrep", "top", "free", "vmstat", "iostat", "mpstat",
  "df", "du", "mount", "findmnt", "nproc",
  // file inspection (read-only)
  "cat", "ls", "pwd", "stat", "file", "find",
  "readlink", "realpath", "basename", "dirname",
  "diff", "md5sum", "sha256sum",
  // system logs & services
  "journalctl", "systemctl", "timedatectl", "hostnamectl",
  // container runtime
  "crictl", "ctr",
  // firewall (read-only via validator)
  "iptables", "ip6tables",
  // file / process inspection
  "lsof", "lsns", "strings",
  // compressed file reading
  "zcat", "zgrep", "bzcat", "xzcat",
  // system activity
  "sar", "blkid",
  // stream utility (restricted via validator)
  "tee",
  // general
  "date", "whoami", "id", "env", "printenv", "which",
  // flow control
  "echo", "printf", "true", "false", "sleep", "wait", "test",
  // math (bc removed — !command escapes to shell)
  "expr", "seq",
]);

// ── Perftest binary names ────────────────────────────────────────

const PERFTEST_BINARIES = new Set([
  "ib_write_bw", "ib_write_lat", "ib_read_bw", "ib_read_lat",
  "ib_send_bw", "ib_send_lat", "ib_atomic_bw", "ib_atomic_lat",
  "raw_ethernet_bw", "raw_ethernet_lat", "raw_ethernet_burst_lat",
]);

// ── Command-level validators ─────────────────────────────────────

// ip subcommands that are read-only
const IP_SAFE_ACTIONS = new Set(["show", "list", "ls", "get"]);

/**
 * Apply extra security restrictions to whitelisted commands.
 * Takes a raw command string, parses it internally.
 * Returns an error message string if blocked, or null if allowed.
 */
export function validateCommandRestrictions(cmd: string): string | null {
  const args = parseArgs(cmd);
  if (args.length === 0) return null;

  const binary = args[0];
  const baseName = binary.split("/").pop()?.toLowerCase() ?? "";

  switch (baseName) {
    // B1: text processing
    case "sort":
      return validateSort(args);
    case "find":
      return validateFind(args);
    case "yq":
      return validateYq(args);
    case "uniq":
      return validateUniq(args);

    // B2: network diagnostics
    case "ethtool":
      return validateEthtool(args);
    case "tc":
      return validateTc(args);
    case "bridge":
      return validateBridge(args);
    case "route":
      return validateRoute(args);
    case "arp":
      return validateArp(args);
    case "ifconfig":
      return validateIfconfig(args);
    case "conntrack":
      return validateConntrack(args);
    case "curl":
      return validateCurl(args);
    case "rdma":
      return validateRdma(args);
    case "ibportstate":
      return validateIbportstate(args);

    // B3: system/hardware
    case "nvidia-smi":
      return validateNvidiaSmi(args);
    case "hostname":
      return validateHostname(args);
    case "date":
      return validateDate(args);
    case "dmesg":
      return validateDmesg(args);
    case "timedatectl":
      return validateTimedatectl(args);
    case "hostnamectl":
      return validateHostnamectl(args);
    case "journalctl":
      return validateJournalctl(args);
    case "sysctl":
      return validateSysctl(args);

    case "top":
      return validateTop(args);

    // existing whitelist validators (unchanged)
    case "ip":
      return validateIp(cmd);
    case "awk":
    case "gawk":
      return validateAwk(cmd);
    case "systemctl":
      return validateSystemctl(args);
    case "crictl":
      return validateCrictl(args);
    case "ctr":
      return validateCtr(args);
    case "iptables":
    case "ip6tables":
      return validateIptables(args);
    case "tee":
      return validateTee(args);
    case "mount":
      return validateMount(args);
    case "env":
      return validateEnv(args);

    default:
      // perftest binaries
      if (PERFTEST_BINARIES.has(baseName)) {
        return validatePerftest(args, baseName);
      }
      return null;
  }
}

// ── Individual validators ────────────────────────────────────────

// ─── B1: Text Processing ─────────────────────────────────────────

const SORT_SAFE_FLAGS = new Set([
  "-r", "-n", "-k", "-t", "-u", "-f", "-h", "-V", "-s", "-b", "-g", "-M", "-d", "-i",
  "--reverse", "--numeric-sort", "--key", "--field-separator", "--unique",
  "--human-numeric-sort", "--version-sort", "--stable", "--ignore-leading-blanks",
  "--general-numeric-sort", "--month-sort", "--dictionary-order", "--ignore-case",
]);
const SORT_SAFE_PREFIXES = ["-k", "-t", "--key=", "--field-separator="];

function validateSort(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue; // positional args (filenames) allowed
    const flag = extractFlag(arg);
    if (!SORT_SAFE_FLAGS.has(flag) && !startsWithAny(arg, SORT_SAFE_PREFIXES)) {
      return JSON.stringify({
        error: `sort "${arg}" is not allowed. Only read-only sort flags are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

const FIND_ALLOWED_ACTIONS = new Set(["-print", "-print0", "-ls", "-prune", "-quit"]);
const FIND_DANGEROUS_ACTIONS = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-delete",
  "-fprint", "-fprint0", "-fprintf", "-fls",
]);

function validateFind(args: string[]): string | null {
  for (const arg of args.slice(1)) {
    if (FIND_DANGEROUS_ACTIONS.has(arg)) {
      return JSON.stringify({
        error: `find "${arg}" is not allowed. Only read-only find operations (listing/filtering) are permitted.`,
        allowed_actions: [...FIND_ALLOWED_ACTIONS],
      }, null, 2);
    }
  }
  return null;
}

const YQ_SAFE_FLAGS = new Set([
  "-r", "--raw-output", "-e", "--exit-status", "-o", "--output-format",
  "-P", "--prettyprint", "-C", "--colors", "-M", "--no-colors",
  "-N", "--no-doc", "-j", "--tojson", "-p", "--input-format",
  "--xml-attribute-prefix", "--xml-content-name",
  "-s", "--split-exp", "--unwrapScalar", "--nul-output",
  "--header-preprocess",
]);
const YQ_SAFE_PREFIXES = ["-o=", "--output-format=", "-p=", "--input-format=",
  "--xml-attribute-prefix=", "--xml-content-name="];

function validateYq(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue; // expression or filename
    const flag = extractFlag(arg);
    if (!YQ_SAFE_FLAGS.has(flag) && !startsWithAny(arg, YQ_SAFE_PREFIXES)) {
      return JSON.stringify({
        error: `yq "${arg}" is not allowed. In-place editing is not permitted.`,
      }, null, 2);
    }
  }
  return null;
}

function validateUniq(args: string[]): string | null {
  let positionalCount = 0;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) continue; // any flag is ok
    positionalCount++;
    if (positionalCount >= 2) {
      return JSON.stringify({
        error: "uniq with output file argument is not allowed. Only reading from stdin or a single input file is permitted.",
      }, null, 2);
    }
  }
  return null;
}

// ─── B2: Network Diagnostics ─────────────────────────────────────

const ETHTOOL_SAFE_FLAGS = new Set([
  "-i", "-S", "-T", "-a", "-c", "-g", "-k", "-l", "-P", "-m", "-d", "--phy-statistics",
]);

function validateEthtool(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue; // device name
    if (!ETHTOOL_SAFE_FLAGS.has(arg)) {
      return JSON.stringify({
        error: `ethtool "${arg}" is not allowed. Only read-only ethtool queries are permitted.`,
        allowed: [...ETHTOOL_SAFE_FLAGS],
      }, null, 2);
    }
  }
  return null;
}

const SUBCMD_SAFE_ACTIONS = new Set(["show", "list", "ls"]);

function validateTc(args: string[]): string | null {
  // tc [options] <object> <action>
  // Find the first positional (object), then the second positional (action)
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("-")) continue;
    positional.push(args[i]);
    if (positional.length >= 2) break;
  }
  // No args or just object → defaults to show → safe
  if (positional.length < 2) return null;
  const action = positional[1];
  if (!SUBCMD_SAFE_ACTIONS.has(action)) {
    return JSON.stringify({
      error: `tc action "${action}" is not allowed. Only read-only actions (show, list, ls) are permitted.`,
    }, null, 2);
  }
  return null;
}

function validateBridge(args: string[]): string | null {
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("-")) continue;
    positional.push(args[i]);
    if (positional.length >= 2) break;
  }
  if (positional.length < 2) return null;
  const action = positional[1];
  if (!SUBCMD_SAFE_ACTIONS.has(action)) {
    return JSON.stringify({
      error: `bridge action "${action}" is not allowed. Only read-only actions (show, list, ls) are permitted.`,
    }, null, 2);
  }
  return null;
}

const ROUTE_SAFE_FLAGS = new Set([
  "-n", "-e", "-v", "-F", "-C", "--numeric", "--extend", "--verbose",
]);

function validateRoute(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (!ROUTE_SAFE_FLAGS.has(arg)) {
        return JSON.stringify({
          error: `route "${arg}" is not allowed. Only read-only route queries are permitted.`,
        }, null, 2);
      }
    } else {
      // Any positional argument (add, del, etc.) is blocked
      return JSON.stringify({
        error: `route "${arg}" is not allowed. Only "route" (display routing table) with read-only flags is permitted.`,
      }, null, 2);
    }
  }
  return null;
}

const ARP_SAFE_FLAGS = new Set([
  "-a", "-n", "-e", "-v", "--all", "--numeric", "--verbose",
]);

function validateArp(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue; // hostname query is ok
    if (!ARP_SAFE_FLAGS.has(arg)) {
      return JSON.stringify({
        error: `arp "${arg}" is not allowed. Only read-only arp queries are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

const IFCONFIG_SAFE_FLAGS = new Set(["-a", "-s", "--all", "--short"]);

function validateIfconfig(args: string[]): string | null {
  let positionalCount = 0;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (!IFCONFIG_SAFE_FLAGS.has(arg)) {
        return JSON.stringify({
          error: `ifconfig "${arg}" is not allowed. Only read-only ifconfig queries are permitted.`,
        }, null, 2);
      }
    } else {
      positionalCount++;
      if (positionalCount >= 2) {
        return JSON.stringify({
          error: "ifconfig with configuration arguments is not allowed. Only viewing interface info is permitted.",
        }, null, 2);
      }
    }
  }
  return null;
}

const CONNTRACK_SAFE_OPS = new Set([
  "-L", "--dump", "-G", "--get", "-C", "--count", "-S", "--stats", "-E", "--event",
]);
const CONNTRACK_DANGEROUS_OPS = new Set([
  "-D", "--delete", "-F", "--flush", "-U", "--update", "-I", "--create",
]);

function validateConntrack(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (CONNTRACK_DANGEROUS_OPS.has(arg)) {
      return JSON.stringify({
        error: `conntrack "${arg}" is not allowed. Only read-only operations (-L, -G, -C, -S, -E) are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

const CURL_SAFE_FLAGS = new Set([
  "-s", "--silent", "-S", "--show-error", "-k", "--insecure", "-v", "--verbose",
  "-H", "--header", "-X", "--request", "-m", "--max-time", "--connect-timeout",
  "-L", "--location", "-I", "--head", "-w", "--write-out",
  "-d", "--data", "--data-raw", "--data-urlencode", "--compressed",
  "-A", "--user-agent", "-b", "--cookie", "-e", "--referer",
  "-u", "--user", "--cacert", "--cert", "-x", "--proxy",
  "--retry", "--retry-delay", "--retry-max-time",
  "-f", "--fail", "-4", "-6", "-N", "--no-buffer",
]);
const CURL_SAFE_PREFIXES = [
  "-H=", "--header=", "-X=", "--request=", "-m=", "--max-time=", "--connect-timeout=",
  "-w=", "--write-out=", "-d=", "--data=", "--data-raw=", "--data-urlencode=",
  "-A=", "--user-agent=", "-b=", "--cookie=", "-e=", "--referer=",
  "-u=", "--user=", "--cacert=", "--cert=", "-x=", "--proxy=",
  "--retry=", "--retry-delay=", "--retry-max-time=",
];
const CURL_DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-urlencode"]);

// Single-char curl flags that are safe (for combined flag parsing like -sS)
const CURL_SAFE_SHORT_CHARS = new Set([
  "s", "S", "k", "v", "H", "X", "m", "L", "I", "w", "d", "A", "b", "e", "u", "x", "f", "N",
  "4", "6",
]);

function validateCurl(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue; // URL (positional) allowed

    // Handle long flags (--xxx)
    if (arg.startsWith("--")) {
      const flag = extractFlag(arg);
      if (!CURL_SAFE_FLAGS.has(flag) && !startsWithAny(arg, CURL_SAFE_PREFIXES)) {
        return JSON.stringify({
          error: `curl "${arg}" is not allowed. Only read-only curl flags are permitted.`,
        }, null, 2);
      }
      // Check data flags for @file upload
      if (CURL_DATA_FLAGS.has(flag)) {
        if (flag === arg) {
          const nextArg = args[i + 1];
          if (nextArg && nextArg.startsWith("@")) {
            return `curl ${flag} with @file is not allowed. File uploads are blocked.`;
          }
          i++;
        } else {
          const value = arg.slice(flag.length + 1);
          if (value.startsWith("@")) {
            return `curl ${flag} with @file is not allowed. File uploads are blocked.`;
          }
        }
      }
      continue;
    }

    // Handle short flags: could be combined like -sS, -sSk
    // Single short flag with = is like -m=10
    if (arg.includes("=")) {
      const flag = extractFlag(arg);
      if (!CURL_SAFE_FLAGS.has(flag) && !startsWithAny(arg, CURL_SAFE_PREFIXES)) {
        return JSON.stringify({
          error: `curl "${arg}" is not allowed. Only read-only curl flags are permitted.`,
        }, null, 2);
      }
      continue;
    }

    // Check each character in combined short flags (e.g. -sS, -sSk, -vk)
    const chars = arg.slice(1); // remove leading -
    for (const ch of chars) {
      if (!CURL_SAFE_SHORT_CHARS.has(ch)) {
        return JSON.stringify({
          error: `curl "-${ch}" (in "${arg}") is not allowed. Only read-only curl flags are permitted.`,
        }, null, 2);
      }
    }

    // If last char is a flag that takes a value (-d, -H, -X, etc.), skip next arg
    const lastChar = chars[chars.length - 1];
    if (lastChar && "HXmwdAbeuxr".includes(lastChar)) {
      // Check data flag @file restriction
      if (lastChar === "d") {
        const nextArg = args[i + 1];
        if (nextArg && nextArg.startsWith("@")) {
          return `curl -d with @file is not allowed. File uploads are blocked.`;
        }
      }
      i++; // skip value
    }
  }
  return null;
}

function validateRdma(args: string[]): string | null {
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("-")) continue;
    positional.push(args[i]);
    if (positional.length >= 2) break;
  }
  if (positional.length < 2) return null;
  const action = positional[1];
  if (!SUBCMD_SAFE_ACTIONS.has(action)) {
    return JSON.stringify({
      error: `rdma action "${action}" is not allowed. Only read-only actions (show, list, ls) are permitted.`,
    }, null, 2);
  }
  return null;
}

const IBPORTSTATE_DANGEROUS_ACTIONS = new Set([
  "enable", "disable", "reset", "speed", "width", "espeed",
]);

function validateIbportstate(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) continue;
    if (IBPORTSTATE_DANGEROUS_ACTIONS.has(arg)) {
      return JSON.stringify({
        error: `ibportstate "${arg}" is not allowed. Only query operations are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

// ─── B3: System / Hardware ───────────────────────────────────────

const NVIDIA_SMI_SAFE_FLAGS = new Set([
  "-q", "--query", "-L", "--list-gpus", "-i",
]);
const NVIDIA_SMI_SAFE_PREFIXES = [
  "--query-gpu=", "--query-compute-apps=", "--id=", "--format=",
  "-i=",
];
const NVIDIA_SMI_SUBCMDS = new Set(["topo", "nvlink"]);

function validateNvidiaSmi(args: string[]): string | null {
  if (args.length <= 1) return null; // bare nvidia-smi is safe

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      // positional: allow topo, nvlink subcmds and their arguments
      if (NVIDIA_SMI_SUBCMDS.has(arg)) return null;
      // After a safe flag like -i, the next positional is its value — skip it
      continue;
    }
    const flag = extractFlag(arg);
    if (!NVIDIA_SMI_SAFE_FLAGS.has(flag) && !startsWithAny(arg, NVIDIA_SMI_SAFE_PREFIXES)) {
      return JSON.stringify({
        error: `nvidia-smi "${arg}" is not allowed. Only read-only nvidia-smi queries are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

const HOSTNAME_SAFE_FLAGS = new Set([
  "-f", "-d", "-s", "-i", "-I", "-A",
  "--fqdn", "--domain", "--short", "--ip-address", "--all-ip-addresses",
]);

function validateHostname(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("-")) {
      if (!HOSTNAME_SAFE_FLAGS.has(arg)) {
        return JSON.stringify({
          error: `hostname "${arg}" is not allowed. Only read-only hostname queries are permitted.`,
        }, null, 2);
      }
    } else {
      // Any positional = setting hostname
      return JSON.stringify({
        error: "hostname with a name argument is not allowed. Only viewing the hostname is permitted.",
      }, null, 2);
    }
  }
  return null;
}

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
      // Skip next arg if it's a value for -d, -r, etc.
      if (DATE_SAFE_FLAGS.has(arg) && (arg === "-d" || arg === "--date" || arg === "-r" || arg === "--reference")) {
        i++; // skip value
      }
    } else {
      // Non-+ positional arg → not allowed
      return JSON.stringify({
        error: `date "${arg}" is not allowed. Only format strings (+...) and read-only flags are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

const DMESG_SAFE_FLAGS = new Set([
  "-T", "--ctime", "-H", "--human", "-l", "--level", "-f", "--facility",
  "-k", "--kernel", "-x", "--decode", "-L", "--color", "--time-format",
  "-w", "--follow", "-W", "--follow-new", "--nopager",
  "--since", "--until", "-S", "--syslog", "-t", "--notime", "-P",
]);
const DMESG_SAFE_PREFIXES = [
  "-l=", "--level=", "-f=", "--facility=", "--time-format=",
  "--since=", "--until=", "-L=", "--color=",
];
const DMESG_DANGEROUS_FLAGS = new Set([
  "-C", "--clear", "-c", "--read-clear",
  "-D", "--console-off", "-E", "--console-on",
  "-n", "--console-level",
]);

function validateDmesg(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue;
    const flag = extractFlag(arg);
    if (DMESG_DANGEROUS_FLAGS.has(flag)) {
      return JSON.stringify({
        error: `dmesg "${arg}" is not allowed. Only read-only dmesg queries are permitted.`,
      }, null, 2);
    }
    if (!DMESG_SAFE_FLAGS.has(flag) && !startsWithAny(arg, DMESG_SAFE_PREFIXES)) {
      return JSON.stringify({
        error: `dmesg "${arg}" is not allowed. Only read-only dmesg queries are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

const TIMEDATECTL_SAFE = new Set(["status", "show", "list-timezones", "timesync-status"]);

function validateTimedatectl(args: string[]): string | null {
  for (const arg of args.slice(1)) {
    if (arg.startsWith("-")) continue;
    if (!TIMEDATECTL_SAFE.has(arg)) {
      return JSON.stringify({
        error: `timedatectl subcommand "${arg}" is not allowed. Only read-only subcommands are permitted.`,
        allowed: [...TIMEDATECTL_SAFE].sort(),
      }, null, 2);
    }
    return null; // first positional is safe
  }
  return null; // bare timedatectl is fine (defaults to status)
}

const HOSTNAMECTL_SAFE = new Set(["status", "show"]);

function validateHostnamectl(args: string[]): string | null {
  for (const arg of args.slice(1)) {
    if (arg.startsWith("-")) continue;
    if (!HOSTNAMECTL_SAFE.has(arg)) {
      return JSON.stringify({
        error: `hostnamectl subcommand "${arg}" is not allowed. Only read-only subcommands are permitted.`,
        allowed: [...HOSTNAMECTL_SAFE].sort(),
      }, null, 2);
    }
    return null;
  }
  return null;
}

const JOURNALCTL_SAFE_FLAGS = new Set([
  "-u", "--unit", "-n", "--lines", "--since", "--until",
  "-p", "--priority", "-b", "--boot", "-k", "--dmesg",
  "--no-pager", "-o", "--output", "-r", "--reverse",
  "-x", "--catalog", "--system", "--user",
  "-t", "--identifier", "-g", "--grep", "--case-sensitive",
  "-S", "-U", "-e", "--pager-end", "-a", "--all",
  "-q", "--quiet", "--no-hostname", "--no-full",
  "-m", "--merge", "-D", "--directory", "--file",
  "--list-boots",
]);
const JOURNALCTL_SAFE_PREFIXES = [
  "-u=", "--unit=", "-n=", "--lines=", "--since=", "--until=",
  "-p=", "--priority=", "-b=", "--boot=", "-o=", "--output=",
  "-t=", "--identifier=", "-g=", "--grep=", "-D=", "--directory=",
  "--file=", "--case-sensitive=",
];
const JOURNALCTL_DANGEROUS_FLAGS = new Set([
  "-f", "--follow",
  "--vacuum-size", "--vacuum-time", "--vacuum-files",
  "--rotate", "--flush", "--sync",
  "--relinquish-var", "--smart-relinquish-var",
  "--setup-keys", "--verify",
]);

function validateJournalctl(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    // Allow KEY=VALUE field matching (e.g. _SYSTEMD_UNIT=foo.service)
    if (!arg.startsWith("-") && arg.includes("=")) continue;
    if (!arg.startsWith("-")) continue; // positional args allowed

    const flag = extractFlag(arg);
    if (JOURNALCTL_DANGEROUS_FLAGS.has(flag) || startsWithAny(arg, ["--vacuum-"])) {
      const msg = flag === "-f" || flag === "--follow"
        ? `journalctl follow mode (${arg}) is not allowed — it blocks the agent. Use -n or --since instead.`
        : `journalctl "${arg}" is not allowed. Only read-only journalctl queries are permitted.`;
      return JSON.stringify({ error: msg }, null, 2);
    }
    if (!JOURNALCTL_SAFE_FLAGS.has(flag) && !startsWithAny(arg, JOURNALCTL_SAFE_PREFIXES)) {
      return JSON.stringify({
        error: `journalctl "${arg}" is not allowed. Only read-only journalctl queries are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

const TOP_SAFE_FLAGS = new Set([
  "-b", "--batch", "-n", "-d", "-p", "-H", "-c", "-o", "-O",
  "-w", "-1", "-e", "-E", "-i", "-S", "-s", "-u", "-U",
]);
const TOP_SAFE_PREFIXES = [
  "-n=", "-d=", "-p=", "-o=", "-O=", "-w=", "-e=", "-E=", "-u=", "-U=",
];

function validateTop(args: string[]): string | null {
  // top MUST run in batch mode (-b) to prevent interactive kill/renice
  const hasBatch = args.some((a) => a === "-b" || a === "--batch");
  if (!hasBatch) {
    return JSON.stringify({
      error: 'top must be run in batch mode (-b). Interactive mode is not allowed.',
    }, null, 2);
  }
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue;
    const flag = extractFlag(arg);
    if (!TOP_SAFE_FLAGS.has(flag) && !startsWithAny(arg, TOP_SAFE_PREFIXES)) {
      return JSON.stringify({
        error: `top "${arg}" is not allowed. Only batch-mode read-only flags are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

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
      if (flag === "-w" || flag === "--write" || flag === "-p" || flag === "--load" || flag === "--system") {
        return JSON.stringify({
          error: `sysctl "${arg}" is not allowed. Only read-only sysctl queries are permitted.`,
        }, null, 2);
      }
      if (!SYSCTL_SAFE_FLAGS.has(flag) && !startsWithAny(arg, SYSCTL_SAFE_PREFIXES)) {
        return JSON.stringify({
          error: `sysctl "${arg}" is not allowed. Only read-only sysctl queries are permitted.`,
        }, null, 2);
      }
    } else {
      // Positional: block key=value (write)
      if (arg.includes("=")) {
        return JSON.stringify({
          error: `sysctl write ("${arg}") is not allowed. Only read-only sysctl queries are permitted.`,
        }, null, 2);
      }
    }
  }
  return null;
}

const IPTABLES_SAFE_FLAGS = new Set([
  "-L", "--list", "-S", "--list-rules",
  "-n", "--numeric", "-v", "--verbose",
  "-x", "--exact", "--line-numbers",
  "-t", "--table",
]);
const IPTABLES_SAFE_PREFIXES = ["-t=", "--table="];

function validateIptables(args: string[]): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue; // chain name (positional) is ok
    const flag = extractFlag(arg);
    if (!IPTABLES_SAFE_FLAGS.has(flag) && !startsWithAny(arg, IPTABLES_SAFE_PREFIXES)) {
      return JSON.stringify({
        error: `iptables "${arg}" is not allowed. Only list operations (-L, -S, -n, -v) are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

// ─── B4: Perftest ────────────────────────────────────────────────

const PERFTEST_SAFE_FLAGS = new Set([
  "-s", "--size", "-D", "--duration", "-n", "--iters",
  "-p", "--port", "-d", "--ib-dev", "-i", "--ib-port",
  "-m", "--mtu", "-x", "--gid-index", "--sl",
  "-a", "--all", "-b", "--bidirectional",
  "-F", "--CPU-freq", "-c", "--connection",
  "-R", "--rdma_cm", "-q", "--qp",
  "--run_infinitely", "--report_gbits", "--report_per_port",
  "-l", "--post_list", "--use_cuda", "--use_rocm", "--output_format",
  "-h", "--help", "-V", "--version",
]);
const PERFTEST_SAFE_PREFIXES = [
  "-s=", "--size=", "-D=", "--duration=", "-n=", "--iters=",
  "-p=", "--port=", "-d=", "--ib-dev=", "-i=", "--ib-port=",
  "-m=", "--mtu=", "-x=", "--gid-index=", "--sl=",
  "-c=", "--connection=", "-q=", "--qp=", "-l=", "--post_list=",
  "--output_format=",
];

function validatePerftest(args: string[], binary: string): string | null {
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) continue; // server hostname/IP
    const flag = extractFlag(arg);
    if (!PERFTEST_SAFE_FLAGS.has(flag) && !startsWithAny(arg, PERFTEST_SAFE_PREFIXES)) {
      return JSON.stringify({
        error: `${binary} "${arg}" is not allowed. Only standard perftest flags are permitted.`,
      }, null, 2);
    }
  }
  return null;
}

// ─── Existing validators (unchanged) ─────────────────────────────

function validateIp(cmd: string): string | null {
  const parts = cmd.trim().split(/\s+/);
  // Skip flags starting with -
  let objectIdx = 1;
  while (objectIdx < parts.length && parts[objectIdx].startsWith("-")) {
    objectIdx++;
  }
  // ip with just an object (e.g. "ip addr") defaults to "show" — safe
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

function validateAwk(cmd: string): string | null {
  if (/\bsystem\s*\(/.test(cmd)) {
    return JSON.stringify({
      error: "awk system() calls are not allowed. Use awk for text processing only.",
    }, null, 2);
  }
  return null;
}

function validateMount(args: string[]): string | null {
  const nonFlagArgs = args.slice(1).filter((a) => !a.startsWith("-"));
  if (nonFlagArgs.length >= 2) {
    return "mount with device and mountpoint arguments is not allowed. Only listing mounts (mount without arguments or with -l) is permitted.";
  }
  return null;
}

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

const SYSTEMCTL_SAFE = new Set([
  "status", "show", "list-units", "list-unit-files",
  "is-active", "is-enabled", "is-failed", "cat",
  "list-dependencies", "list-sockets", "list-timers",
]);

function validateSystemctl(args: string[]): string | null {
  // Find the first non-flag argument after "systemctl" — that is the subcommand
  for (const arg of args.slice(1)) {
    if (arg.startsWith("-")) continue;
    if (!SYSTEMCTL_SAFE.has(arg)) {
      return JSON.stringify({
        error: `systemctl subcommand "${arg}" is not allowed. Only read-only subcommands are permitted.`,
        allowed: [...SYSTEMCTL_SAFE].sort(),
      }, null, 2);
    }
    return null; // first positional is safe
  }
  return null; // no subcommand (bare "systemctl") is fine
}

const CRICTL_SAFE = new Set([
  "ps", "images", "inspect", "inspecti", "inspectp",
  "logs", "stats", "info", "version", "pods",
]);

function validateCrictl(args: string[]): string | null {
  for (const arg of args.slice(1)) {
    if (arg.startsWith("-")) continue;
    if (!CRICTL_SAFE.has(arg)) {
      return JSON.stringify({
        error: `crictl subcommand "${arg}" is not allowed. Only read-only subcommands are permitted.`,
        allowed: [...CRICTL_SAFE].sort(),
      }, null, 2);
    }
    return null;
  }
  return null;
}

const CTR_SAFE_ACTIONS = new Set(["ls", "list", "info", "check"]);

function validateCtr(args: string[]): string | null {
  // ctr [global-flags] <object> <action> [args...]
  // Also allow: ctr version, ctr info
  const positional: string[] = [];
  const skipNext = new Set(["-n", "--namespace", "-a", "--address"]);
  for (let i = 1; i < args.length; i++) {
    if (skipNext.has(args[i])) { i++; continue; } // flag with value
    if (args[i].startsWith("-")) continue;
    positional.push(args[i]);
  }

  if (positional.length === 0) return null;

  // "ctr version" and "ctr info" are safe standalone commands
  if (positional[0] === "version" || positional[0] === "info") return null;

  // For object+action pattern, verify the action is read-only
  const action = positional[1];
  if (!action) return null; // just object name, default action is usually "ls" — safe

  if (!CTR_SAFE_ACTIONS.has(action)) {
    return JSON.stringify({
      error: `ctr action "${action}" on "${positional[0]}" is not allowed. Only read-only actions are permitted.`,
      allowed: [...CTR_SAFE_ACTIONS].sort(),
    }, null, 2);
  }
  return null;
}

function validateTee(args: string[]): string | null {
  // Allow: tee (no args, copies stdin to stdout)
  // Allow: tee /dev/null
  // Block: tee /any/other/path, tee -a /path
  for (const arg of args.slice(1)) {
    if (arg.startsWith("-")) continue; // flags like -a are ok if target is /dev/null
    if (arg !== "/dev/null") {
      return JSON.stringify({
        error: `tee to "${arg}" is not allowed. Only "tee" or "tee /dev/null" is permitted.`,
      }, null, 2);
    }
  }
  return null;
}
