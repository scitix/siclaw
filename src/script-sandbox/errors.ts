/** Safe cross-process outcomes. Never serialize an underlying transport error. */
const messages = {
  UNAUTHORIZED: "Tool request denied",
  INVALID_ARGUMENTS: "Invalid tool arguments",
  TARGET_BUSY: "Target service busy; retry later without changing the script",
  TARGET_ERROR: "Tool completed with an error; inspect the result before continuing",
  RESULT_TOO_LARGE: "Result exceeds delivery budget; use file delivery or pagination",
  CLEANUP_PENDING: "Tool finished but cleanup is unconfirmed; do not repeat the operation",
  EXECUTION_UNKNOWN: "Tool execution is unconfirmed; do not automatically retry",
  UNSUPPORTED_PROTOCOL: "Sandbox coordinator protocol is unsupported; update the deployment",
  OWNER_LOST: "Sandbox callback owner is unavailable; start a new run only after resolving the previous outcome",
  DIAGNOSTICS_UNAVAILABLE: "Node diagnostic namespace or quota is unavailable; ask the operator to provision the target cluster",
  SERVICE_UNAVAILABLE: "Sandbox service is unavailable",
  RUNNER_PROTOCOL: "Runner handshake failed; deploy the matching sandbox image",
  IMAGE_UNAVAILABLE: "Runner image is unavailable; check the deployment image and pull credentials",
  RUNNER_CAPACITY: "Runner cannot be scheduled; check namespace quota and node capacity",
} as const;

export type ToolExecution = "NOT_DISPATCHED" | "FINISHED" | "UNKNOWN";
export type ToolCleanup = "not_required" | "confirmed" | "pending";
export class SandboxToolError extends Error {
  constructor(readonly code: keyof typeof messages, readonly execution: ToolExecution = "NOT_DISPATCHED",
    readonly cleanup: ToolCleanup = "not_required", readonly result?: unknown) { super(messages[code]); }
  get retainsCapacity(): boolean { return this.execution === "UNKNOWN" || this.cleanup === "pending"; }
  wire() { return { error: this.message, code: this.code, execution: this.execution, cleanup: this.cleanup,
    ...(this.result === undefined ? {} : { result: this.result }), ...(this.code === "TARGET_BUSY" ? { retry_after_ms: 1000 } : {}) }; }
}

export function readSandboxToolError(value: unknown): SandboxToolError | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== "string" || !Object.hasOwn(messages, v.code) ||
    !["NOT_DISPATCHED", "FINISHED", "UNKNOWN"].includes(String(v.execution)) ||
    !["not_required", "confirmed", "pending"].includes(String(v.cleanup))) return;
  return new SandboxToolError(v.code as keyof typeof messages, v.execution as ToolExecution, v.cleanup as ToolCleanup, v.result);
}
