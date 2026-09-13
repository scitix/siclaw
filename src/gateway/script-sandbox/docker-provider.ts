import { SandboxToolError } from "../../script-sandbox/errors.js";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { scriptRunnerUid } from "../../script-sandbox/identity.js";
import type { ScriptChannel, ScriptSandboxConfig, ScriptSandboxProvider } from "../../script-sandbox/types.js";

const execFileAsync = promisify(execFile);

export function dockerScriptArgs(name: string, isolated: boolean, seconds: number, image: string): string[] {
  const uid = scriptRunnerUid(name);
  return ["run", "--rm", "--interactive", "--name", name, "--read-only", "--user", `${uid}:${uid}`,
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=256m", "--cpus=1",
    "--tmpfs", `/work:rw,nosuid,nodev,size=64m,uid=${uid},gid=${uid}`, "--tmpfs", `/tmp:rw,nosuid,nodev,size=32m,uid=${uid},gid=${uid}`,
    "--label", "siclaw.io/component=script-runner", "--label", `siclaw.io/expires=${Date.now() + (seconds + 90) * 1000}`,
    ...(isolated ? ["--network=none"] : []), image,
    isolated ? "isolated" : "standard", "/usr/local/bin/python3", "-I", "-B", "-u", "/opt/siclaw/runner.py", String(seconds + 90)];
}

/** Explicit local Docker provider; never falls back to spawning code on the host. */
export class DockerScriptSandboxProvider implements ScriptSandboxProvider {
  constructor(private readonly config: ScriptSandboxConfig) {}

  async start(runId: string, isolated: boolean, seconds: number, signal: AbortSignal): Promise<ScriptChannel> {
    signal.throwIfAborted();
    const name = `siclaw-script-${runId}`;
    const child = spawn("docker", dockerScriptArgs(name, isolated, seconds, this.config.image), { stdio: ["pipe", "pipe", "pipe"] });
    // The Docker CLI is trusted. Its environment is never passed through to the container.
    const done = new Promise<number | null>((resolve) => {
      child.once("error", () => resolve(125));
      child.once("close", (code) => resolve(code));
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      child.kill("SIGKILL");
      try { await execFileAsync("docker", ["rm", "--force", name], { timeout: 10_000 }); }
      catch (error) {
        if (!/No such container/i.test(String((error as { stderr?: string }).stderr))) throw new SandboxToolError("CLEANUP_PENDING", "UNKNOWN", "pending");
      }
      closed = true;
    };
    return { instanceId: name, stdout: child.stdout, stderr: child.stderr, stdin: child.stdin, done, close };
  }
}
