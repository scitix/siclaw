import { ADMISSION_WAIT_MS, ADMISSION_LEASE_MS } from "./budgets.js";
import { randomUUID } from "node:crypto";
import { SandboxToolError } from "./errors.js";
import { identifier, record } from "./validation.js";

export const TRAFFIC_ACQUIRE = "sandbox.traffic.acquire";
export const TRAFFIC_RELEASE = "sandbox.traffic.release";
export const TRAFFIC_INFO = "sandbox.traffic.info";
export const TRAFFIC_WAIT_MS = ADMISSION_WAIT_MS;
export const TRAFFIC_LEASE_MS = ADMISSION_LEASE_MS;
export const TRAFFIC_KEY = /^(cluster|mcp|host|node|pod):[a-f0-9]{64}$/;

export interface TrafficRequest { id: string; user: string; keys: string[]; expires_at?: number }
export function trafficRequest(value: unknown): TrafficRequest {
  if (!record(value) || Object.keys(value).some(k => !["id", "user", "keys", "expires_at"].includes(k)) ||
      typeof value.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id) || !identifier(value.user) ||
      (value.expires_at !== undefined && (!Number.isSafeInteger(value.expires_at) || Number(value.expires_at) <= Date.now() || Number(value.expires_at) > Date.now() + TRAFFIC_WAIT_MS + 5000)) ||
      !Array.isArray(value.keys) || !value.keys.length || value.keys.length > 2 ||
      value.keys.some(k => typeof k !== "string" || !TRAFFIC_KEY.test(k)) || new Set(value.keys).size !== value.keys.length) {
    throw new Error("Invalid tool admission request");
  }
  return value as unknown as TrafficRequest;
}

export class ScriptTrafficBusyError extends SandboxToolError {
  constructor() { super("TARGET_BUSY"); }
}

interface Bucket { tokens: number; updated: number }
interface Lease { owner: string; keys: string[]; expires: number }
interface Waiting extends TrafficRequest { owner: string; expires: number; resolve(): void; reject(error: Error): void }

/** Single-instance control-plane admission. Runtime replicas share THIS gate.
 * The companion distributed implementation uses the same atomic multi-key rules.
 */
export class SandboxTrafficGate {
  private cancelled = new Map<string, { owner: string; expires: number }>();
  private leases = new Map<string, Lease>();
  private buckets = new Map<string, Bucket>();
  private queue: Waiting[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private lastUser = "";
  constructor(private readonly concurrency = 10, private readonly rate = 10, private readonly burst = 20) {}

  async acquire(raw: unknown, owner: string): Promise<{ lease_id: string }> {
    const r = trafficRequest(raw);
    this.prune();
    if (!identifier(owner) || this.cancelled.has(r.id) || this.leases.has(r.id) || this.queue.some(q => q.id === r.id) ||
        this.queue.length >= 1000 || r.keys.some(k => this.queue.filter(q => q.keys.includes(k)).length >= 100)) throw new ScriptTrafficBusyError();
    await new Promise<void>((resolve, reject) => {
      this.queue.push({ ...r, owner, resolve, reject, expires: r.expires_at ?? Date.now() + TRAFFIC_WAIT_MS });
      this.pump();
    });
    return { lease_id: r.id };
  }

  release(id: string, owner: string): void {
    this.prune();
    const lease = this.leases.get(id);
    const waiter = this.queue.find(q => q.id === id);
    const cancelled = this.cancelled.get(id);
    if ([lease, waiter, cancelled].some(v => v && v.owner !== owner)) throw new Error("Tool admission owner mismatch");
    this.cancelled.set(id, { owner, expires: Date.now() + TRAFFIC_LEASE_MS });
    if (waiter) { this.queue.splice(this.queue.indexOf(waiter), 1); waiter.reject(new ScriptTrafficBusyError()); }
    this.leases.delete(id);
    this.pump();
  }

  private prune() {
    const now = Date.now();
    for (const [id, value] of this.cancelled) if (value.expires <= now) this.cancelled.delete(id);
    for (const [id, lease] of this.leases) if (lease.expires <= now) this.leases.delete(id);
    // Inactive target names must not grow process memory indefinitely.
    for (const [key, bucket] of this.buckets) if (now - bucket.updated > TRAFFIC_LEASE_MS) this.buckets.delete(key);
    this.queue = this.queue.filter(q => {
      if (q.expires > now) return true;
      q.reject(new ScriptTrafficBusyError()); return false;
    });
  }

  private available(keys: string[]): boolean {
    const now = Date.now();
    return keys.every(key => {
      const shared = /^(cluster|mcp):/.test(key);
      const used = [...this.leases.values()].filter(l => l.keys.includes(key)).length;
      if (used >= (shared ? this.concurrency : 1)) return false;
      if (!shared) return true;
      const bucket = this.buckets.get(key) ?? { tokens: this.burst, updated: now };
      bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.updated) * this.rate / 1000);
      bucket.updated = now; this.buckets.set(key, bucket);
      return bucket.tokens >= 1;
    });
  }

  private pump() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.prune();
    while (true) {
      const ready = this.queue.filter(q => this.available(q.keys));
      const next = ready.find(q => q.user !== this.lastUser) ?? ready[0];
      if (!next) break;
      this.queue.splice(this.queue.indexOf(next), 1);
      for (const key of next.keys) if (/^(cluster|mcp):/.test(key)) this.buckets.get(key)!.tokens--;
      this.leases.set(next.id, { owner: next.owner, keys: next.keys, expires: Date.now() + TRAFFIC_LEASE_MS });
      this.lastUser = next.user;
      next.resolve();
    }
    if (this.queue.length) {
      this.timer = setTimeout(() => this.pump(), 100);
      this.timer.unref();
    }
  }
}

export interface ScriptTrafficAdmission {
  prepare?(): Promise<void>;
  acquire(keys: string[], user: string, signal: AbortSignal): Promise<() => Promise<void>>;
}

/** No credentials, URLs or caller-controlled quotas cross this private RPC. */
export class RemoteScriptTraffic implements ScriptTrafficAdmission {
  constructor(private readonly rpc: { request(method: string, params: Record<string, unknown>, timeout?: number): Promise<unknown> }) {}
  private ready?: Promise<void>;
  async prepare(): Promise<void> {
    const task = this.ready ??= this.rpc.request(TRAFFIC_INFO, {}, 5000).then(info => {
      if (!record(info) || info.version !== 1) throw new SandboxToolError("UNSUPPORTED_PROTOCOL");
    }).catch(() => { this.ready = undefined; throw new SandboxToolError("UNSUPPORTED_PROTOCOL"); });
    return task;
  }
  async acquire(keys: string[], user: string, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.prepare();
    signal.throwIfAborted();
    const id = randomUUID();
    const release = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await this.rpc.request(TRAFFIC_RELEASE, { id }, 3000); return; } catch { /* bounded, idempotent cleanup */ }
      }
      console.warn("[script-sandbox] Admission release unconfirmed; lease retained until expiry");
    };
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new Error("cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      const result = await Promise.race([cancelled,
        this.rpc.request(TRAFFIC_ACQUIRE, { id, user, keys, expires_at: Date.now() + TRAFFIC_WAIT_MS }, TRAFFIC_WAIT_MS + 5000)]);
      if (record(result) && result.code === "TARGET_BUSY") throw new ScriptTrafficBusyError();
      if (!record(result) || result.lease_id !== id) throw new SandboxToolError("SERVICE_UNAVAILABLE");
      signal.throwIfAborted();
      return release;
    } catch (error) {
      // The request may have committed despite a lost reply. Cancellation is
      // idempotent and fenced against an acquire arriving after this release.
      await release();
      if (signal.aborted || error instanceof SandboxToolError) throw error;
      throw new SandboxToolError("SERVICE_UNAVAILABLE");
    } finally { signal.removeEventListener("abort", abort); }
  }
}

/** Explicit local option for deterministic smoke transports, never an RPC fallback. */
export class LocalScriptTraffic implements ScriptTrafficAdmission {
  constructor(private readonly gate = new SandboxTrafficGate()) {}
  async acquire(keys: string[], user: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const id = randomUUID();
    await this.gate.acquire({ id, user, keys }, "local");
    const release = async () => { this.gate.release(id, "local"); };
    if (signal.aborted) { await release(); signal.throwIfAborted(); }
    return release;
  }
}
