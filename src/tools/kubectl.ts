import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Text } from "@mariozechner/pi-tui";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { renderTextResult, processToolOutput } from "./tool-render.js";
import {
  ALLOWED_COMMANDS,
  CONTAINER_SENSITIVE_PATHS,
  parseArgs,
  validateCommandRestrictions,
} from "./command-sets.js";
import {
  detectSensitiveResource,
  getOutputFormat,
} from "./kubectl-sanitize.js";
import { analyzeOutput, applySanitizer } from "./output-sanitizer.js";

const execFileAsync = promisify(execFile);

const SAFE_SUBCOMMANDS = new Set([
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
  "exec",
]);

// Compatibility re-export — old code imports SAFE_EXEC_COMMANDS from here
export { ALLOWED_COMMANDS as SAFE_EXEC_COMMANDS };
export { SAFE_SUBCOMMANDS };

interface KubectlParams {
  command: string;
  timeout_seconds?: number;
}

export function createKubectlTool(): ToolDefinition {
  return {
    name: "kubectl",
    label: "Kubectl",
    description: `Execute kubectl commands against the current Kubernetes cluster.
Read-only by default: only get, describe, logs, top, events, and other safe commands are allowed.
Use this tool for cluster inspection, troubleshooting, and diagnostics.

IMPORTANT limitations:
- This tool runs kubectl directly (not through a shell). Shell features like pipes (|), grep, awk, redirection (>, >>) are NOT supported.
- Use kubectl's built-in filtering: -l for label selectors, --field-selector, -o jsonpath, -o custom-columns instead of piping to grep/awk.
- If you need shell pipes or text processing, use the bash tool instead: bash("kubectl get pods | grep Error").
- Always use -o wide, -o yaml, or -o json for structured output rather than relying on text parsing.

kubectl exec is supported with a command whitelist (network diagnostics, RDMA/RoCE tools, perftest, GPU tools, system info).
For perftest (ib_write_bw, ib_send_bw, etc.), note these are server-client tools that require two concurrent processes.
Use the bash tool to run server+client together: bash("kubectl exec pod-a -- ib_write_bw & sleep 2 && kubectl exec pod-b -- ib_write_bw <pod-a-ip>; wait")

Examples:
- GOOD: "get pods -n kube-system -l app=coredns -o wide"
- GOOD: "get pods -A --field-selector status.phase!=Running"
- GOOD: "exec my-pod -n ns -- ip addr show"
- GOOD: "exec my-pod -n ns -- ibstat"
- GOOD: "exec my-pod -n ns -- ib_write_bw --help"
- BAD:  "get pods | grep Error" (pipes not supported, use bash tool)
- BAD:  "exec my-pod -- rm -rf /" (rm not in allowed list)`,
    parameters: Type.Object({
      command: Type.String({
        description:
          "kubectl arguments (e.g. 'get pods -n kube-system -o wide')",
      }),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 30, max: 120)",
        })
      ),
    }),
    renderCall(args: any, theme: any) {
      const cmd = args?.command || "...";
      return new Text(
        theme.fg("toolTitle", theme.bold("kubectl")) + " " + cmd,
        0, 0,
      );
    },
    renderResult: renderTextResult,
    async execute(_toolCallId, rawParams) {
      const params = rawParams as KubectlParams;
      const command = params.command;

      // Detect shell operators — kubectl tool doesn't use a shell
      if (/[|;&><]/.test(command.replace(/--[\w-]+=\S*/g, "").replace(/"[^"]*"|'[^']*'/g, ""))) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "Shell operators (|, &&, ;, >, <) are not supported in the kubectl tool. It runs kubectl directly without a shell.",
                  hint: `Use the bash tool instead: bash("kubectl ${command}")`,
                },
                null,
                2
              ),
            },
          ],
          details: { blocked: true },
        };
      }

      const args = parseArgs(command);
      const subcommand = args[0]?.toLowerCase();

      if (!subcommand || !SAFE_SUBCOMMANDS.has(subcommand)) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: `Subcommand "${subcommand}" is not allowed in read-only mode.`,
                  allowed: [...SAFE_SUBCOMMANDS],
                },
                null,
                2
              ),
            },
          ],
          details: { blocked: true, subcommand },
        };
      }

      // Validate exec sub-commands
      if (subcommand === "exec") {
        const execCheck = validateExecCommand(args);
        if (execCheck) {
          return {
            content: [{ type: "text", text: execCheck }],
            details: { blocked: true, subcommand: "exec" },
          };
        }
      }

      // Block "kubectl config view --raw" — leaks full kubeconfig with certs/tokens
      if (subcommand === "config") {
        const configSub = args.filter((a) => !a.startsWith("-"));
        const hasView = configSub.includes("view");
        const hasRaw = args.includes("--raw");
        if (hasView && hasRaw) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "kubectl config view --raw is not allowed — it exposes credentials.",
              }, null, 2),
            }],
            details: { blocked: true, subcommand: "config" },
          };
        }
      }

      // Sensitive resource protection (Secret, ConfigMap, Pod)
      const sensitiveSubcommands = ["get", "describe"];
      const sensitiveResource = sensitiveSubcommands.includes(subcommand)
        ? detectSensitiveResource(args)
        : null;

      if (sensitiveResource) {
        const outputFormat = getOutputFormat(args);

        // Block describe for ConfigMap/Pod (human-readable format can't be reliably sanitized)
        if (subcommand === "describe" && sensitiveResource !== "secret") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `"kubectl describe ${sensitiveResource}" may expose sensitive data that cannot be reliably sanitized.`,
                hint: `Use "kubectl get ${sensitiveResource} <name> -o json" instead — structured output is automatically sanitized.`,
              }, null, 2),
            }],
            details: { blocked: true, subcommand: "describe", sensitiveResource },
          };
        }

        // Block template-based output formats (can't reliably sanitize)
        if (outputFormat === "jsonpath" || outputFormat === "go-template" || outputFormat === "custom-columns") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `"-o ${outputFormat}" is not allowed for ${sensitiveResource} resources — template output cannot be reliably sanitized.`,
                hint: `Use "-o json" instead — JSON output is automatically sanitized to redact sensitive values.`,
              }, null, 2),
            }],
            details: { blocked: true, outputFormat, sensitiveResource },
          };
        }

        // Output sanitization via framework (json → sanitize, yaml → rewrite to json + sanitize)
        // Block actions (jsonpath/go-template/describe) are handled above; framework only does sanitize/rewrite.
        const action = analyzeOutput("kubectl", args);
        if (action) {
          const execArgs = action.type === "rewrite" ? action.newArgs : args;
          const timeout = Math.min(params.timeout_seconds ?? 30, 120) * 1000;
          try {
            const { stdout, stderr } = await execFileAsync("kubectl", execArgs, {
              timeout,
              maxBuffer: 1024 * 1024 * 10,
            });
            const sanitized = applySanitizer(stdout.trim(), action);
            const output = sanitized +
              (stderr.trim() ? `\n\nSTDERR:\n${stderr.trim()}` : "");
            return {
              content: [{ type: "text", text: processToolOutput(output) }],
              details: { exitCode: 0, sanitized: true },
            };
          } catch (err: any) {
            // Sanitize err.stdout too — partial output may contain sensitive data
            const sanitizedStdout = err.stdout?.trim()
              ? applySanitizer(err.stdout.trim(), action)
              : "";
            const output = `Exit code: ${err.code ?? "unknown"}\n${sanitizedStdout}\n${err.stderr?.trim() ?? err.message}`;
            return {
              content: [{ type: "text", text: processToolOutput(output) }],
              details: { exitCode: err.code, error: true, sanitized: true },
            };
          }
        }

        // Default table / -o wide / -o name: safe, fall through to normal execution
      }

      const timeout = Math.min(params.timeout_seconds ?? 30, 120) * 1000;

      try {
        const { stdout, stderr } = await execFileAsync("kubectl", args, {
          timeout,
          maxBuffer: 1024 * 1024 * 10,
        });
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

/**
 * Validate the command after `--` in `kubectl exec`.
 * Returns an error message if blocked, or null if allowed.
 */
export function validateExecCommand(args: string[]): string | null {
  const dashDashIndex = args.indexOf("--");
  if (dashDashIndex === -1 || dashDashIndex === args.length - 1) {
    return JSON.stringify({
      error: 'kubectl exec requires "--" followed by a command.',
      example: 'exec my-pod -- ip addr show',
    }, null, 2);
  }

  // The executable is the first arg after --
  const execBinary = args[dashDashIndex + 1];
  // Extract basename (handle /usr/bin/ping -> ping)
  const baseName = execBinary.split("/").pop()?.toLowerCase() ?? "";

  if (!ALLOWED_COMMANDS.has(baseName)) {
    return JSON.stringify({
      error: `Command "${baseName}" is not in the allowed exec command list.`,
      allowed_categories: {
        network: "ip, ifconfig, ping, traceroute, ss, netstat, ethtool, ...",
        rdma: "ibstat, ibv_devinfo, rdma, show_gids, ...",
        perftest: "ib_write_bw, ib_read_bw, ib_send_bw, ib_write_lat, ib_read_lat, ib_send_lat, ...",
        gpu: "nvidia-smi, gpustat, nvtopo",
        system: "cat, ls, ps, top, df, free, dmesg, lspci, ...",
      },
    }, null, 2);
  }

  // Apply command-level restrictions (find -exec, sysctl -w, curl -o, etc.)
  const execCmd = args.slice(dashDashIndex + 1).join(" ");
  const restrictionErr = validateCommandRestrictions(execCmd);
  if (restrictionErr) return restrictionErr;

  // Check sensitive path patterns (validateExecCommand does not go through
  // Pass 6 of validateCommand, so we check explicitly here)
  if (CONTAINER_SENSITIVE_PATHS.some((re) => re.test(execCmd))) {
    return JSON.stringify({
      error: "Accessing sensitive paths inside containers is not allowed.",
    }, null, 2);
  }

  return null;
}

// Re-export parseArgs for backward compatibility
export { parseArgs } from "./command-sets.js";
