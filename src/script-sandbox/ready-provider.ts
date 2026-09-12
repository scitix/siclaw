import { ScriptFrameParser, encodeScriptFrame } from "./protocol.js";
import type { ScriptChannel, ScriptSandboxProvider } from "./types.js";
import { SandboxToolError } from "./errors.js";

/** A running container is not ready until its installed launcher/runner answers. */
export class ReadyScriptSandboxProvider implements ScriptSandboxProvider {
  private failedProfiles = new Map<boolean, number>();
  constructor(private readonly provider: ScriptSandboxProvider) {}

  async start(id: string, isolated: boolean, seconds: number, signal: AbortSignal): Promise<ScriptChannel> {
    if ((this.failedProfiles.get(isolated) ?? 0) > Date.now()) throw new SandboxToolError("RUNNER_PROTOCOL");
    const channel = await this.provider.start(id, isolated, seconds, signal);
    try {
      await new Promise<void>((resolve, reject) => {
        const parser = new ScriptFrameParser();
        const timer = setTimeout(() => finish(new Error("Runner readiness timed out")), 10_000);
        const abort = () => finish(new Error("Runner startup cancelled"));
        const finish = (error?: Error) => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
          channel.stdout.off("data", data);
          channel.stderr.off("data", discard);
          channel.stdin.off("error", finish);
          error ? reject(error) : resolve();
        };
        const discard = () => {}; // Never surface container/runtime diagnostics as credentials.
        const data = (chunk: Buffer) => {
          try {
            const frames = parser.push(chunk);
            if (!frames.length) return;
            if (frames.length !== 1 || frames[0].type !== "ready" || frames[0].version !== 3) throw new Error("Invalid runner handshake");
            parser.finish();
            finish();
          } catch { finish(new SandboxToolError("RUNNER_PROTOCOL")); }
        };
        channel.stdout.on("data", data);
        channel.stderr.on("data", discard);
        channel.stdin.on("error", finish);
        signal.addEventListener("abort", abort, { once: true });
        void channel.done.then(() => finish(new Error("Runner exited during startup")), () => finish(new Error("Runner disconnected during startup")));
        if (signal.aborted) abort();
        else channel.stdin.write(encodeScriptFrame({ type: "hello", version: 3 }));
      });
      return channel;
    } catch (error) {
      if (error instanceof SandboxToolError && error.code === "RUNNER_PROTOCOL") this.failedProfiles.set(isolated, Date.now() + 30_000);
      await channel.close(); throw error;
    }
  }

  async shutdown(): Promise<void> { await this.provider.shutdown?.(); }
}
