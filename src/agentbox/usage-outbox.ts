import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UsageBatch, UsageBatchResponse, UsageObservation } from "../shared/model-usage.js";

interface State { collectorId: string; sessionId: string; dropped: number; rejected: number; lastSuccessAt?: string }
/** Independent of session transcripts: handoff cleanup must not delete pending usage. */
export class UsageOutbox {
  private state: State;
  private bytes = 0;
  private files = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private timerAt = 0;
  private active?: Promise<void>;
  private stopped = false;
  private retryMs = 1000;
  constructor(
    private readonly directory: string,
    private readonly send: (batch: UsageBatch) => Promise<UsageBatchResponse>,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = { collectorId: randomUUID(), sessionId: "", dropped: 0, rejected: 0 };
    try {
      const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
      if (typeof state.collectorId !== "string" || typeof state.sessionId !== "string" ||
          !Number.isSafeInteger(state.dropped) || !Number.isSafeInteger(state.rejected)) throw new Error("invalid state");
      this.state = state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.state.dropped++;
        console.warn("[model-usage] collector state damaged; coverage is degraded");
      }
    }
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".event.json")) continue;
      const size = statSync(join(directory, name)).size;
      this.files.set(name, size);
      this.bytes += size;
    }
    this.saveState();
    this.schedule(250);
  }
  private saveState(): void {
    const temporary = join(this.directory, "state.tmp");
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600, flush: true });
    renameSync(temporary, join(this.directory, "state.json"));
  }
  record(observation: UsageObservation): void {
    this.state.sessionId = observation.sessionId;
    try {
      const content = JSON.stringify(observation);
      const size = Buffer.byteLength(content);
      if (size > 8192 || this.bytes + size > this.maxBytes) {
        this.state.dropped++;
        this.saveState();
        console.warn("[model-usage] outbox capacity exceeded; coverage is degraded");
        return;
      }
      const name = `${Date.now()}-${observation.callId}-${observation.phase}.event.json`;
      const path = join(this.directory, name);
      writeFileSync(path + ".tmp", content, { mode: 0o600, flush: true });
      renameSync(path + ".tmp", path);
      this.bytes += size - (this.files.get(name) ?? 0);
      this.files.set(name, size);
      this.saveState();
      this.schedule(250);
    } catch {
      this.state.dropped++;
      try { this.saveState(); } catch { /* Retain the counter in memory for the next health report. */ }
      console.warn("[model-usage] outbox write failed; coverage is degraded");
    }
  }
  private schedule(ms: number): void {
    if (this.stopped) return;
    const at = Date.now() + ms;
    if (this.timer && this.timerAt <= at) return;
    clearTimeout(this.timer);
    this.timerAt = at;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, ms);
    this.timer.unref();
  }
  private remove(name: string): void {
    unlinkSync(join(this.directory, name));
    this.bytes -= this.files.get(name) ?? 0;
    this.files.delete(name);
  }
  flush(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.flushBatch().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async flushBatch(): Promise<void> {
    try {
      const entries: { name: string; observation: UsageObservation }[] = [];
      let size = 0;
      for (const name of [...this.files.keys()].sort()) {
        if ((this.files.get(name) ?? 0) > 8192) {
          this.state.rejected++; this.saveState(); this.remove(name); continue;
        }
        if (entries.length >= 128 || size + (this.files.get(name) ?? 0) > 500 * 1024) break;
        try {
          const observation = JSON.parse(readFileSync(join(this.directory, name), "utf8")) as UsageObservation;
          if (observation.schemaVersion !== 1 || typeof observation.callId !== "string" ||
              !["started", "finished"].includes(observation.phase) || typeof observation.sessionId !== "string") throw new Error("invalid");
          entries.push({ name, observation });
          size += this.files.get(name) ?? 0;
        } catch {
          // Corrupt observations are counted, never silently replayed as valid data.
          this.state.rejected++;
          this.saveState();
          this.remove(name);
        }
      }
      const sessionId = this.state.sessionId || entries[0]?.observation.sessionId;
      if (!sessionId) { this.schedule(30_000); return; }
      const response = await this.send({ observations: entries.map(e => e.observation), health: {
        ...this.state, sessionId, pending: this.files.size,
        oldestAt: entries[0]?.observation.requestAt, capturedAt: new Date().toISOString(),
      } });
      if (!Array.isArray(response.results)) throw new Error("missing acknowledgments");
      for (const entry of entries) {
        const ack = response.results.find(a => a.callId === entry.observation.callId && a.phase === entry.observation.phase);
        if (!ack || ack.status === "retryable") continue;
        if (ack.status === "rejected") { this.state.rejected++; this.saveState(); }
        if (["accepted", "duplicate", "rejected"].includes(ack.status)) this.remove(entry.name);
      }
      this.state.lastSuccessAt = new Date().toISOString();
      this.saveState();
      this.retryMs = 1000;
      this.schedule(this.files.size ? 250 : 30_000);
    } catch {
      this.schedule(this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
    }
  }
  async close(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await Promise.race([this.flush(), new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 3000); timer.unref();
    })]);
  }
}
