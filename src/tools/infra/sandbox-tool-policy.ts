import type { ScriptRequest, ScriptToolCall } from "../../script-sandbox/types.js";
import { identifier, record } from "../../script-sandbox/validation.js";
import { CONTAINER_SENSITIVE_PATHS, parseArgs, shellEscape } from "./command-sets.js";
import { preExecSecurity } from "./security-pipeline.js";
import { validateSandboxBash } from "./sandbox-bash-policy.js";

export type SandboxExecTool = "host_exec" | "node_exec" | "pod_exec";
export interface SandboxExecRequest {
  command: string;
  timeout_seconds: number;
  host?: string;
  cluster?: string;
  node?: string;
  namespace?: string;
  pod?: string;
  container?: string;
}

// Reuse the actual tools' command and flag validation. The sandbox additionally
// excludes remote interpreters, outbound clients and arbitrary file reads:
// those would move untrusted code or credential discovery outside the runner.
const DIAGNOSTIC_COMMANDS = new Set([
  "uname", "uptime", "free", "vmstat", "iostat", "mpstat", "df", "findmnt", "nproc",
  "lsmod", "modinfo", "ip", "ss", "netstat", "ethtool", "sysctl",
  "nvidia-smi", "ibstat", "ibv_devinfo", "rdma", "lscpu", "lsblk",
]);
const DIAGNOSTIC_FILES = new Set([
  "/etc/os-release", "/proc/meminfo", "/proc/cpuinfo", "/proc/loadavg",
  "/proc/uptime", "/proc/version", "/proc/net/dev",
]);
// Commands without an exhaustive shared flag validator get a narrower SDK
// profile. In particular ss -D writes a file, and findmnt/lscpu can read an
// alternate filesystem. No arbitrary paths are accepted outside fixed cat reads.
const SDK_FLAGS: Record<string, RegExp> = {
  uname: /^-(?:[asnrvmpio]+|-all|-kernel-name|-nodename|-kernel-release|-kernel-version|-machine|-processor|-hardware-platform|-operating-system)$/,
  uptime: /^-(?:[psV]|-pretty|-since|-version)$/,
  free: /^-(?:[bkmghtwl]+|-bytes|-kibi|-mebi|-gibi|-human|-wide|-total)$/,
  vmstat: /^-[sadDwnSt]+$/,
  iostat: /^-[cdxmkhyzp]+$/,
  mpstat: /^-[PAIu]+$/,
  df: /^-(?:[hTikmPal]+|-human-readable|-local|-print-type|-inodes)$/,
  findmnt: /^-(?:[arnlJ]+|o|-output)$/,
  nproc: /^--all$/,
  lsmod: /$a/,
  modinfo: /^-(?:[Fpnadlv]|-field|-parameters|-filename|-author|-description|-license|-version)$/,
  ss: /^-[tulnapiemsor46]+$/,
  netstat: /^-[antulpeorsW46]+$/,
  lscpu: /^-(?:[Jabcpye](?:=[A-Za-z,]+)?|-json|-extended(?:=[A-Za-z,]+)?)$/,
  lsblk: /^-(?:[Jabdfilmnoprt]+|-json|-output)$/,
};
const dnsName = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(v);

export function validateSandboxExec(tool: SandboxExecTool, args: unknown, scope: ScriptRequest): SandboxExecRequest {
  const deny = (): never => { throw new Error("Sandbox diagnostic command or scope denied"); };
  const fields = tool === "host_exec" ? ["host", "command", "timeout_seconds"]
    : tool === "node_exec" ? ["cluster", "node", "command", "timeout_seconds"]
      : ["cluster", "namespace", "pod", "container", "command", "timeout_seconds"];
  if (!record(args) || Object.keys(args).some(k => !fields.includes(k))) return deny();
  if (tool === "host_exec") {
    if (!identifier(args.host) || !scope.hosts?.includes(args.host)) return deny();
  } else {
    if (!identifier(args.cluster)) return deny();
    const cluster = scope.clusters?.find(c => c.name === args.cluster);
    if (!cluster) return deny();
    if (tool === "node_exec") {
      if (!cluster.nodes || !dnsName(args.node)) return deny();
    } else if (!dnsName(args.namespace) || !cluster.namespaces?.includes(args.namespace)
        || !dnsName(args.pod) || (args.container !== undefined && !dnsName(args.container))) return deny();
  }
  const timeout = args.timeout_seconds ?? 10;
  if (!Number.isSafeInteger(timeout) || Number(timeout) < 1 || Number(timeout) > 15) return deny();
  if (typeof args.command !== "string" || args.command.length > 4096 || !/^[a-zA-Z0-9_./,:= %+'"-]+$/.test(args.command)) return deny();
  const argv = parseArgs(args.command);
  if (argv[0] === "cat") {
    if (argv.length < 2 || argv.length > 8 || argv.slice(1).some(p => !DIAGNOSTIC_FILES.has(p))) return deny();
  } else if (!DIAGNOSTIC_COMMANDS.has(argv[0])) return deny();
  if (argv[0] !== "cat" && argv.slice(1).some(a => a.includes("/") || a.includes("\\"))) return deny();
  const flags = SDK_FLAGS[argv[0]];
  if (flags && argv.slice(1).some(a => a.startsWith("-") && !flags.test(a))) return deny();
  const command = argv.map((arg, i) => i === 0 ? arg : shellEscape(arg)).join(" ");
  const pre = preExecSecurity(command, { context: tool === "host_exec" ? "host" : tool === "node_exec" ? "node" : "pod",
    sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS, blockPipeline: true });
  if (pre.error) return deny();
  return { ...args, command, timeout_seconds: Number(timeout) } as SandboxExecRequest;
}

export function validateSandboxBuiltin(call: ScriptToolCall, scope: ScriptRequest) {
  if (!record(call) || !record(call.arguments)) throw new Error("Invalid sandbox callback");
  if (call.tool === "bash") return { tool: "bash" as const, arguments: validateSandboxBash(call.arguments, scope) };
  if (call.tool === "host_exec" || call.tool === "node_exec" || call.tool === "pod_exec") {
    return { tool: call.tool, arguments: validateSandboxExec(call.tool, call.arguments, scope) };
  }
  throw new Error("Sandbox callback tool denied");
}
