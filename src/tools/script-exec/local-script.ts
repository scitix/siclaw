import type { ToolEntry, BackgroundExecWiring } from "../../core/tool-registry.js";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { KubeconfigRef } from "../../core/types.js";
import { renderTextResult } from "../infra/tool-render.js";
import { postExecSecurity } from "../infra/security-pipeline.js";
import { BACKGROUND_BASH_ENABLED } from "../../core/subagent-registry.js";
import { backgroundLaunchedResult } from "../cmd-exec/background-launch.js";
import { loadConfig } from "../../core/config.js";
import { resolveRequiredKubeconfig } from "../infra/kubeconfig-resolver.js";
import { ensureClusterForTool } from "../infra/ensure-kubeconfigs.js";
import { sanitizeEnv } from "../infra/sanitize-env.js";
import { parseArgs } from "../infra/command-sets.js";
import {
  resolveSkillScript,
  listSkillScripts,
  listAllSkillsWithScripts,
  skillMdHint,
} from "../infra/script-resolver.js";
import { emitDiagnostic } from "../../shared/diagnostic-events.js";

interface RunSkillParams {
  skill: string;
  script: string;
  args?: string;
  cluster?: string;
  timeout_seconds?: number;
  run_in_background?: boolean;
}

export function createLocalScriptTool(
  kubeconfigRef?: KubeconfigRef,
  sessionIdRef?: { current: string },
  userId?: string,
  agentId?: string | null,
  bg?: BackgroundExecWiring,
): ToolDefinition {
  const backgroundEnabled = BACKGROUND_BASH_ENABLED && Boolean(bg?.executor);
  return {
    name: "local_script",
    label: "Local Script",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("local_script")) +
          " " + theme.fg("accent", args?.skill || "") +
          "/" + theme.fg("accent", args?.script || "") +
          (args?.args ? " " + theme.fg("muted", args.args) : ""),
        0, 0,
      );
    },
    renderResult: renderTextResult,
    description: `Execute a skill script by skill name and script filename.

Skills have helper scripts under their scripts/ directory. Use this tool to run them instead of calling bash directly.

Parameters:
- skill: Skill name (e.g. "volcano-queue-diagnose", "roce-perftest-pod")
- script: Script filename (e.g. "diagnose-queue.sh", "run-perftest.py")
- args: Optional command-line arguments
- cluster: Cluster name (use cluster_list to discover). Omit for non-Kubernetes work or to use the default cluster when only one is available.
- timeout_seconds: Timeout (default: 180, max: 300)

Examples:
- skill: "volcano-queue-diagnose", script: "diagnose-queue.sh"
- skill: "roce-perftest-pod", script: "run-perftest.py", args: "--server-pod srv --client-pod cli --server-ns ns --client-ns ns"
- skill: "roce-check-node-config", script: "check-node-config.py", args: "--node node1 --mode sriov-switchdev"

If the script doesn't exist, the tool returns a list of available scripts for that skill.
Do NOT use the bash tool to run skill scripts locally. Always use this tool instead.
Read the skill's SKILL.md first to understand required parameters and usage.`,
    parameters: Type.Object({
      skill: Type.String({
        description: "Skill name (e.g. 'volcano-queue-diagnose', 'roce-perftest-pod')",
      }),
      script: Type.String({
        description: "Exact script filename from the skill's scripts/ directory, as listed in its SKILL.md (e.g. 'diagnose-queue.sh', 'run-perftest.py'). Use it verbatim — do not guess or modify the name.",
      }),
      args: Type.Optional(
        Type.String({
          description: "Command-line arguments to pass to the script",
        })
      ),
      cluster: Type.Optional(
        Type.String({
          description: "Cluster name (from cluster_list). If omitted, uses the default cluster when only one is available.",
        })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 180, max: 300)",
        })
      ),
      ...(backgroundEnabled
        ? {
            run_in_background: Type.Optional(
              Type.Boolean({
                description:
                  "Run the script in the background instead of waiting. Returns immediately with a task_id " +
                  "and output_file. After launching, END YOUR TURN by default (do NOT poll, sleep, or read the " +
                  "output_file until the completion notification). EXCEPTION: when this is the server/listener side " +
                  "of a paired test, do NOT wait — IMMEDIATELY run the counterpart, then read the output_file when the " +
                  "test finishes (waiting for the server's completion first deadlocks: it blocks until the client " +
                  "connects, then times out). Use for long-running skill scripts (orchestration, soak, perftest).",
              })
            ),
          }
        : {}),
    }),
    async execute(toolCallId, rawParams, signal) {
      const params = rawParams as RunSkillParams;
      const skill = params.skill?.trim();
      const script = params.script?.trim();

      if (!skill || !script) {
        return {
          content: [{ type: "text", text: "Error: both skill and script are required." }],
          details: { error: true },
        };
      }

      // Validate no path traversal
      if (skill.includes("/") || skill.includes("\\") || script.includes("/") || script.includes("\\")) {
        return {
          content: [{ type: "text", text: "Error: skill and script names must not contain path separators." }],
          details: { error: true },
        };
      }

      const resolved = resolveSkillScript(skill, script);
      if (!resolved) {
        const available = listSkillScripts(skill);
        let hint: string;
        if (available.length > 0) {
          hint = `Available scripts for "${skill}": ${available.join(", ")}${skillMdHint(skill)}`;
        } else {
          // List all skills that DO have scripts to help the LLM
          const allSkillsWithScripts = listAllSkillsWithScripts();
          hint = `Skill "${skill}" has no scripts directory — follow its SKILL.md instructions using bash/other tools instead.`;
          if (allSkillsWithScripts.length > 0) {
            hint += `\n\nSkills with scripts: ${allSkillsWithScripts.map((s) => `${s.skill} (${s.scripts.join(", ")})`).join("; ")}`;
          }
        }
        return {
          content: [{ type: "text", text: `Error: script "${script}" not found in skill "${skill}". ${hint}` }],
          details: { error: true },
        };
      }

      try {
        await ensureClusterForTool(kubeconfigRef?.credentialBroker, params.cluster, "local_script");
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true, reason: "kubeconfig_ensure_failed" },
        };
      }

      // Resolve kubeconfig — requires explicit selection when multiple clusters exist
      const kubeResult = resolveRequiredKubeconfig({ broker: kubeconfigRef?.credentialBroker }, params.cluster);
      if ("error" in kubeResult) {
        return {
          content: [{ type: "text", text: `Error: ${kubeResult.error}` }],
          details: { error: true },
        };
      }

      const args = params.args?.trim() || "";
      // Security: parse args into array and pass via spawn() — never interpolate
      // into a shell command string (prevents shell injection via args parameter)
      const cmdArgs = args ? parseArgs(args) : [];

      const childEnv: Record<string, string> = {
        ...sanitizeEnv(process.env as Record<string, string>),
        SICLAW_DEBUG_IMAGE: loadConfig().debugImage,
        ...(kubeconfigRef?.credentialsDir ? { SICLAW_CREDENTIALS_DIR: kubeconfigRef.credentialsDir } : {}),
        KUBECONFIG: kubeResult.path || "/dev/null",
      };

      // ── Background mode ──────────────────────────────────────────────
      // Reuse the child-process runner in argv mode: interpreter + [scriptPath, ...args].
      // Script output isn't sanitized (trusted asset), so action is null (line-safe).
      // Note: background launches don't emit the skill_call diagnostic (no terminal outcome yet).
      if (backgroundEnabled && params.run_in_background === true) {
        try {
          const { jobId, outputFile } = bg!.executor!({
            file: resolved.interpreter,
            args: [resolved.path, ...cmdArgs],
            env: childEnv,
            action: null,
            hasSensitiveKubectl: false,
            description: `${skill}/${script}${args ? " " + args : ""}`,
            parentSessionId: sessionIdRef?.current ?? "",
            jobId: toolCallId,
            isProd: process.env.NODE_ENV === "production",
            jobType: "local",
          });
          return backgroundLaunchedResult(jobId, outputFile, "Running the script in the background.");
        } catch (err) {
          console.warn(`[local-script] background launch declined, running foreground:`, err);
        }
      }

      const timeout = Math.min(params.timeout_seconds ?? 180, 300) * 1000;
      const startMs = Date.now();

      try {
        const child = spawn(resolved.interpreter, [resolved.path, ...cmdArgs], {
          detached: true, // make child a process group leader for clean group kill
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnv,
        });

        const onAbort = () => {
          // Kill the entire process group so cleanup doesn't block the abort.
          try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        };
        signal?.addEventListener("abort", onAbort, { once: true });

        const timer = setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
        }, timeout);

        const MAX_OUTPUT = 10 * 1024 * 1024; // 10 MB — matches old exec() maxBuffer
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
          let stdout = "";
          let stderr = "";
          let totalSize = 0;
          child.stdout.on("data", (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize <= MAX_OUTPUT) stdout += chunk.toString();
          });
          child.stderr.on("data", (chunk: Buffer) => {
            totalSize += chunk.length;
            if (totalSize <= MAX_OUTPUT) stderr += chunk.toString();
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            if (code === 0) resolve({ stdout, stderr });
            else reject(Object.assign(new Error(`exit ${code}`), { code, stdout, stderr }));
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(err);
          });
        });

        emitDiagnostic({
          type: "skill_call",
          skillName: skill,
          scriptName: script,
          scope: resolved.scope,
          outcome: "success",
          durationMs: Date.now() - startMs,
          sessionId: sessionIdRef?.current,
          userId: userId ?? "unknown",
          agentId: agentId ?? null,
        });
        return {
          content: [{ type: "text", text: postExecSecurity(stdout.trim(), null, { stderr: stderr.trim() || undefined }) }],
          details: { exitCode: 0 },
        };
      } catch (err: any) {
        const errStderr = err.stderr?.trim() ?? err.message;
        emitDiagnostic({
          type: "skill_call",
          skillName: skill,
          scriptName: script,
          scope: resolved.scope,
          outcome: "error",
          durationMs: Date.now() - startMs,
          sessionId: sessionIdRef?.current,
          userId: userId ?? "unknown",
          agentId: agentId ?? null,
        });
        return {
          content: [{ type: "text", text: postExecSecurity(`Exit code: ${err.code ?? "unknown"}\n${err.stdout?.trim() ?? ""}`, null, { stderr: errStderr || undefined }) }],
          details: { exitCode: err.code, error: true },
        };
      }
    },
  };
}

export const registration: ToolEntry = {
  category: "script-exec",
  create: (refs) =>
    createLocalScriptTool(refs.kubeconfigRef, refs.sessionIdRef, refs.userId, refs.agentId, {
      executor: refs.backgroundExecExecutor,
      sessionIdRef: refs.sessionIdRef,
    }),
};
