/** Shared by the Runtime, Portal and standalone AgentBox image. */
export const AGENT_RETIRED_CODE = "AGENT_RETIRED";
export const AGENT_RETIRED_STATUS = 410;

export function agentRetiredDetail() {
  return {
    code: AGENT_RETIRED_CODE,
    message: "Coordinator and peer delegation have been retired; create a supported Agent and use conversation handoff",
    status: AGENT_RETIRED_STATUS,
    retriable: false,
  };
}

/** Structural error fields survive the Runtime's wrapRpcError boundary. */
export class AgentRetiredError extends Error {
  readonly code = AGENT_RETIRED_CODE;
  readonly status = AGENT_RETIRED_STATUS;
  readonly retriable = false;

  toJSON() {
    return agentRetiredDetail();
  }

  constructor() {
    super(agentRetiredDetail().message);
    this.name = "AgentRetiredError";
  }
}
