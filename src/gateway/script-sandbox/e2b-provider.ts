import { PassThrough, Writable } from "node:stream";
import { ScriptFrameParser } from "../../script-sandbox/protocol.js";
import type { ScriptChannel, ScriptSandboxConfig, ScriptSandboxProvider } from "../../script-sandbox/types.js";
import { E2bClient } from "./e2b-client.js";
import type { ExternalScriptTools } from "./external-tools.js";

export class E2bScriptSandboxProvider implements ScriptSandboxProvider {
  private readonly client: E2bClient;
  constructor(private readonly config: ScriptSandboxConfig, private readonly tools: ExternalScriptTools, client?: E2bClient) {
    if (!config.e2b) throw new Error("E2B service configuration required");
    this.client = client ?? new E2bClient(config.e2b);
  }

  async start(_id: string, isolated: boolean, seconds: number, signal: AbortSignal): Promise<ScriptChannel> {
    // The pool already includes its idle budget in seconds.
    const lifetime = Math.min(seconds + 90, 3600);
    const instance = await this.client.create(lifetime, signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const stdout = new PassThrough(), stderr = new PassThrough();
    let pid = 0;
    let lease: Awaited<ReturnType<ExternalScriptTools["open"]>> | undefined;
    let complete!: (code: number | null) => void;
    const done = new Promise<number | null>(resolve => { complete = resolve; });
    let started!: () => void, failed!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { started = resolve; failed = reject; });
    let closed: Promise<void> | undefined;
    let killed = false;
    const close = () => closed ??= (async () => {
      controller.abort();
      signal.removeEventListener("abort", abort);
      try {
        await lease?.close();
      } finally {
        try {
          if (!killed) {
            for (let attempt = 0; ; attempt++) {
              try { await this.client.kill(instance.id); killed = true; break; }
              catch (error) { if (attempt === 2) throw error; }
            }
          }
        } finally { complete(null); stdout.destroy(); stderr.destroy(); }
      }
    })().catch(error => { closed = undefined; throw error; });
    const parser = new ScriptFrameParser();
    const stdin = new Writable({ write: (chunk, _encoding, callback) => {
      void (async () => {
        for (const frame of parser.push(chunk)) {
          let wire: unknown = frame;
          if (frame.type === "start") {
            if (!lease) throw new Error("External sandbox grant required");
            wire = { type: "configure", endpoint: lease.endpoint, token: lease.token, start: frame };
          } else if (frame.type !== "hello") throw new Error("Invalid external runner input");
          // configure includes service fields and can slightly exceed a script frame.
          await this.client.input(instance, pid, JSON.stringify(wire) + "\n", controller.signal);
        }
      })().then(() => callback(), () => callback(new Error("E2B runner transport failed")));
    } });
    // Never surface provider errors (they can contain service credentials).
    stdin.on("error", () => { complete(null); });
    const timer = setTimeout(() => controller.abort(), 30_000);
    void (async () => {
      let code: number | null = null;
      try {
        for await (const event of this.client.start(instance, isolated, lifetime, controller.signal)) {
          if (event.start && !pid && Number.isSafeInteger(event.start.pid) && event.start.pid > 0) {
            pid = event.start.pid; clearTimeout(timer); started();
          } else if (event.data && pid) {
            for (const [key, stream] of [["stdout", stdout], ["stderr", stderr]] as const) {
              const value = event.data[key];
              if (value === undefined) continue;
              if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid E2B output");
              // Bound buffers even if an external process floods before readiness.
              if (stream.readableLength + Buffer.byteLength(value) > 1024 * 1024) throw new Error("E2B output exceeds buffer");
              stream.write(Buffer.from(value, "base64"));
            }
          } else if (event.end && pid && Number.isSafeInteger(event.end.exitCode ?? 0)) code = event.end.exitCode ?? 0;
          else if (!event.keepalive) throw new Error("Invalid E2B process event");
        }
      } catch { /* Output is deliberately discarded; caller sees a generic failure. */ }
      finally { clearTimeout(timer); failed(new Error("E2B runner unavailable")); complete(code); }
    })();
    try {
      await ready;
      return { instanceId: instance.id, stdout, stderr, stdin, done, close,
        bindTools: async binding => {
          if (lease || controller.signal.aborted) throw new Error("E2B instance already used");
          lease = await this.tools.open(binding);
          if (controller.signal.aborted) { await lease.close(); throw new Error("E2B instance closed"); }
        },
      };
    } catch { await close(); throw new Error("E2B runner unavailable"); }
  }
}
