import type { AgentBoxManager } from "./manager.js";

export const MAX_AGENTBOX_RECOVERY_ATTEMPTS = 3;

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return errorCode(candidate.cause);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause ? ` ${errorMessage(error.cause)}` : "";
    return `${error.name} ${error.message}${cause}`.toLowerCase();
  }
  return String(error).toLowerCase();
}

/**
 * Classify transport failures only. Model/API failures and AgentBox HTTP
 * responses have their own retry semantics and must not rebuild a healthy pod.
 */
export function isRecoverableAgentBoxStreamError(error: unknown): boolean {
  const code = errorCode(error);
  if (code && ["ECONNRESET", "ECONNREFUSED", "EPIPE", "UND_ERR_SOCKET"].includes(code)) {
    return true;
  }
  const message = errorMessage(error);
  return [
    "socket hang up",
    "premature close",
    "other side closed",
    "fetch failed",
    "stream terminated",
    "response body was aborted",
  ].some((fragment) => message.includes(fragment));
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Fail closed: only rebuild after the lifecycle backend confirms that the box
 * is gone or terminal. Reattaching to a merely disconnected but still-running
 * SSE has no event cursor and could duplicate persisted events/tool output.
 */
export async function waitForConfirmedAgentBoxFailure(
  manager: Pick<AgentBoxManager, "inspect">,
  agentId: string,
  signal: AbortSignal,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  while (!signal.aborted) {
    const info = await manager.inspect(agentId);
    if (!info || info.status === "error" || info.status === "stopped") return true;
    if (Date.now() >= deadline) return false;
    await abortableDelay(Math.min(pollMs, Math.max(0, deadline - Date.now())), signal);
  }
  return false;
}
