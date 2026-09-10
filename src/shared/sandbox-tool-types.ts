import type { CredentialPayload } from "./credential-types.js";
import type { SandboxBuiltinTool } from "../script-sandbox/tool-dispatch.js";

/** Trusted Runtime-to-AgentBox data. Never serialized into a runner request. */
export interface SandboxBuiltinApproval {
  tool: SandboxBuiltinTool;
  credential: CredentialPayload["credential"];
  /** Target followed by its server-resolved bastion chain, by endpoint. */
  hostKeyPins?: Record<string, string>;
}
