import type { CredentialPayload } from "./credential-types.js";
import type { SandboxBuiltinTool } from "../script-sandbox/tool-dispatch.js";

export class SandboxCallbackUncertainError extends Error {
  constructor() { super("Sandbox callback interrupted or unavailable"); }
}

/** Trusted Runtime-to-AgentBox data. Never serialized into a runner request. */
export interface SandboxBuiltinApproval {
  /** Original run-scoped request id, supplied by Runtime for replay protection. */
  callId?: string;
  tool: SandboxBuiltinTool;
  credential: CredentialPayload["credential"];
  /** Target followed by its server-resolved bastion chain, by endpoint. */
  hostKeyPins?: Record<string, string>;
}
