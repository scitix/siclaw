import { ScriptFrameParser, encodeScriptFrame } from "./protocol.js";
import type { ScriptChannel, ScriptSandboxProvider } from "./types.js";

/** A running container is not ready until its installed launcher/runner answers. */
export class ReadyScriptSandboxProvider implements ScriptSandboxProvider {
  constructor(private readonly provider: ScriptSandboxProvider) {}

  async start(id: string, isolated: boolean, seconds: number, signal: AbortSignal): Promise<ScriptChannel> {
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
          } catch { finish(new Error("Runner handshake failed")); }
        };
        channel.stdout.on("data", data);
        channel.stderr.on("data", discard);
        channel.stdin.on("error", finish);
        signal.addEventListener("abort", abort, { once: true });
        void channel.done.then(() => finish(new Error("Runner exited during startup")));
        if (signal.aborted) abort();
        else channel.stdin.write(encodeScriptFrame({ type: "hello", version: 3 }));
      });
      return channel;
    } catch (error) { await channel.close(); throw error; }
  }

  async shutdown(): Promise<void> { await this.provider.shutdown?.(); }
}
