/**
 * Shared command whitelist and command-level validators used by
 * restricted-bash, node-exec, and kubectl-exec tools.
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

// ── Unified command whitelist ────────────────────────────────────

/**
 * Commands allowed across all three tools (restricted-bash, node-exec, kubectl-exec).
 * restricted-bash additionally allows `kubectl` and skill scripts.
 *
 * NOTE: sed and awk/gawk are intentionally excluded — they are Turing-complete
 * scripting languages with built-in capabilities for command execution (system(),
 * pipe-to-command), file writes, and shell escapes that cannot be reliably
 * whitelisted. Use grep + cut/tr/head/tail/jq for text processing instead.
 */
export const ALLOWED_COMMANDS = new Set([
  // text processing (sed, awk intentionally excluded — Turing-complete, unsafe)
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

// ── Command categories and context-based whitelists ──────────────

/** Map each command to its functional category. */
export const COMMAND_CATEGORIES: Record<string, string> = {
  // text processing
  grep: "text", egrep: "text", fgrep: "text",
  sort: "text", uniq: "text", wc: "text", head: "text", tail: "text",
  cut: "text", tr: "text", jq: "text", yq: "text", column: "text",
  // network
  ip: "network", ifconfig: "network", ping: "network", traceroute: "network",
  tracepath: "network", ss: "network", netstat: "network", route: "network",
  arp: "network", ethtool: "network", mtr: "network", nslookup: "network",
  dig: "network", host: "network", bridge: "network", tc: "network",
  conntrack: "network", curl: "network",
  // RDMA
  ibstat: "rdma", ibstatus: "rdma", ibv_devinfo: "rdma", ibv_devices: "rdma",
  rdma: "rdma", ibaddr: "rdma", iblinkinfo: "rdma", ibportstate: "rdma",
  ibswitches: "rdma", ibroute: "rdma", show_gids: "rdma", ibdev2netdev: "rdma",
  // perftest
  ib_write_bw: "perftest", ib_write_lat: "perftest",
  ib_read_bw: "perftest", ib_read_lat: "perftest",
  ib_send_bw: "perftest", ib_send_lat: "perftest",
  ib_atomic_bw: "perftest", ib_atomic_lat: "perftest",
  raw_ethernet_bw: "perftest", raw_ethernet_lat: "perftest",
  raw_ethernet_burst_lat: "perftest",
  // GPU
  "nvidia-smi": "gpu", gpustat: "gpu", nvtopo: "gpu",
  // hardware
  lspci: "hardware", lsusb: "hardware", lsblk: "hardware",
  lscpu: "hardware", lsmem: "hardware", lshw: "hardware", dmidecode: "hardware",
  // kernel
  uname: "kernel", hostname: "kernel", uptime: "kernel",
  dmesg: "kernel", sysctl: "kernel", lsmod: "kernel", modinfo: "kernel",
  // process / resource
  ps: "process", pgrep: "process", top: "process", free: "process",
  vmstat: "process", iostat: "process", mpstat: "process",
  df: "process", du: "process", mount: "process", findmnt: "process", nproc: "process",
  // file (read-only) — blocked in local context
  cat: "file", ls: "file", pwd: "file", stat: "file", file: "file",
  find: "file", readlink: "file", realpath: "file", basename: "file", dirname: "file",
  diff: "file", md5sum: "file", sha256sum: "file",
  // diagnostic
  // services
  journalctl: "services", systemctl: "services",
  timedatectl: "services", hostnamectl: "services",
  // container
  crictl: "container", ctr: "container",
  // firewall
  iptables: "firewall", ip6tables: "firewall",
  // inspection — blocked in local context
  lsof: "inspection", lsns: "inspection", strings: "inspection",
  // compressed — blocked in local context
  zcat: "compressed", zgrep: "compressed", bzcat: "compressed", xzcat: "compressed",
  // activity
  sar: "activity", blkid: "activity",
  // stream
  tee: "stream",
  // general (env/printenv separated — blocked in local context)
  date: "general", whoami: "general", id: "general", which: "general",
  env: "general-env", printenv: "general-env",
  // flow control
  echo: "flow", printf: "flow", true: "flow", false: "flow",
  sleep: "flow", wait: "flow", test: "flow", expr: "flow", seq: "flow",
};

/**
 * Categories allowed per execution context.
 * local:   agentbox / TUI process (no file/env access — use Read/Grep/Glob tools)
 * node:    remote node via debug pod
 * pod:     remote pod via kubectl exec
 * nsenter: remote pod netns via debug pod
 * ssh:     remote host via SSH (future)
 */
const ALL_REMOTE_CATEGORIES = [
  "text", "network", "rdma", "perftest", "gpu", "hardware", "kernel",
  "process", "file", "diagnostic", "services", "container", "firewall",
  "inspection", "compressed", "activity", "stream", "general", "general-env",
  "flow",
] as const;

export const CONTEXT_CATEGORIES: Record<string, readonly string[]> = {
  local: [
    "text", "network", "rdma", "perftest", "gpu", "hardware", "kernel",
    "process", "diagnostic", "services", "container", "firewall",
    "activity", "stream", "general", "flow",
  ],
  node: [...ALL_REMOTE_CATEGORIES],
  pod: [...ALL_REMOTE_CATEGORIES],
  nsenter: [...ALL_REMOTE_CATEGORIES],
  ssh: [...ALL_REMOTE_CATEGORIES],
};

// ── Declarative Command Rule Engine ──────────────────────────────

/**
 * Declarative command validation rule.
 * JSON-serializable: no Set, no function, no RegExp.
 * Can be stored in a database, served via API, or edited in an admin UI.
 */
export interface CommandRule {
  command: string;
  category?: string;
  description?: string;

  /** Execution contexts where this rule applies. Absent → all contexts. */
  contexts?: string[];

  /** If true, command must appear after a pipe | operator (stdin-only). */
  pipeOnly?: boolean;

  /** If true, block positional args that look like file paths (/, ./, ../, ~). */
  noFilePaths?: boolean;

  /** Flags that are explicitly blocked (checked per-character for short flags). */
  blockedFlags?: string[];

  /** Flag whitelist. Present → check flags; absent → all flags allowed. */
  allowedFlags?: string[];

  /** Subcommand/action whitelist at a given positional position. */
  allowedSubcommands?: {
    position: number;
    allowed: string[];
  };

  /** Positional argument policy: "allow" (default), "block", or max count. */
  positionals?: "allow" | "block" | number;

  /** At least one of these flags must be present (OR semantics). */
  requiredFlags?: string[];

  /** Delegate to a named custom validator function. */
  customValidator?: string;
}

export const COMMAND_RULES: Record<string, CommandRule | CommandRule[]> = {

  // ── Text commands: local-context stdin-only rules ──
  // In local (agentbox) context, text commands must only process piped stdin.
  // They cannot read files directly or traverse directories.

  grep:   { command: "grep",   contexts: ["local"], pipeOnly: true, noFilePaths: true, blockedFlags: ["-r", "-R", "--recursive"] },
  egrep:  { command: "egrep",  contexts: ["local"], pipeOnly: true, noFilePaths: true, blockedFlags: ["-r", "-R", "--recursive"] },
  fgrep:  { command: "fgrep",  contexts: ["local"], pipeOnly: true, noFilePaths: true, blockedFlags: ["-r", "-R", "--recursive"] },
  cut:    { command: "cut",    contexts: ["local"], pipeOnly: true, noFilePaths: true },
  head:   { command: "head",   contexts: ["local"], pipeOnly: true, noFilePaths: true },
  tail:   { command: "tail",   contexts: ["local"], pipeOnly: true, noFilePaths: true },
  wc:     { command: "wc",     contexts: ["local"], pipeOnly: true, noFilePaths: true },
  tr:     { command: "tr",     contexts: ["local"], pipeOnly: true, noFilePaths: true },
  column: { command: "column", contexts: ["local"], pipeOnly: true, noFilePaths: true },
  jq:     { command: "jq",     contexts: ["local"], pipeOnly: true, noFilePaths: true },

  // ── Flag whitelist ──

  sort: [
    {
      command: "sort", category: "text",
      allowedFlags: [
        "-r", "-n", "-k", "-t", "-u", "-f", "-h", "-V", "-s", "-b", "-g", "-M", "-d", "-i",
        "--reverse", "--numeric-sort", "--key", "--field-separator", "--unique",
        "--human-numeric-sort", "--version-sort", "--stable", "--ignore-leading-blanks",
        "--general-numeric-sort", "--month-sort", "--dictionary-order", "--ignore-case",
      ],
    },
    { command: "sort", contexts: ["local"], pipeOnly: true, noFilePaths: true },
  ],

  yq: [
    {
      command: "yq", category: "text",
      allowedFlags: [
        "-r", "--raw-output", "-e", "--exit-status", "-o", "--output-format",
        "-P", "--prettyprint", "-C", "--colors", "-M", "--no-colors",
        "-N", "--no-doc", "-j", "--tojson", "-p", "--input-format",
        "--xml-attribute-prefix", "--xml-content-name",
        "-s", "--split-exp", "--unwrapScalar", "--nul-output", "--header-preprocess",
      ],
    },
    { command: "yq", contexts: ["local"], pipeOnly: true, noFilePaths: true },
  ],

  ethtool: {
    command: "ethtool", category: "network",
    allowedFlags: [
      "-i", "-S", "-T", "-a", "-c", "-g", "-k", "-l", "-P", "-m", "-d", "--phy-statistics",
    ],
  },

  arp: {
    command: "arp", category: "network",
    allowedFlags: ["-a", "-n", "-e", "-v", "--all", "--numeric", "--verbose"],
  },

  dmesg: {
    command: "dmesg", category: "system",
    allowedFlags: [
      "-T", "--ctime", "-H", "--human", "-l", "--level", "-f", "--facility",
      "-k", "--kernel", "-x", "--decode", "-L", "--color", "--time-format",
      "--nopager",
      "--since", "--until", "-S", "--syslog", "-t", "--notime", "-P",
      // NOTE: -w/--follow/-W/--follow-new intentionally excluded — they hang indefinitely
    ],
  },

  journalctl: {
    command: "journalctl", category: "system",
    allowedFlags: [
      "-u", "--unit", "-n", "--lines", "--since", "--until",
      "-p", "--priority", "-b", "--boot", "-k", "--dmesg",
      "--no-pager", "-o", "--output", "-r", "--reverse",
      "-x", "--catalog", "--system", "--user",
      "-t", "--identifier", "-g", "--grep", "--case-sensitive",
      "-S", "-U", "-e", "--pager-end", "-a", "--all",
      "-q", "--quiet", "--no-hostname", "--no-full",
      "-m", "--merge", "-D", "--directory", "--file", "--list-boots",
    ],
  },

  iptables: {
    command: "iptables", category: "network",
    allowedFlags: [
      "-L", "--list", "-S", "--list-rules",
      "-n", "--numeric", "-v", "--verbose",
      "-x", "--exact", "--line-numbers", "-t", "--table",
    ],
  },

  // ── Flag whitelist + requiredFlags ──

  top: {
    command: "top", category: "process",
    allowedFlags: [
      "-b", "--batch", "-n", "-d", "-p", "-H", "-c", "-o", "-O",
      "-w", "-1", "-e", "-E", "-i", "-S", "-s", "-u", "-U",
    ],
    requiredFlags: ["-b", "--batch"],
  },

  // ── Flag whitelist + positional restrictions ──

  hostname: {
    command: "hostname", category: "system",
    allowedFlags: [
      "-f", "-d", "-s", "-i", "-I", "-A",
      "--fqdn", "--domain", "--short", "--ip-address", "--all-ip-addresses",
    ],
    positionals: "block",
  },

  route: {
    command: "route", category: "network",
    allowedFlags: ["-n", "-e", "-v", "-F", "-C", "--numeric", "--extend", "--verbose"],
    positionals: "block",
  },

  ifconfig: {
    command: "ifconfig", category: "network",
    allowedFlags: ["-a", "-s", "--all", "--short"],
    positionals: 1,
  },

  uniq: [
    { command: "uniq", category: "text", positionals: 1 },
    { command: "uniq", contexts: ["local"], pipeOnly: true, noFilePaths: true },
  ],

  // ── Subcommand whitelist (position: 0) ──

  systemctl: {
    command: "systemctl", category: "service",
    allowedSubcommands: {
      position: 0,
      allowed: [
        "status", "show", "list-units", "list-unit-files",
        "is-active", "is-enabled", "is-failed", "cat",
        "list-dependencies", "list-sockets", "list-timers",
      ],
    },
  },

  crictl: {
    command: "crictl", category: "container",
    allowedSubcommands: {
      position: 0,
      allowed: [
        "ps", "images", "inspect", "inspecti", "inspectp",
        "logs", "stats", "info", "version", "pods",
      ],
    },
  },

  timedatectl: {
    command: "timedatectl", category: "system",
    allowedSubcommands: {
      position: 0,
      allowed: ["status", "show", "list-timezones", "timesync-status"],
    },
  },

  hostnamectl: {
    command: "hostnamectl", category: "system",
    allowedSubcommands: {
      position: 0,
      allowed: ["status", "show"],
    },
  },

  // ── Action whitelist (position: 1) ──

  tc: {
    command: "tc", category: "network",
    allowedSubcommands: { position: 1, allowed: ["show", "list", "ls"] },
  },

  bridge: {
    command: "bridge", category: "network",
    allowedSubcommands: { position: 1, allowed: ["show", "list", "ls"] },
  },

  rdma: {
    command: "rdma", category: "network",
    allowedSubcommands: { position: 1, allowed: ["show", "list", "ls"] },
  },

  // ── Custom validators ──

  curl:         { command: "curl",         category: "network",   customValidator: "curl" },
  conntrack:    { command: "conntrack",    category: "network",   customValidator: "conntrack" },
  find:         { command: "find",         category: "file",      customValidator: "find" },
  ip:           { command: "ip",           category: "network",   customValidator: "ip" },
  "nvidia-smi": { command: "nvidia-smi",   category: "gpu",       customValidator: "nvidia-smi" },
  date:         { command: "date",         category: "system",    customValidator: "date" },
  ctr:          { command: "ctr",          category: "container", customValidator: "ctr" },
  ibportstate:  { command: "ibportstate",  category: "rdma",      customValidator: "ibportstate" },
  env:          { command: "env",          category: "system",    customValidator: "env" },
  tee:          { command: "tee",          category: "system",    customValidator: "tee" },
  mount:        { command: "mount",        category: "system",    customValidator: "mount" },
  sysctl:       { command: "sysctl",       category: "system",    customValidator: "sysctl" },
};

// ip6tables shares iptables rules
COMMAND_RULES["ip6tables"] = { ...COMMAND_RULES["iptables"], command: "ip6tables" };

// Perftest: 11 binaries share one flag set
const PERFTEST_FLAGS = [
  "-s", "--size", "-D", "--duration", "-n", "--iters",
  "-p", "--port", "-d", "--ib-dev", "-i", "--ib-port",
  "-m", "--mtu", "-x", "--gid-index", "--sl",
  "-a", "--all", "-b", "--bidirectional",
  "-F", "--CPU-freq", "-c", "--connection",
  "-R", "--rdma_cm", "-q", "--qp",
  "--run_infinitely", "--report_gbits", "--report_per_port",
  "-l", "--post_list", "--use_cuda", "--use_rocm", "--output_format",
  "-h", "--help", "-V", "--version",
];
for (const bin of [
  "ib_write_bw", "ib_write_lat", "ib_read_bw", "ib_read_lat",
  "ib_send_bw", "ib_send_lat", "ib_atomic_bw", "ib_atomic_lat",
  "raw_ethernet_bw", "raw_ethernet_lat", "raw_ethernet_burst_lat",
]) {
  COMMAND_RULES[bin] = { command: bin, category: "perftest", allowedFlags: PERFTEST_FLAGS };
}

// ── Generic rule engine ──────────────────────────────────────────

function validateByRule(
  args: string[],
  rule: CommandRule,
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

const FIND_SAFE_ACTIONS = new Set(["-print", "-print0", "-ls", "-prune", "-quit"]);
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
  "-L", "--location", "-I", "--head", "-w", "--write-out",
  "-d", "--data", "--data-raw", "--data-urlencode", "--compressed",
  "-A", "--user-agent", "-b", "--cookie", "-e", "--referer",
  "-u", "--user", "--cacert", "--cert", "-x", "--proxy",
  "--retry", "--retry-delay", "--retry-max-time",
  "-f", "--fail", "-4", "-6", "-N", "--no-buffer",
]);
const CURL_SAFE_PREFIXES = [
  "-H=", "--header=", "-m=", "--max-time=", "--connect-timeout=",
  "-w=", "--write-out=", "-d=", "--data=", "--data-raw=", "--data-urlencode=",
  "-A=", "--user-agent=", "-b=", "--cookie=", "-e=", "--referer=",
  "-u=", "--user=", "--cacert=", "--cert=", "-x=", "--proxy=",
  "--retry=", "--retry-delay=", "--retry-max-time=",
];
const CURL_DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-urlencode"]);
const CURL_REQUEST_FLAGS = new Set(["-X", "--request"]);
const CURL_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST"]);
const CURL_SAFE_SHORT_CHARS = new Set([
  "s", "S", "k", "v", "H", "X", "m", "L", "I", "w", "d", "A", "b", "e", "u", "x", "f", "N",
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

function checkCurlDataValue(flag: string, value: string | undefined): string | null {
  if (value && value.startsWith("@")) {
    return `curl ${flag} with @file is not allowed. File uploads are blocked.`;
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

      if (CURL_DATA_FLAGS.has(flag)) {
        if (!hasValue && i + 1 >= args.length) {
          return JSON.stringify({ error: `curl "${flag}" requires a value` }, null, 2);
        }
        const value = hasValue ? inlineValue : args[i + 1];
        const err = checkCurlDataValue(flag, value);
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

      if (flag === "-d") {
        const err = checkCurlDataValue("-d", inlineValue);
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
    if (lastChar && "HXmwdAbeuxr".includes(lastChar)) {
      if (lastChar === "X") {
        const err = checkCurlMethod(args[i + 1]);
        if (err) return err;
      }
      if (lastChar === "d") {
        const err = checkCurlDataValue("-d", args[i + 1]);
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

// ─── nvidia-smi ──────────────────────────────────────────────────

const NVIDIA_SMI_SAFE_FLAGS = new Set([
  "-q", "--query", "-L", "--list-gpus", "-i",
]);
const NVIDIA_SMI_SAFE_PREFIXES = [
  "--query-gpu=", "--query-compute-apps=", "--id=", "--format=",
  "-i=",
];
const NVIDIA_SMI_SUBCMDS = new Set(["topo", "nvlink"]);

function validateNvidiaSmi(args: string[]): string | null {
  if (args.length <= 1) return null;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-")) {
      if (NVIDIA_SMI_SUBCMDS.has(arg)) return null;
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

// ── Custom validator registry ────────────────────────────────────

const CUSTOM_VALIDATORS: Record<string, (args: string[], baseName: string) => string | null> = {
  curl:         (args) => validateCurl(args),
  conntrack:    (args) => validateConntrack(args),
  find:         (args) => validateFind(args),
  ip:           (args) => validateIp(args.join(" ")),
  "nvidia-smi": (args) => validateNvidiaSmi(args),
  date:         (args) => validateDate(args),
  ctr:          (args) => validateCtr(args),
  ibportstate:  (args) => validateIbportstate(args),
  env:          (args) => validateEnv(args),
  tee:          (args) => validateTee(args),
  mount:        (args) => validateMount(args),
  sysctl:       (args) => validateSysctl(args),
};

// ── Entry point ──────────────────────────────────────────────────

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

  const entry = COMMAND_RULES[baseName];
  if (!entry) return null;

  const rules = Array.isArray(entry) ? entry : [entry];

  for (const rule of rules) {
    // Skip rules that don't apply to the current context
    if (rule.contexts && (!options?.context || !rule.contexts.includes(options.context))) {
      continue;
    }

    if (rule.customValidator) {
      const err = CUSTOM_VALIDATORS[rule.customValidator]?.(args, baseName) ?? null;
      if (err) return err;
      continue;
    }

    const err = validateByRule(args, rule, { piped: options?.piped });
    if (err) return err;
  }

  return null;
}
