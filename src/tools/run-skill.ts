import { Type } from "@sinclair/typebox";
import { exec } from "node:child_process";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { KubeconfigRef } from "../core/agent-factory.js";
import { processToolOutput, renderTextResult } from "./tool-render.js";
import { loadConfig } from "../core/config.js";
import {
  resolveSkillScript,
  listSkillScripts,
  listAllSkillsWithScripts,
} from "./script-resolver.js";

interface RunSkillParams {
  skill: string;
  script: string;
  args?: string;
  timeout_seconds?: number;
}

export function createRunSkillTool(kubeconfigRef?: KubeconfigRef): ToolDefinition {
  return {
    name: "run_skill",
    label: "Run Skill",
    renderCall(args: any, theme: any) {
      return new Text(
        theme.fg("toolTitle", theme.bold("run_skill")) +
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
- skill: Skill name (e.g. "find-node", "roce-perftest-pod")
- script: Script filename (e.g. "find-node.sh", "run-perftest.py")
- args: Optional command-line arguments
- timeout_seconds: Timeout (default: 180, max: 300)

Examples:
- skill: "find-node", script: "find-node.sh", args: "A100"
- skill: "roce-perftest-pod", script: "run-perftest.py", args: "--server-pod srv --client-pod cli --server-ns ns --client-ns ns"
- skill: "roce-check-node-config", script: "check-node-config.py", args: "--node node1 --mode sriov-switchdev"

Do NOT use the bash tool to run skill scripts. Always use this tool instead.
Read the skill's SKILL.md first to understand required parameters and usage.`,
    parameters: Type.Object({
      skill: Type.String({
        description: "Skill name (e.g. 'find-node', 'roce-perftest-pod')",
      }),
      script: Type.String({
        description: "Script filename within the skill (e.g. 'find-node.sh', 'run-perftest.py')",
      }),
      args: Type.Optional(
        Type.String({
          description: "Command-line arguments to pass to the script",
        })
      ),
      timeout_seconds: Type.Optional(
        Type.Number({
          description: "Timeout in seconds (default: 180, max: 300)",
        })
      ),
    }),
    async execute(_toolCallId, rawParams, signal) {
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
          hint = `Available scripts for "${skill}": ${available.join(", ")}`;
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

      const args = params.args?.trim() || "";
      const command = args
        ? `${resolved.interpreter} ${resolved.path} ${args}`
        : `${resolved.interpreter} ${resolved.path}`;

      const timeout = Math.min(params.timeout_seconds ?? 180, 300) * 1000;

      try {
        const execOpts = {
          timeout,
          maxBuffer: 1024 * 1024 * 10,
          shell: "/bin/bash",
          detached: true, // make child a process group leader for clean group kill
          env: {
            ...process.env,
            SICLAW_DEBUG_IMAGE: loadConfig().debugImage,
            ...(kubeconfigRef?.credentialsDir ? { SICLAW_CREDENTIALS_DIR: kubeconfigRef.credentialsDir } : {}),
            KUBECONFIG: "/dev/null",
          },
        };
        const child = exec(command, execOpts as any);

        const onAbort = () => {
          // Kill the entire process group (shell + all child processes like kubectl exec)
          // so cleanup doesn't block the abort. SIGKILL is untrappable.
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
