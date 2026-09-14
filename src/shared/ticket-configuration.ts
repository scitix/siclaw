/** Configuration failures are actionable refusals, not legacy tool defaults. */
export class TicketCapabilitiesError extends Error {
  readonly code = "TICKET_CAPABILITIES_REQUIRED";
  readonly status = 409;
  readonly retriable = false;

  constructor() {
    super("Ticket Agent requires explicit tool capabilities from its host");
    this.name = "TicketCapabilitiesError";
  }

  toJSON() {
    return { code: this.code, message: this.message, status: this.status, retriable: this.retriable };
  }
}

export function ticketHostRequiredDetail() {
  return {
    code: "TICKET_HOST_REQUIRED",
    message: "Configure this Ticket Agent in the integrated host tenant UI",
    status: 409,
    retriable: false,
  };
}
