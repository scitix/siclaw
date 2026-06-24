/**
 * Deployment-configurable extra command whitelist.
 *
 * Loads a JSON config file and registers additional commands into the
 * whitelist via setExtraCommands(). Additive-only: built-in COMMANDS
 * entries always win on collision; constraints are declarative-only
 * (no validate functions — configuration cannot inject code).
 *
 * Contract: docs/design/2026-06-10-extra-command-whitelist.md
 */
import { existsSync, readFileSync } from "node:fs";
import {
  ALL_COMMAND_CATEGORIES,
  setExtraCommands,
  type CommandCategory,
  type CommandDef,
} from "./command-sets.js";

/** Conventional path baked into the AgentBox image (Dockerfile.agentbox). */
export const DEFAULT_EXTRA_COMMANDS_PATH = "/etc/siclaw/extra-commands.json";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._+-]*$/;

// Binaries that must never enter the whitelist via configuration. The
// built-in registry excludes these ON PURPOSE (security.md §4); a config
// file re-adding one would silently void the whole second defense layer.
// Not exhaustive — a curated foot-gun guard, fail-loud by design.
const FORBIDDEN_EXTRA_COMMANDS = new Set([
  // shell interpreters / script engines — arbitrary code execution
  "sh", "bash", "dash", "zsh", "ksh", "csh", "tcsh", "fish",
  "python", "python2", "python3", "perl", "ruby", "node", "deno", "bun", "lua",
  // Turing-complete text tools intentionally excluded from the whitelist
  "sed", "awk", "gawk", "mawk", "nawk", "bc",
  // network exfiltration / arbitrary transfer intentionally excluded
  "nc", "ncat", "netcat", "socat", "wget",
  // privilege / namespace escape
  "sudo", "su", "nsenter", "chroot", "setpriv", "runuser",
  // wrappers that execute their arguments — would bypass first-binary validation
  "xargs", "timeout", "nice", "ionice", "setsid", "stdbuf", "watch",
  "strace", "ltrace", "gdb",
  // multi-call binaries that bundle a shell (busybox sh / toybox sh)
  "busybox", "toybox",
  // remote execution / copy
  "ssh", "scp", "sftp", "rsync", "telnet",
  // kubectl has dedicated subcommand validation outside COMMANDS
  "kubectl",
]);

// Version-suffixed interpreter variants (python3.11, node22, perl5.36, bash5, …)
// are present in real PATHs and execute arbitrary code just like their unversioned
// names, so an exact denylist alone leaves a hole. Reject any "<stem><version>" form
// where the version starts with a digit. Anchored + digit-gated so legitimate names
// that merely contain or end in digits (iperf3, sha256sum, show_gids) are unaffected.
const INTERPRETER_VERSION_PATTERN =
  /^(sh|bash|dash|ash|zsh|ksh|csh|tcsh|fish|python|perl|ruby|node|deno|bun|lua|php|tclsh|awk|gawk|sed)[0-9]/;

const ALLOWED_ENTRY_KEYS = new Set([
  "category", "description",
  "allowedFlags", "blockedFlags", "allowedSubcommands", "positionals", "requiredFlags",
]);

function fail(source: string, message: string): never {
  throw new Error(`Invalid extra-commands config (${source}): ${message}`);
}

function checkFlagArray(source: string, name: string, field: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(source, `"${name}".${field} must be a non-empty string array`);
  }
  for (const flag of value) {
    if (typeof flag !== "string" || !flag.startsWith("-")) {
      fail(source, `"${name}".${field} entries must be strings starting with "-" (got ${JSON.stringify(flag)})`);
    }
  }
  return value as string[];
}

function parseEntry(source: string, name: string, raw: unknown): CommandDef {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(source, `"${name}" must be an object`);
  }
  const entry = raw as Record<string, unknown>;

  for (const key of Object.keys(entry)) {
    if (!ALLOWED_ENTRY_KEYS.has(key)) {
      fail(source, `"${name}" has unsupported key "${key}" (only declarative constraints are configurable)`);
    }
  }

  const category = entry.category;
  if (typeof category !== "string" || !(ALL_COMMAND_CATEGORIES as readonly string[]).includes(category)) {
    fail(source, `"${name}".category must be one of: ${ALL_COMMAND_CATEGORIES.join(", ")}`);
  }

  const def: CommandDef = { category: category as CommandCategory };

  if (entry.allowedFlags !== undefined) def.allowedFlags = checkFlagArray(source, name, "allowedFlags", entry.allowedFlags);
  if (entry.blockedFlags !== undefined) def.blockedFlags = checkFlagArray(source, name, "blockedFlags", entry.blockedFlags);
  if (entry.requiredFlags !== undefined) def.requiredFlags = checkFlagArray(source, name, "requiredFlags", entry.requiredFlags);

  if (entry.positionals !== undefined) {
    const p = entry.positionals;
    const isCount = typeof p === "number" && Number.isInteger(p) && p >= 0;
    if (p !== "allow" && p !== "block" && !isCount) {
      fail(source, `"${name}".positionals must be "allow", "block", or a non-negative integer`);
    }
    def.positionals = p as CommandDef["positionals"];
  }

  if (entry.allowedSubcommands !== undefined) {
    const s = entry.allowedSubcommands as { position?: unknown; allowed?: unknown };
    const positionOk = typeof s === "object" && s !== null &&
      typeof s.position === "number" && Number.isInteger(s.position) && s.position >= 0;
    const allowedOk = positionOk && Array.isArray(s.allowed) && s.allowed.length > 0 &&
      s.allowed.every((a: unknown) => typeof a === "string" && a.length > 0);
    if (!allowedOk) {
      fail(source, `"${name}".allowedSubcommands must be { position: <non-negative int>, allowed: <non-empty string[]> }`);
    }
    def.allowedSubcommands = { position: s.position as number, allowed: s.allowed as string[] };
  }

  return def;
}

/**
 * Parse and validate an extra-commands JSON document.
 * Throws a descriptive error on any schema violation (fail-loud contract).
 * The optional per-entry "description" field is documentation-only and stripped.
 */
export function parseExtraCommandsConfig(text: string, source: string): Record<string, CommandDef> {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    fail(source, `not valid JSON — ${(e as Error).message}`);
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    fail(source, "root must be a JSON object");
  }
  const doc = root as Record<string, unknown>;
  if (doc.version !== 1) {
    fail(source, `"version" must be 1`);
  }
  if (typeof doc.commands !== "object" || doc.commands === null || Array.isArray(doc.commands)) {
    fail(source, `"commands" must be an object`);
  }

  const result: Record<string, CommandDef> = {};
  for (const [name, raw] of Object.entries(doc.commands as Record<string, unknown>)) {
    if (!NAME_PATTERN.test(name)) {
      fail(source, `command name "${name}" is invalid (must match ${NAME_PATTERN})`);
    }
    if (FORBIDDEN_EXTRA_COMMANDS.has(name) || INTERPRETER_VERSION_PATTERN.test(name)) {
      fail(source, `"${name}" cannot be whitelisted via configuration — it is intentionally excluded for security (shell/interpreter/wrapper/exfiltration risk)`);
    }
    result[name] = parseEntry(source, name, raw);
  }
  return result;
}

export interface LoadExtraCommandsOptions {
  /** Explicit path (from SICLAW_EXTRA_COMMANDS_FILE). If set, the file MUST exist. */
  envPath?: string;
  /** Conventional path; silently skipped when absent. */
  defaultPath?: string;
}

/**
 * Resolve and load the extra-commands file.
 * - envPath set (non-empty): mandatory — missing or invalid file throws.
 * - otherwise defaultPath: loaded if present (invalid file still throws), null if absent.
 * Returns the parsed command map, or null when no file is configured/present.
 */
export function loadExtraCommands(options?: LoadExtraCommandsOptions): Record<string, CommandDef> | null {
  const envPath = options?.envPath;
  if (envPath) {
    if (!existsSync(envPath)) {
      throw new Error(`SICLAW_EXTRA_COMMANDS_FILE points to a missing file: ${envPath}`);
    }
    return parseExtraCommandsConfig(readFileSync(envPath, "utf8"), envPath);
  }

  const defaultPath = options?.defaultPath;
  if (defaultPath && existsSync(defaultPath)) {
    return parseExtraCommandsConfig(readFileSync(defaultPath, "utf8"), defaultPath);
  }
  return null;
}

let initialized = false;

/**
 * Load extras from the environment once per process and register them.
 * Called at agent startup (agent-factory). Throws on invalid config —
 * fail-loud is deliberate so a typo cannot silently drop whitelist entries.
 */
export function initExtraCommands(): void {
  if (initialized) return;
  initialized = true;

  const loaded = loadExtraCommands({
    envPath: process.env.SICLAW_EXTRA_COMMANDS_FILE,
    defaultPath: DEFAULT_EXTRA_COMMANDS_PATH,
  });
  if (!loaded || Object.keys(loaded).length === 0) return;

  const { applied, skipped } = setExtraCommands(loaded);
  // Audit trail: make deployment-widened whitelists visible in logs.
  if (applied.length > 0) {
    console.log(`[extra-commands] registered extra whitelist commands: ${applied.join(", ")}`);
  }
  if (skipped.length > 0) {
    console.warn(`[extra-commands] skipped entries colliding with built-in commands (built-in restrictions win): ${skipped.join(", ")}`);
  }
}
