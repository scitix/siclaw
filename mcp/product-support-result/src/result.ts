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
 * Size bounds, enforced here and advertised in the tool's JSON Schema.
 *
 * The validated result is persisted downstream as one row's metadata, whose
 * column is a MySQL TEXT (65,535 bytes). The bounds are chosen so that even a
 * result filled to every limit with 3-byte UTF-8 characters stays well under
 * that, and so that an oversized field is rejected here — where the model can
 * shorten it — instead of being forwarded and then dropped by the INSERT.
 */
export const LIMITS = {
  summaryMaxChars: 200,
  descriptionMaxChars: 2000,
  productMaxChars: 128,
  modelMaxChars: 128,
  evidenceMaxItems: 20,
  evidenceItemMaxChars: 300,
  missingFieldsMaxItems: 20,
  missingFieldMaxChars: 64,
} as const;

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
]);
// Optional: absent means "all three empty". All-empty is the correct value for
// four of the five ticket types, so requiring the block would only turn the
// most common shape into a host-side schema rejection on the turn's one
// mandatory tool call.
const INFO_OPTIONAL_KEYS = new Set(["llm"]);
const LLM_KEYS = new Set(["region", "aspect", "model"]);
const TICKET_TYPE_SET = new Set<string>(TICKET_TYPES);
const LLM_REGION_SET = new Set<string>(LLM_REGIONS);
const LLM_ASPECT_SET = new Set<string>(LLM_ASPECTS);
export const MISSING_FIELD_PATTERN = "^[a-z][a-z0-9_]*$";
const MISSING_FIELD_RE = new RegExp(MISSING_FIELD_PATTERN);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
  path: string,
  optional: ReadonlySet<string> = new Set(),
): void {
  for (const key of Object.keys(value)) {
    if (!expected.has(key) && !optional.has(key)) {
      throw new Error(`${path}.${key} is not allowed`);
    }
  }
  for (const key of expected) {
    if (!(key in value)) {
      throw new Error(`${path}.${key} is required`);
    }
  }
}

function readString(value: unknown, path: string, maxChars: number): string {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  // Length is checked on the raw value, exactly as the advertised `maxLength`
  // is applied by a host that validates arguments before dispatch, so this
  // parser is never more lenient than the schema the model was shown.
  if ([...value].length > maxChars) {
    throw new Error(`${path} must be at most ${maxChars} characters`);
  }
  return value.trim();
}

function readEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  options: readonly T[],
  path: string,
  optional: boolean,
): "" | T {
  // Exact match only. The advertised JSON Schema `enum` is validated by the
  // host before dispatch on the primary path, so any tolerance added here
  // would apply on one host path and not the other; the schema is the single
  // answer and the parser mirrors it.
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  const text = value;
  if (text.length === 0 && optional) {
    return "";
  }
  if (!allowed.has(text)) {
    const prefix = optional ? "must be empty or one of" : "must be one of";
    throw new Error(`${path} ${prefix}: ${options.join(", ")}`);
  }
  return text as T;
}

interface StringArrayRules {
  maxItems: number;
  itemMaxChars: number;
  /** Validated against each item at its ORIGINAL index, before dedup. */
  itemPattern?: { re: RegExp; message: string };
}

function readStringArray(value: unknown, path: string, rules: StringArrayRules): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array of strings`);
  }
  if (value.length > rules.maxItems) {
    throw new Error(`${path} must have at most ${rules.maxItems} items`);
  }

  const canonical: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const text = readString(item, itemPath, rules.itemMaxChars);
    if (text.length === 0) {
      throw new Error(`${itemPath} must not be blank`);
    }
    if (rules.itemPattern && !rules.itemPattern.re.test(text)) {
      throw new Error(`${itemPath} ${rules.itemPattern.message}`);
    }
    // Post-trim duplicates are dropped; this canonicalization is documented in
    // the README and the schema description because consumers that diff the
    // persisted tool_input against structuredContent will see it.
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
    region: readEnum(value.region, LLM_REGION_SET, LLM_REGIONS, `${path}.region`, true),
    aspect: readEnum(value.aspect, LLM_ASPECT_SET, LLM_ASPECTS, `${path}.aspect`, true),
    model: readString(value.model, `${path}.model`, LIMITS.modelMaxChars),
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
  assertExactKeys(input.info, INFO_KEYS, "input.info", INFO_OPTIONAL_KEYS);

  const ticketType = readEnum(
    input.info.ticket_type,
    TICKET_TYPE_SET,
    TICKET_TYPES,
    "input.info.ticket_type",
    false,
  ) as TicketType;

  const result: ProductSupportResult = {
    label: input.label,
    info: {
      ticket_type: ticketType,
      product: readString(input.info.product, "input.info.product", LIMITS.productMaxChars),
      summary: readString(input.info.summary, "input.info.summary", LIMITS.summaryMaxChars),
      description: readString(
        input.info.description,
        "input.info.description",
        LIMITS.descriptionMaxChars,
      ),
      evidence: readStringArray(input.info.evidence, "input.info.evidence", {
        maxItems: LIMITS.evidenceMaxItems,
        itemMaxChars: LIMITS.evidenceItemMaxChars,
      }),
      missing_fields: readStringArray(input.info.missing_fields, "input.info.missing_fields", {
        maxItems: LIMITS.missingFieldsMaxItems,
        itemMaxChars: LIMITS.missingFieldMaxChars,
        itemPattern: {
          re: MISSING_FIELD_RE,
          message: "must be a lowercase snake_case field identifier",
        },
      }),
      llm:
        input.info.llm === undefined
          ? { region: "", aspect: "", model: "" }
          : readLlmInfo(input.info.llm, "input.info.llm"),
    },
  };

  // Unknown intake may temporarily retain user-stated LLM details. A final
  // unknown handoff keeps those clues in description/evidence instead: typed
  // LLM fields must not imply that an LLM incident has been established.
  const gatheringUnknown = !result.label && result.info.ticket_type === "unknown";
  if (result.info.ticket_type !== "llm_incident" && !gatheringUnknown) {
    const { region, aspect, model } = result.info.llm;
    if (region !== "" || aspect !== "" || model !== "") {
      throw new Error(
        "input.info.llm fields must be empty unless ticket_type is llm_incident or label=false with ticket_type=unknown; preserve unclassified clues in description and evidence",
      );
    }
  }

  if (!result.label) {
    return result;
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
