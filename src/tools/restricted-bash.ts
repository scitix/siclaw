import { Type } from "@sinclair/typebox";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as fs from "node:fs";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { processToolOutput, renderTextResult } from "./tool-render.js";
import { SAFE_SUBCOMMANDS, validateExecCommand } from "./kubectl.js";
import { loadConfig } from "../core/config.js";
import {
  ALLOWED_COMMANDS,
  parseArgs,
  getCommandBinary,
  validateCommandRestrictions,
} from "./command-sets.js";
import { resolveKubeconfigPath, resolveKubeconfigByName } from "./kubeconfig-resolver.js";
import { sanitizeEnv } from "./sanitize-env.js";

const execAsync = promisify(exec);

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
      if (ch === inQuote && input[i - 1] !== "\\") {
        inQuote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
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

// Compatibility re-exports — keep old import paths working
export { getCommandBinary, ALLOWED_COMMANDS as ALLOWED_BINARIES } from "./command-sets.js";

/**
 * Validate kubectl commands within a pipeline.
 * Checks that subcommands are in the safe whitelist and exec targets are allowed.
 * Returns an error message if blocked, or null if all kubectl commands are safe.
 */
export function validateKubectlInPipeline(commands: string[]): string | null {
  for (const cmd of commands) {
    const binary = getCommandBinary(cmd);
    if (binary !== "kubectl") continue;

    // Extract the kubectl arguments from the command string
    const stripped = cmd.trim().replace(/^\S+\s+/, ""); // remove "kubectl" prefix
    const args = parseArgs(stripped);
    // Skip flags (--xxx / -x) to find the actual subcommand
    const subcommand = args.find((a) => !a.startsWith("-"))?.toLowerCase();

    if (!subcommand || !SAFE_SUBCOMMANDS.has(subcommand)) {
      return JSON.stringify({
        error: `kubectl subcommand "${subcommand || "(empty)"}" is not allowed in read-only mode.`,
        allowed: [...SAFE_SUBCOMMANDS],
      }, null, 2);
    }

    if (subcommand === "exec") {
      const execCheck = validateExecCommand(args);
      if (execCheck) return execCheck;
    }

    // Block "kubectl config view --raw" — leaks full kubeconfig with certs/tokens
    if (subcommand === "config") {
      const configSub = args.filter((a) => !a.startsWith("-"));
      const hasView = configSub.includes("view");
      const hasRaw = args.includes("--raw");
      if (hasView && hasRaw) {
        return JSON.stringify({
          error: "kubectl config view --raw is not allowed — it exposes credentials.",
        }, null, 2);
      }
    }
  }
  return null;
}

/**
 * Compatibility wrappers — delegate to shared validateCommandRestrictions.
 * Keeps old imports (validateFindInPipeline etc.) working for tests.
 */
export function validateFindInPipeline(commands: string[]): string | null {
  for (const cmd of commands) {
    const binary = getCommandBinary(cmd);
    if (binary !== "find") continue;
    const err = validateCommandRestrictions(cmd);
    if (err) return err;
  }
  return null;
}

export function validateAwkInPipeline(commands: string[]): string | null {
  for (const cmd of commands) {
    const binary = getCommandBinary(cmd);
    if (binary !== "awk" && binary !== "gawk") continue;
    const err = validateCommandRestrictions(cmd);
    if (err) return err;
  }
  return null;
}

/** @deprecated sed has been removed from the allowed commands list. */
export function validateSedInPipeline(_commands: string[]): string | null {
  return null;
}

export function validateIpInPipeline(commands: string[]): string | null {
  for (const cmd of commands) {
    const binary = getCommandBinary(cmd);
    if (binary !== "ip") continue;
    const err = validateCommandRestrictions(cmd);
    if (err) return err;
  }
  return null;
}

/**
 * Check if a shell command invokes a script under <cwd>/skills/.
 * Handles both forms:
 *   - "bash skills/core/xxx/run.sh --flag"   (bash/sh prefix)
 *   - "skills/core/xxx/run.sh --flag"         (direct invocation)
 * Resolves symlinks and blocks path traversal.
 */
export function isSkillScript(cmd: string): boolean {
  const parts = cmd.trim().split(/\s+/);
  const binary = (parts[0] ?? "").split("/").pop()?.toLowerCase() ?? "";

  let scriptArg: string | undefined;
  if (binary === "bash" || binary === "sh" || binary === "python3" || binary === "python") {
    // Find the first positional argument (skip flags like -e, -x)
    for (let i = 1; i < parts.length; i++) {
      if (parts[i] === "-c") return false; // inline command — block
      if (parts[i].startsWith("-")) continue;
      scriptArg = parts[i];
      break;
    }
  } else {
    // Direct invocation: strip env var assignments, take first token
    let stripped = cmd.trim();
    while (/^\s*\w+=\S*\s+/.test(stripped)) {
      stripped = stripped.replace(/^\s*\w+=\S*\s+/, "");
    }
    scriptArg = stripped.trim().split(/\s+/)[0];
  }

  if (!scriptArg) return false;
  const cwd = process.cwd();
  const absPath = path.resolve(cwd, scriptArg);
  try {
    const realPath = fs.realpathSync(absPath);
    // Check 1: cwd/skills/ (local dev, Docker-baked skills)
    const cwdRoot = path.join(cwd, "skills") + path.sep;
    if (realPath.startsWith(cwdRoot)) return true;
    // Check 2: config skillsDir (K8s PV mount, e.g. /mnt/skills)
    const skillsDir = path.resolve(process.cwd(), loadConfig().paths.skillsDir);
    const envRoot = skillsDir + path.sep;
    if (realPath.startsWith(envRoot)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Commands blocked in local bash — these can read local files or expose secrets,
 * bypassing the path-restricted Read/Grep/Glob tools.
 * Use dedicated tools instead: Read (cat), Glob (find/ls), Grep (grep on files).
 *
 * NOTE: ALLOWED_COMMANDS is shared with node-exec/pod-exec (remote contexts)
 * where these commands are legitimate. Only restricted-bash (local) blocks them.
 */
const LOCAL_BLOCKED_COMMANDS = new Set([
  // file reading — use Read tool (path-restricted to cwd)
  "cat", "ls", "find", "stat", "file",
  "readlink", "realpath", "basename", "dirname",
  "diff", "md5sum", "sha256sum",
  "strings", "lsof", "lsns",
  // compressed file reading
  "zcat", "zgrep", "bzcat", "xzcat",
  // environment variable exposure — may contain API keys, DB passwords
  "env", "printenv",
  // not useful in restricted context
  "pwd",
]);

interface RestrictedBashParams {
  command: string;
  timeout_seconds?: number;
}

export function createRestrictedBashTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
  return {
    name: "bash",
    label: "Bash",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("bash")) +
          " " + (args?.command || ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Execute kubectl and shell commands for Kubernetes cluster operations.
This is the primary tool for all kubectl interactions. It runs through a shell, so pipes (|), &&, and redirections are fully supported.

Allowed commands: kubectl, grep, sort, uniq, wc, head, tail, cut, tr, jq, yq, column, and other text processing tools.
kubectl is restricted to read-only subcommands: get, describe, logs, top, events, api-resources, explain, config, version, cluster-info, auth, exec.
Local file access commands (cat, ls, find, stat, env, etc.) are blocked — use the dedicated read/grep/glob tools instead.
All other binaries are blocked — except bash/sh/python3 invoking scripts under skills/.

Examples:
- Simple: "kubectl get pods -n monitoring -o wide"
- With filter: "kubectl get pods -A --field-selector status.phase!=Running"
- With pipe: "kubectl get pods -A | grep -i error"
- JSON query: "kubectl get pod my-pod -o json | jq '.status.conditions'"
- Exec into pod: "kubectl exec my-pod -n ns -- ip addr show"
- Skill scripts: "python3 skills/core/roce-perftest-pod/scripts/run-perftest.py --server-pod pod-a --client-pod pod-b --server-ns ns --client-ns ns"

Prefer kubectl built-in filtering (-l, --field-selector, -o jsonpath, -o custom-columns) over piping to grep when possible.
Do NOT use for non-kubectl tasks (file editing, package management, etc.).`,
    parameters: Type.Object({
      command: Type.String({
        description: "Shell command to execute, e.g. 'kubectl get pods -n default -o wide'",
      }),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 60, max: 300)",
        })
      ),
    }),
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as RestrictedBashParams;
      const command = params.command.trim();

      if (!command) {
        return {
          content: [{ type: "text", text: "Error: empty command." }],
          details: { blocked: true },
        };
      }

      // Validate shell operators on raw command (before splitting)
      const shellOpError = validateShellOperators(command);
      if (shellOpError) {
        return {
          content: [{ type: "text", text: shellOpError }],
          details: { blocked: true },
        };
      }

      // Validate all commands in the pipeline
      const commands = extractCommands(command);
      const violations: string[] = [];

      for (const cmd of commands) {
        const binary = getCommandBinary(cmd);
        if (!binary) continue;
        // Block local file-access commands (use Read/Grep/Glob tools instead)
        if (LOCAL_BLOCKED_COMMANDS.has(binary)) {
          violations.push(binary);
          continue;
        }
        if (ALLOWED_COMMANDS.has(binary) || binary === "kubectl") continue;
        // Allow skill scripts (skills/...) — both "bash script.sh" and direct invocation
        if (isSkillScript(cmd)) {
          continue;
        }
        violations.push(binary);
      }

      if (violations.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Blocked: disallowed command(s): ${[...new Set(violations)].join(", ")}`,
                  allowed: ["kubectl", ...ALLOWED_COMMANDS].sort(),
                },
                null,
                2
              ),
            },
          ],
          details: { blocked: true, violations },
        };
      }

      // Validate kubectl subcommands (read-only whitelist)
      const kubectlError = validateKubectlInPipeline(commands);
      if (kubectlError) {
        return {
          content: [{ type: "text", text: kubectlError }],
          details: { blocked: true },
        };
      }

      // Validate command-level restrictions (find -exec, awk system(), etc.)
      for (const cmd of commands) {
        const err = validateCommandRestrictions(cmd);
        if (err) {
          return {
            content: [{ type: "text", text: err }],
            details: { blocked: true },
          };
        }
      }

      // Block reading sensitive credential/config files via any file-reading command.
      // Also catches $KUBECONFIG / ${KUBECONFIG} shell variable expansion.
      const SENSITIVE_PATH_RE = [
        /\.siclaw\/config\/settings\.json/,
        /\.siclaw\/credentials\//,
        /\$\{?KUBECONFIG\}?/,
      ];
      const FILE_READING_CMDS = ["cat", "head", "tail", "less", "more", "grep", "awk", "gawk"];
      for (const cmd of commands) {
        const binary = getCommandBinary(cmd);
        if (binary && FILE_READING_CMDS.includes(binary)) {
          if (SENSITIVE_PATH_RE.some((re) => re.test(cmd))) {
            return {
              content: [{ type: "text", text: JSON.stringify({
                error: "Reading credential or config files is not allowed.",
              }, null, 2) }],
              details: { blocked: true },
            };
          }
        }
      }

      // Skill scripts (debug pods, perftest, etc.) need longer timeouts
      const isSkill = commands.some((c) => isSkillScript(c));
      const defaultTimeout = isSkill ? 180 : 60;
      const timeout = Math.min(params.timeout_seconds ?? defaultTimeout, 300) * 1000;

      try {
        const execOpts = {
          timeout,
          maxBuffer: 1024 * 1024 * 10,
          shell: "/bin/bash",
          detached: true, // make child a process group leader for clean group kill
          env: {
            ...sanitizeEnv(process.env as Record<string, string>),
            SICLAW_DEBUG_IMAGE: loadConfig().debugImage,
            ...(kubeconfigRef?.credentialsDir ? { SICLAW_CREDENTIALS_DIR: kubeconfigRef.credentialsDir } : {}),
            // Auto-resolve KUBECONFIG from credentials; fall back to /dev/null to block ~/.kube/config
            KUBECONFIG: resolveKubeconfigPath(kubeconfigRef?.credentialsDir) || "/dev/null",
          },
        };

        // Resolve --kubeconfig=<name> (no path separators) to actual file path
        let finalCommand = command;
        if (kubeconfigRef?.credentialsDir) {
          finalCommand = command.replace(
            /--kubeconfig=([^\s/"']+)/g,
            (_match, name) => {
              const resolved = resolveKubeconfigByName(kubeconfigRef.credentialsDir!, name);
              return resolved ? `--kubeconfig=${resolved}` : _match;
            },
          );
        }

        const child = exec(finalCommand, execOpts as any);

        // Kill the entire process group (shell + all child processes like kubectl exec)
        // detached: true makes the shell a process group leader, so -pid kills the whole group
        const onAbort = () => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          let stdout = "";
          let stderr = "";
          child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
          child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
          child.on("close", (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(Object.assign(new Error(`exit ${code}`), { code, stdout, stderr }));
          });
          child.on("error", reject);
        });

        signal?.removeEventListener("abort", onAbort);

        const output = stdout.trim() +
          (stderr.trim() ? `\n\nSTDERR:\n${stderr.trim()}` : "");
        return {
          content: [{ type: "text", text: processToolOutput(output) }],
          details: { exitCode: 0 },
        };
      } catch (err: any) {
        const output = `Exit code: ${err.code ?? "unknown"}\n${err.stdout?.trim() ?? ""}\n${err.stderr?.trim() ?? err.message}`;
        return {
          content: [{ type: "text", text: processToolOutput(output) }],
          details: { exitCode: err.code, error: true },
        };
      }
    },
  };
}
