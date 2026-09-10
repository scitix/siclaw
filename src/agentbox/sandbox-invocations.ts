import { randomBytes } from "node:crypto";
import type { ScriptRequest, ScriptToolCall } from "../script-sandbox/types.js";
import { resolveSandboxBuiltin } from "../script-sandbox/tool-dispatch.js";

/** Per-box, ephemeral callback grants. Never sent to the runner or persisted. */
export class SandboxInvocations {
  private readonly active = new Map<string, { sessionId: string; scope: ScriptRequest; controller: AbortController; busy: boolean; calls: number }>();

  open(sessionId: string, scope: ScriptRequest, signal?: AbortSignal) {
    const token = randomBytes(32).toString("hex");
    const controller = new AbortController();
    const abort = () => controller.abort();
    const entry = { sessionId, scope: structuredClone(scope), controller, busy: false, calls: 0 };
    this.active.set(token, entry);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    // Bound lifetime even if the outer HTTP transport never settles.
    const timer = setTimeout(abort, 720_000);
    timer.unref();
    return { token, close: () => {
      controller.abort(); clearTimeout(timer); signal?.removeEventListener("abort", abort); this.active.delete(token);
    } };
  }

  async execute<T>(token: string, sessionId: string, call: ScriptToolCall, signal: AbortSignal,
    executor: (request: ReturnType<typeof resolveSandboxBuiltin>, signal: AbortSignal) => Promise<T>): Promise<T> {
    const entry = this.active.get(token);
    if (!entry || entry.sessionId !== sessionId || entry.controller.signal.aborted || entry.busy || ++entry.calls > 64) {
      throw new Error("Sandbox callback denied");
    }
    const request = resolveSandboxBuiltin(call, entry.scope);
    entry.busy = true;
    try {
      const bounded = AbortSignal.any([signal, entry.controller.signal, AbortSignal.timeout(90_000)]);
      bounded.throwIfAborted();
      return await executor(request, bounded);
    } finally { entry.busy = false; }
  }
}
