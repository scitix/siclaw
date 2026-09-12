import type { CredentialPayload } from "./credential-types.js";
import type { SandboxBuiltinTool } from "../script-sandbox/tool-dispatch.js";
import { SandboxToolError } from "../script-sandbox/errors.js";

export class SandboxCallbackUncertainError extends SandboxToolError {
  constructor() { super("EXECUTION_UNKNOWN", "UNKNOWN"); }
}

/** Trusted Runtime-to-AgentBox data. Never serialized into a runner request. */
export interface SandboxBuiltinApproval {
  /** Original run-scoped request id, supplied by Runtime for replay protection. */
  callId?: string;
  /** Runtime deadline from before admission; never supplied by script code. */
  deadlineMs?: number;
  tool: SandboxBuiltinTool;
  credential: CredentialPayload["credential"];
  /** Target followed by its server-resolved bastion chain, by endpoint. */
  hostKeyPins?: Record<string, string>;
}
