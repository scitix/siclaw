import { randomUUID } from "node:crypto";
import type { SessionEventEmitter } from "./tool-registry.js";

export interface StructuredResultContract {
  id: string;
  description: string;
  required?: boolean;
  schema: Record<string, unknown>;
}

export interface StructuredResultSubmitResult {
  ok: boolean;
  message: string;
  resultId?: string;
}

const CONTRACT_ID_RE = /^[a-z][a-z0-9_.-]{0,127}$/;
const MAX_CONTRACT_BYTES = 64 * 1024;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsRef(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRef);
  if (!isObject(value)) return false;
  if (Object.prototype.hasOwnProperty.call(value, "$ref")) return true;
  return Object.values(value).some(containsRef);
}

const SUPPORTED_SCHEMA_KEYS = new Set([
  "$schema", "type", "title", "description", "default", "examples",
  "properties", "required", "additionalProperties",
  "enum", "const", "items", "minItems", "maxItems",
  "minLength", "maxLength", "pattern", "minimum", "maximum",
  "allOf", "anyOf", "oneOf",
]);

const SUPPORTED_TYPES = new Set([
  "object", "array", "string", "boolean", "number", "integer", "null",
]);

function assertFiniteNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
}

function assertNonNegativeInteger(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
}

function assertSupportedSchema(schema: unknown, path = "schema"): void {
  if (!isObject(schema)) throw new Error(`${path} must be an object`);
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      throw new Error(`${path} uses unsupported JSON Schema keyword ${key}`);
    }
  }
  if (schema.type !== undefined && (typeof schema.type !== "string" || !SUPPORTED_TYPES.has(schema.type))) {
    throw new Error(`${path}.type is not supported`);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string")) {
      throw new Error(`${path}.required must be an array of strings`);
    }
    if (new Set(schema.required).size !== schema.required.length) {
      throw new Error(`${path}.required must not contain duplicates`);
    }
  }
  if (schema.additionalProperties !== undefined
    && typeof schema.additionalProperties !== "boolean"
    && !isObject(schema.additionalProperties)) {
    throw new Error(`${path}.additionalProperties must be a boolean or schema object`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(`${path}.enum must be a non-empty array`);
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") throw new Error(`${path}.pattern must be a string`);
    try { new RegExp(schema.pattern, "u"); } catch { throw new Error(`${path}.pattern must be a valid regular expression`); }
  }
  for (const key of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
    if (schema[key] !== undefined) assertNonNegativeInteger(schema[key], `${path}.${key}`);
  }
  for (const key of ["minimum", "maximum"] as const) {
    if (schema[key] !== undefined) assertFiniteNumber(schema[key], `${path}.${key}`);
  }
  if (schema.properties !== undefined) {
    if (!isObject(schema.properties)) throw new Error(`${path}.properties must be an object`);
    for (const [key, child] of Object.entries(schema.properties)) {
      assertSupportedSchema(child, `${path}.properties.${key}`);
    }
  }
  if (schema.items !== undefined) {
    if (!isObject(schema.items)) throw new Error(`${path}.items must be a schema object`);
    assertSupportedSchema(schema.items, `${path}.items`);
  }
  if (isObject(schema.additionalProperties)) {
    assertSupportedSchema(schema.additionalProperties, `${path}.additionalProperties`);
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key]) || schema[key].length === 0) {
      throw new Error(`${path}.${key} must be a non-empty array`);
    }
    schema[key].forEach((child, index) => assertSupportedSchema(child, `${path}.${key}[${index}]`));
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function valueTypeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case "object": return isObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "null": return value === null;
    default: return false;
  }
}

function validateValue(schema: Record<string, unknown>, value: unknown, path: string): string[] {
  const errors: string[] = [];
  if (schema.type !== undefined && !valueTypeMatches(schema.type, value)) {
    return [`${path}: expected ${String(schema.type)}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    errors.push(`${path}: value is not in enum`);
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !jsonEqual(schema.const, value)) {
    errors.push(`${path}: value does not match const`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${path}: shorter than minLength`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${path}: longer than maxLength`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: does not match pattern`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${path}: fewer than minItems`);
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${path}: more than maxItems`);
    if (isObject(schema.items)) {
      value.forEach((item, index) => errors.push(...validateValue(schema.items as Record<string, unknown>, item, `${path}/${index}`)));
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push(`${path}/${key}: required property is missing`);
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && isObject(child)) {
        errors.push(...validateValue(child, value[key], `${path}/${key}`));
      }
    }
    for (const [key, childValue] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      if (schema.additionalProperties === false) errors.push(`${path}/${key}: additional property is not allowed`);
      else if (isObject(schema.additionalProperties)) {
        errors.push(...validateValue(schema.additionalProperties, childValue, `${path}/${key}`));
      }
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (!Array.isArray(branches)) continue;
    const matches = branches.filter((branch) => isObject(branch) && validateValue(branch, value, path).length === 0).length;
    if (key === "allOf" && matches !== branches.length) errors.push(`${path}: does not match allOf`);
    if (key === "anyOf" && matches === 0) errors.push(`${path}: does not match anyOf`);
    if (key === "oneOf" && matches !== 1) errors.push(`${path}: does not match exactly one oneOf branch`);
  }
  return errors;
}

/** Validate the management-plane contract before it becomes an LLM tool schema. */
export function normalizeStructuredResultContract(value: unknown): StructuredResultContract | null {
  if (value == null) return null;
  if (!isObject(value)) throw new Error("result_contract must be an object or null");

  const id = typeof value.id === "string" ? value.id.trim() : "";
  if (!CONTRACT_ID_RE.test(id)) {
    throw new Error("result_contract.id must match [a-z][a-z0-9_.-]{0,127}");
  }
  const description = typeof value.description === "string" ? value.description.trim() : "";
  if (!description || description.length > 4000) {
    throw new Error("result_contract.description must contain 1..4000 characters");
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    throw new Error("result_contract.required must be a boolean");
  }
  if (!isObject(value.schema) || value.schema.type !== "object") {
    throw new Error("result_contract.schema must be a JSON Schema object with type=object");
  }
  if (containsRef(value.schema)) {
    throw new Error("result_contract.schema must be self-contained; $ref is not supported");
  }
  assertSupportedSchema(value.schema);
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CONTRACT_BYTES) {
    throw new Error(`result_contract exceeds ${MAX_CONTRACT_BYTES} bytes`);
  }
  return { id, description, required: value.required === true, schema: value.schema };
}

/**
 * Owns the per-turn linearization point for structured output. Tool calls and
 * prompt completion both pass through this object, so a routing retry cannot
 * submit twice and a required-but-missing result is observable on the same SSE.
 */
export class StructuredResultController {
  readonly contract: StructuredResultContract;
  private readonly turnRef: { current: number };
  private readonly emit: SessionEventEmitter;
  private activeTurn: number | null = null;
  private submittedTurn: number | null = null;

  constructor(contract: StructuredResultContract, turnRef: { current: number }, emit: SessionEventEmitter) {
    this.contract = contract;
    this.turnRef = turnRef;
    this.emit = emit;
  }

  beginTurn(): void {
    this.activeTurn = this.turnRef.current;
  }

  submit(data: unknown): StructuredResultSubmitResult {
    const turn = this.turnRef.current;
    if (this.activeTurn !== turn) {
      return { ok: false, message: "No active turn is accepting a structured result." };
    }
    if (this.submittedTurn === turn) {
      return { ok: false, message: "A structured result was already submitted for this turn." };
    }
    const errors = validateValue(this.contract.schema, data, "");
    if (errors.length > 0) {
      const detail = errors.slice(0, 3).join("; ");
      return { ok: false, message: `Structured result does not match ${this.contract.id}: ${detail}` };
    }

    const resultId = randomUUID();
    this.submittedTurn = turn;
    this.emit({
      type: "structured_result",
      contract_id: this.contract.id,
      result_id: resultId,
      turn,
      data,
    });
    return { ok: true, message: "Structured result submitted.", resultId };
  }

  finishTurn(): void {
    const turn = this.turnRef.current;
    if (this.activeTurn !== turn) return;
    if (this.contract.required && this.submittedTurn !== turn) {
      this.emit({
        type: "structured_result_missing",
        contract_id: this.contract.id,
        turn,
      });
    }
    this.activeTurn = null;
  }
}
