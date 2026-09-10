import type { CredentialPayload } from "./credential-types.js";
import type { SandboxExecTool } from "../tools/infra/sandbox-tool-policy.js";

/** Trusted Runtime-to-AgentBox data. Never serialized into a runner request. */
export interface SandboxBuiltinApproval {
  tool: "bash" | SandboxExecTool;
  credential: CredentialPayload["credential"];
  /** Target followed by its server-resolved bastion chain, by endpoint. */
  hostKeyPins?: Record<string, string>;
}
