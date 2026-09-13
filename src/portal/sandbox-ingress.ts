import { SandboxToolError } from "../script-sandbox/errors.js";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SANDBOX_HTTP_LIMIT, SANDBOX_LEASE_CLOSE, SANDBOX_LEASE_OPEN, SANDBOX_TOOL_PATH, SANDBOX_TOOL_RPC, sandboxToolEndpoint } from "../script-sandbox/external-protocol.js";
import { identifier, record } from "../script-sandbox/validation.js";
import type { RestRouter } from "../gateway/rest-router.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";
import { SandboxTrafficGate, TRAFFIC_ACQUIRE, TRAFFIC_RELEASE, TRAFFIC_INFO, ScriptTrafficBusyError } from "../script-sandbox/traffic.js";

type Handler = (params: any, runtimeId: string) => Promise<any>;
interface Lease { runtimeId: string; runId: string; expires: number; busy: number; calls: number; ids: Set<string> }

/** Standalone Portal is single-instance. Only hashes, never bearer tokens, are retained here. */
export function registerSandboxIngress(router: RestRouter, handlers: Map<string, Handler>, connections: RuntimeConnectionMap, publicUrl?: string): void {
  const limit = (name: string, fallback: number) => {
    const value = Number(process.env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("Invalid sandbox traffic limit");
    return value;
  };
  let traffic: SandboxTrafficGate | undefined;
  const gate = () => traffic ??= new SandboxTrafficGate(limit("SICLAW_SANDBOX_TARGET_CONCURRENCY", 10),
    limit("SICLAW_SANDBOX_TARGET_RPS", 10), limit("SICLAW_SANDBOX_TARGET_BURST", 20));
  handlers.set(TRAFFIC_INFO, async () => { gate(); return { version: 1 }; });
  handlers.set(TRAFFIC_ACQUIRE, async (p, runtimeId) => {
    try { return await gate().acquire(p, runtimeId); }
    catch (error) { if (error instanceof ScriptTrafficBusyError) return error.wire(); throw error; }
  });
  handlers.set(TRAFFIC_RELEASE, async (p, runtimeId) => {
    if (!record(p) || Object.keys(p).length !== 1 || typeof p.id !== "string" || !/^[a-f0-9-]{36}$/.test(p.id)) throw new Error("Invalid traffic lease");
    gate().release(p.id, runtimeId); return { ok: true };
  });
  const endpoint = publicUrl ? sandboxToolEndpoint(publicUrl) : undefined;
  const leases = new Map<string, Lease>();
  const prune = () => { for (const [hash, lease] of leases) if (lease.expires <= Date.now()) leases.delete(hash); };
  const denied = () => new Error("Sandbox grant denied or unavailable");
  handlers.set(SANDBOX_LEASE_OPEN, async (p, runtimeId) => {
    prune();
    if (!endpoint || !record(p) || Object.keys(p).some(k => !["token_hash", "run_id", "agent_id", "session_id", "expires_at"].includes(k)) ||
      typeof p.token_hash !== "string" || !/^[a-f0-9]{64}$/.test(p.token_hash) || !identifier(p.run_id) || !identifier(p.agent_id) || !identifier(p.session_id) ||
      typeof p.expires_at !== "number" || !Number.isSafeInteger(p.expires_at) || p.expires_at <= Date.now() || p.expires_at > Date.now() + 610_000 ||
      leases.size >= 1000 || leases.has(p.token_hash)) throw denied();
    await handlers.get("sandbox.resolve")!({ agent_id: p.agent_id, session_id: p.session_id, source: "", name: "" }, runtimeId);
    // Authorization awaits DB; recheck uniqueness and bounds before insertion.
    prune();
    if (leases.size >= 1000 || leases.has(p.token_hash) || p.expires_at <= Date.now()) throw denied();
    leases.set(p.token_hash, { runtimeId, runId: p.run_id, expires: p.expires_at, busy: 0, calls: 0, ids: new Set() });
    return { endpoint };
  });
  handlers.set(SANDBOX_LEASE_CLOSE, async (p, runtimeId) => {
    if (!record(p) || Object.keys(p).some(k => !["token_hash", "run_id"].includes(k)) || typeof p.token_hash !== "string" || !identifier(p.run_id)) throw denied();
    const lease = leases.get(p.token_hash);
    if (lease && (lease.runtimeId !== runtimeId || lease.runId !== p.run_id)) throw denied();
    leases.delete(p.token_hash);
    return { ok: true };
  });

  router.post(SANDBOX_TOOL_PATH, async (req, res) => {
    const send = (status: number, body: unknown) => {
      if (!res.destroyed) { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); }
    };
    const auth = req.headers.authorization;
    if (!endpoint || !auth || !/^Bearer [a-f0-9]{64}$/.test(auth)) { send(401, { error: "Sandbox grant denied" }); return; }
    const token = auth.slice(7);
    const hash = createHash("sha256").update(token).digest("hex");
    prune();
    const lease = leases.get(hash);
    if (!lease || lease.busy >= 10 || ++lease.calls > 4096) { send(403, { error: "Sandbox grant denied" }); return; }
    lease.busy++;
    let confirmed = true;
    let callId: string | undefined;
    try {
      const body = await boundedBody(req, res);
      if (!record(body) || Object.keys(body).length !== 1 || !record(body.call) || lease.expires <= Date.now() || leases.get(hash) !== lease) throw denied();
      const id = body.call.id;
      if (typeof id !== "string" || !id || id.length > 64 || lease.ids.has(id)) throw denied();
      lease.ids.add(id);
      callId = id;
      if (!connections.sendCommandToRuntime) throw new SandboxToolError("SERVICE_UNAVAILABLE");
      confirmed = false;
      const result = await connections.sendCommandToRuntime(lease.runtimeId, SANDBOX_TOOL_RPC, { run_id: lease.runId, token, call: body.call }, body.call.tool === "node_exec" ? 135_000 : 65_000);
      confirmed = result.transport === "NOT_DISPATCHED" || result.ok;
      if (!result.ok) throw new SandboxToolError(confirmed ? "SERVICE_UNAVAILABLE" : "EXECUTION_UNKNOWN", confirmed ? "NOT_DISPATCHED" : "UNKNOWN");
      if (record(result.payload) && (result.payload.execution === "UNKNOWN" || result.payload.cleanup === "pending")) confirmed = false;
      if (!result?.ok || lease.expires <= Date.now() || leases.get(hash) !== lease || Buffer.byteLength(JSON.stringify(result.payload) ?? "") > SANDBOX_HTTP_LIMIT) throw denied();
      send(200, result.payload);
    } catch (error) {
      if (callId) {
        const failure = error instanceof SandboxToolError ? error : new SandboxToolError(
          confirmed ? "UNAUTHORIZED" : "EXECUTION_UNKNOWN", confirmed ? "NOT_DISPATCHED" : "UNKNOWN");
        send(200, { id: callId, ...failure.wire() });
      } else send(403, { error: "Sandbox tool denied or unavailable" });
    }
    finally { if (confirmed) lease.busy--; }
  });
}

async function boundedBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const timer = setTimeout(() => req.destroy(), 5000);
  const abort = () => req.destroy();
  res.once("close", abort);
  try {
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) {
      if ((bytes += chunk.length) > SANDBOX_HTTP_LIMIT) throw new Error("Body too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { clearTimeout(timer); res.off("close", abort); }
}
