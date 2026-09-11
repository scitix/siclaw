import { randomUUID } from "node:crypto";
import { identifier, record } from "./validation.js";

export const TRAFFIC_ACQUIRE = "sandbox.traffic.acquire";
export const TRAFFIC_RELEASE = "sandbox.traffic.release";
export const TRAFFIC_WAIT_MS = 30_000;
export const TRAFFIC_LEASE_MS = 150_000;
export const TRAFFIC_KEY = /^(cluster|mcp|host|node|pod):[a-f0-9]{64}$/;

export interface TrafficRequest { id: string; user: string; keys: string[] }
export function trafficRequest(value: unknown): TrafficRequest {
  if (!record(value) || Object.keys(value).some(k => !["id", "user", "keys"].includes(k)) ||
      typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id) || !identifier(value.user) ||
      !Array.isArray(value.keys) || !value.keys.length || value.keys.length > 2 ||
      value.keys.some(k => typeof k !== "string" || !TRAFFIC_KEY.test(k)) || new Set(value.keys).size !== value.keys.length) {
    throw new Error("Invalid tool admission request");
  }
  return value as unknown as TrafficRequest;
}

export class ScriptTrafficBusyError extends Error {
  constructor() { super("Target service busy; wait and retry later without changing the script"); }
}

interface Bucket { tokens: number; updated: number }
interface Lease { owner: string; keys: string[]; expires: number }
interface Waiting extends TrafficRequest { owner: string; expires: number; resolve(): void; reject(error: Error): void }

/** Single-instance control-plane admission. Runtime replicas share THIS gate.
 * The companion distributed implementation uses the same atomic multi-key rules.
 */
export class SandboxTrafficGate {
  private leases = new Map<string, Lease>();
  private buckets = new Map<string, Bucket>();
  private queue: Waiting[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private lastUser = "";
  constructor(private readonly concurrency = 10, private readonly rate = 10, private readonly burst = 20) {}

  async acquire(raw: unknown, owner: string): Promise<{ lease_id: string }> {
    const r = trafficRequest(raw);
    this.prune();
    if (!identifier(owner) || this.leases.has(r.id) || this.queue.some(q => q.id === r.id) ||
        this.queue.length >= 1000 || r.keys.some(k => this.queue.filter(q => q.keys.includes(k)).length >= 100)) throw new ScriptTrafficBusyError();
    await new Promise<void>((resolve, reject) => {
      this.queue.push({ ...r, owner, resolve, reject, expires: Date.now() + TRAFFIC_WAIT_MS });
      this.pump();
    });
    return { lease_id: r.id };
  }

  release(id: string, owner: string): void {
    const lease = this.leases.get(id);
    if (lease && lease.owner !== owner) throw new Error("Tool admission owner mismatch");
    this.leases.delete(id);
    this.pump();
  }

  private prune() {
    const now = Date.now();
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
  acquire(keys: string[], user: string, signal: AbortSignal): Promise<() => Promise<void>>;
}

/** No credentials, URLs or caller-controlled quotas cross this private RPC. */
export class RemoteScriptTraffic implements ScriptTrafficAdmission {
  constructor(private readonly rpc: { request(method: string, params: Record<string, unknown>, timeout?: number): Promise<unknown> }) {}
  async acquire(keys: string[], user: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const id = randomUUID();
    const release = async () => { await this.rpc.request(TRAFFIC_RELEASE, { id }, 5000).catch(() => {}); };
    const result = await this.rpc.request(TRAFFIC_ACQUIRE, { id, user, keys }, TRAFFIC_WAIT_MS + 5000)
      .catch(() => { throw new ScriptTrafficBusyError(); });
    if (!record(result) || result.lease_id !== id) throw new ScriptTrafficBusyError();
    if (signal.aborted) { await release(); signal.throwIfAborted(); }
    return release;
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
