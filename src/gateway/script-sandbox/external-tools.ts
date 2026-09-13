import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isSandboxEndpoint, SANDBOX_LEASE_CLOSE, SANDBOX_LEASE_OPEN } from "../../script-sandbox/external-protocol.js";
import { record } from "../../script-sandbox/validation.js";
import type { ScriptToolBinding } from "../../script-sandbox/types.js";
import type { SandboxControlPlane } from "./broker.js";

/** Second gate behind the public ingress. Restart/expiry/cancel always fails closed. */
export class ExternalScriptTools {
  private active = new Map<string, { hash: Buffer; binding: ScriptToolBinding; expires: number }>();
  constructor(private readonly controlPlane: SandboxControlPlane) {}

  async open(binding: ScriptToolBinding): Promise<{ endpoint: string; token: string; close(): Promise<void> }> {
    const runId = binding.principal.runId!;
    binding.signal.throwIfAborted();
    if (!runId || this.active.has(runId)) throw new Error("Invalid external run");
    const token = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(token).digest();
    const expires = Date.now() + Math.min(binding.timeoutSeconds + 10, 610) * 1000;
    this.active.set(runId, { hash, binding, expires });
    // Revocation at Runtime is synchronous; an unavailable ingress cannot extend it.
    let closing: Promise<void> | undefined;
    const close = () => {
      this.active.delete(runId);
      binding.signal.removeEventListener("abort", abort);
      return closing ??= Promise.resolve().then(() => this.controlPlane.request(SANDBOX_LEASE_CLOSE, { token_hash: hash.toString("hex"), run_id: runId }, 5000)).then(() => {}, () => {});
    };
    const abort = () => { void close(); };
    binding.signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.controlPlane.request(SANDBOX_LEASE_OPEN, {
        token_hash: hash.toString("hex"), run_id: runId, agent_id: binding.principal.agentId,
        session_id: binding.principal.sessionId, expires_at: expires,
      }, 5000);
      binding.signal.throwIfAborted();
      if (!record(response) || !isSandboxEndpoint(response.endpoint)) throw new Error("External sandbox ingress unavailable");
      return { endpoint: response.endpoint, token, close };
    } catch {
      // Also revoke an open that finished after an early abort/close raced it.
      this.active.delete(runId);
      await close();
      await this.controlPlane.request(SANDBOX_LEASE_CLOSE, { token_hash: hash.toString("hex"), run_id: runId }, 5000).catch(() => {});
      throw new Error("External sandbox ingress unavailable");
    }
  }

  async call(raw: unknown): Promise<unknown> {
    if (!record(raw) || Object.keys(raw).some(k => !["run_id", "token", "call"].includes(k)) ||
      typeof raw.run_id !== "string" || typeof raw.token !== "string" || !/^[a-f0-9]{64}$/.test(raw.token)) throw new Error("Inactive sandbox grant");
    const entry = this.active.get(raw.run_id);
    if (!entry || entry.binding.signal.aborted || Date.now() >= entry.expires ||
      !timingSafeEqual(entry.hash, createHash("sha256").update(raw.token).digest())) throw new Error("Inactive sandbox grant");
    return entry.binding.call(raw.call);
  }
}
