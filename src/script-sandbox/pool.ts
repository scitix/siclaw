import { randomUUID } from "node:crypto";
import type { ScriptChannel, ScriptSandboxConfig, ScriptSandboxProvider } from "./types.js";

interface WarmEntry { channel: ScriptChannel; expires: number; }

/** One-use prewarming. No code, inputs, credentials or principal enters idle instances. */
export class ScriptSandboxPool implements ScriptSandboxProvider {
  private idle = new Map<boolean, WarmEntry[]>([[false, []], [true, []]]);
  private filling = new Map<boolean, Promise<void>>();
  private stopped = false;
  private retiring = new Map<ScriptChannel, Promise<void>>();
  private controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  private preferredMode: boolean;

  constructor(private readonly provider: ScriptSandboxProvider, private readonly config: ScriptSandboxConfig) {
    this.preferredMode = config.requireNetworkIsolation || config.networkIsolation;
  }

  private retire(channel: ScriptChannel): Promise<void> {
    const existing = this.retiring.get(channel);
    if (existing) return existing;
    const cleanup = channel.close().catch(() => {
      console.warn("[script-sandbox] Warm instance cleanup unconfirmed; replacement withheld");
      // Keep ownership until shutdown retries. Do not refill past failed cleanup.
      throw new Error("Warm instance cleanup unconfirmed");
    });
    this.retiring.set(channel, cleanup);
    void cleanup.then(() => this.retiring.delete(channel), () => {});
    return cleanup;
  }

  prewarm(): void {
    if (!this.config.warmPoolSize || this.stopped) return;
    // Maintain separate pools: an installed seccomp filter cannot be removed.
    this.fill(this.preferredMode);
    this.timer ??= setInterval(() => {
      for (const mode of this.idle.keys()) {
        const entries = this.idle.get(mode)!;
        const expired = entries.filter(e => e.expires <= Date.now());
        for (const entry of expired) entries.splice(entries.indexOf(entry), 1);
        for (const entry of expired) void this.retire(entry.channel).catch(() => {});
        if (mode === this.preferredMode) this.fill(mode);
      }
    }, 10_000);
    this.timer.unref();
  }

  async waitForWarmup(): Promise<void> {
    this.prewarm();
    await this.filling.get(this.preferredMode);
  }

  private fill(mode: boolean): void {
    if (this.stopped || mode !== this.preferredMode || this.filling.has(mode) || !this.config.warmPoolSize || this.retiring.size) return;
    const task = (async () => {
      const entries = this.idle.get(mode)!;
      while (!this.stopped && mode === this.preferredMode && entries.length < this.config.warmPoolSize) {
        const channel = await this.provider.start(`warm-${randomUUID()}`, mode,
          this.config.warmIdleSeconds + this.config.maxTimeoutSeconds, this.controller.signal);
        if (this.stopped || mode !== this.preferredMode) { await this.retire(channel); return; }
        const entry = { channel, expires: Date.now() + this.config.warmIdleSeconds * 1000 };
        entries.push(entry);
        void channel.done.then(() => {
          const index = entries.indexOf(entry);
          if (index !== -1) { entries.splice(index, 1); void this.retire(channel).catch(() => {}); }
        }, () => {
          const index = entries.indexOf(entry);
          if (index !== -1) { entries.splice(index, 1); void this.retire(channel).catch(() => {}); }
        });
      }
    })().catch(() => {
      // A warm-up failure is not proof of support. A real request must still
      // create the requested profile or fail; it never changes isolation mode.
      console.warn("[script-sandbox] Prewarming unavailable; requested profiles remain enforced");
    }).finally(() => this.filling.delete(mode));
    this.filling.set(mode, task);
  }

  async start(runId: string, isolated: boolean, timeoutSeconds: number, signal: AbortSignal): Promise<ScriptChannel> {
    if (this.stopped || signal.aborted) throw new Error("Script execution cancelled");
    const entries = this.idle.get(isolated)!;
    const filling = this.filling.get(isolated);
    const waitedForWarmup = !entries.length && !!filling;
    if (waitedForWarmup) {
      // Join an already-started provision instead of competing with it for the
      // final schedulable Pod slot. Cancelling a caller leaves shared warmup alone.
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal.removeEventListener("abort", abort); reject(new Error("Script execution cancelled")); };
        signal.addEventListener("abort", abort, { once: true });
        void filling!.then(() => { signal.removeEventListener("abort", abort); resolve(); });
        if (signal.aborted) abort();
      });
      if (this.stopped || signal.aborted) throw new Error("Script execution cancelled");
    }
    let entry: WarmEntry | undefined;
    while ((entry = entries.shift())) {
      if (entry.expires > Date.now()) break;
      await this.retire(entry.channel);
      entry = undefined;
    }
    // Never return a used instance to the pool. close() always destroys it.
    if (entry) {
      this.fill(this.preferredMode);
      return { ...entry.channel, warm: !waitedForWarmup };
    }
    // A speculative replacement must not take capacity ahead of the real run.
    const channel = await this.provider.start(runId, isolated, timeoutSeconds, signal);
    this.fill(this.preferredMode);
    return channel;
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.filling.values()]);
    await Promise.allSettled([...this.idle.values()].flat().map(e => this.retire(e.channel)));
    await Promise.allSettled([...this.retiring.keys()].map(channel => channel.close()));
    this.retiring.clear();
    this.idle.clear();
    await this.provider.shutdown?.();
  }
}
