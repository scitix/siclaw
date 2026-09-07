export const TICKET_TYPES = [
  "consultation",
  "incident",
  "llm_incident",
  "requirement",
  "unknown",
] as const;

export type TicketType = (typeof TICKET_TYPES)[number];

/**
 * Deployment region the user is calling the LLM API from, as classified by the
 * operator's own rules. Empty when the conversation does not establish it.
 */
export const LLM_REGIONS = ["domestic", "overseas"] as const;
export type LlmRegion = (typeof LLM_REGIONS)[number];

/**
 * Which part of the LLM API path the user reports as failing. Empty when the
 * conversation does not establish it.
 */
export const LLM_ASPECTS = ["platform_api", "network", "model"] as const;
export type LlmAspect = (typeof LLM_ASPECTS)[number];

/**
 * Best-effort intake details for an `llm_incident`. Every field may stay empty:
 * the block exists so first-line support sees what the conversation did
 * establish, not so the agent is forced to guess. Only the enum shape is
 * validated; none of the fields is required for a ticket-ready result.
 */
export interface LlmIncidentInfo {
  region: "" | LlmRegion;
  aspect: "" | LlmAspect;
  model: string;
}

export interface ProductSupportInfo {
  ticket_type: TicketType;
  product: string;
  summary: string;
  description: string;
  evidence: string[];
  missing_fields: string[];
  llm: LlmIncidentInfo;
}

export interface ProductSupportResult {
  label: boolean;
  info: ProductSupportInfo;
}

const ROOT_KEYS = new Set(["label", "info"]);
const INFO_KEYS = new Set([
  "ticket_type",
  "product",
  "summary",
  "description",
  "evidence",
  "missing_fields",
  "llm",
]);
const LLM_KEYS = new Set(["region", "aspect", "model"]);
const TICKET_TYPE_SET = new Set<string>(TICKET_TYPES);
const LLM_REGION_SET = new Set<string>(LLM_REGIONS);
const LLM_ASPECT_SET = new Set<string>(LLM_ASPECTS);
const MISSING_FIELD_PATTERN = /^[a-z][a-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new Error(`${path}.${key} is not allowed`);
    }
  }
  for (const key of expected) {
    if (!(key in value)) {
      throw new Error(`${path}.${key} is required`);
    }
  }
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  return value.trim();
}

function readOptionalEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  options: readonly T[],
  path: string,
): "" | T {
  const text = readString(value, path).toLowerCase();
  if (text.length === 0) {
    return "";
  }
  if (!allowed.has(text)) {
    throw new Error(`${path} must be empty or one of: ${options.join(", ")}`);
  }
  return text as T;
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of strings`);
  }

  const canonical: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const text = readString(item, `${path}[${index}]`);
    if (text.length === 0) {
      throw new Error(`${path}[${index}] must not be blank`);
    }
    if (!seen.has(text)) {
      seen.add(text);
      canonical.push(text);
    }
  });
  return canonical;
}

function readLlmInfo(value: unknown, path: string): LlmIncidentInfo {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`);
  }
  assertExactKeys(value, LLM_KEYS, path);
  return {
    region: readOptionalEnum(value.region, LLM_REGION_SET, LLM_REGIONS, `${path}.region`),
    aspect: readOptionalEnum(value.aspect, LLM_ASPECT_SET, LLM_ASPECTS, `${path}.aspect`),
    model: readString(value.model, `${path}.model`),
  };
}

export function parseProductSupportResult(input: unknown): ProductSupportResult {
  if (!isRecord(input)) {
    throw new Error("input must be an object");
  }
  assertExactKeys(input, ROOT_KEYS, "input");

  if (typeof input.label !== "boolean") {
    throw new Error("input.label must be a boolean");
  }
  if (!isRecord(input.info)) {
    throw new Error("input.info must be an object");
  }
  assertExactKeys(input.info, INFO_KEYS, "input.info");

  const ticketType = readString(input.info.ticket_type, "input.info.ticket_type");
  if (!TICKET_TYPE_SET.has(ticketType)) {
    throw new Error(
      `input.info.ticket_type must be one of: ${TICKET_TYPES.join(", ")}`,
    );
  }

  const result: ProductSupportResult = {
    label: input.label,
    info: {
      ticket_type: ticketType as TicketType,
      product: readString(input.info.product, "input.info.product"),
      summary: readString(input.info.summary, "input.info.summary"),
      description: readString(input.info.description, "input.info.description"),
      evidence: readStringArray(input.info.evidence, "input.info.evidence"),
      missing_fields: readStringArray(
        input.info.missing_fields,
        "input.info.missing_fields",
      ),
      llm: readLlmInfo(input.info.llm, "input.info.llm"),
    },
  };

  result.info.missing_fields.forEach((field, index) => {
    if (!MISSING_FIELD_PATTERN.test(field)) {
      throw new Error(
        `input.info.missing_fields[${index}] must be a lowercase snake_case field identifier`,
      );
    }
  });

  // The llm block belongs to llm_incident only. A stray region or model on a
  // consultation would be read by first-line support as an established fact.
  if (result.info.ticket_type !== "llm_incident") {
    const { region, aspect, model } = result.info.llm;
    if (region !== "" || aspect !== "" || model !== "") {
      throw new Error(
        "input.info.llm fields must be empty unless ticket_type is llm_incident",
      );
    }
  }

  if (!result.label) {
    return result;
  }

  if (result.info.ticket_type === "unknown") {
    throw new Error("label=true requires a resolved ticket_type");
  }
  if (result.info.summary.length === 0) {
    throw new Error("label=true requires a non-empty info.summary");
  }
  if (result.info.description.length === 0) {
    throw new Error("label=true requires a non-empty info.description");
  }
  if (result.info.missing_fields.length > 0) {
    throw new Error("label=true requires info.missing_fields to be empty");
  }
  if (result.info.ticket_type === "requirement" && result.info.product.length === 0) {
    throw new Error("label=true with ticket_type=requirement requires info.product");
  }

  return result;
}
