import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedToolDefinition } from "./tool-registry.js";

export const TOOL_RESULT_ARTIFACT_DETAIL_KEY = "toolResultArtifact";
export const TOOL_RESULT_ARTIFACT_FAILURE_DETAIL_KEY = "toolResultArtifactFailure";

const ARTIFACT_ID_PATTERN = /^tra_[0-9a-f]{32}$/;
const DEFAULT_CAPTURE_MIN_BYTES = 32 * 1024;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_SCOPE_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_SCOPE_ARTIFACTS = 256;
const DEFAULT_READ_CHARS = 16_000;
const MAX_READ_CHARS = 32_000;
const DEFAULT_SEARCH_CONTEXT_CHARS = 240;
const MAX_SEARCH_CONTEXT_CHARS = 2_000;
const DEFAULT_SEARCH_MATCHES = 20;
const MAX_SEARCH_MATCHES = 50;

export function toolResultArtifactRoot(sessionDir: string): string {
  return path.join(path.resolve(sessionDir), ".tool-results");
}

export interface ToolResultArtifactScope {
  agentId: string;
  sessionId: string;
}

export interface ToolResultArtifactReference {
  version: 1;
  id: string;
  sizeChars: number;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
}

export interface ToolResultArtifactFailure {
  version: 1;
  reason: "scope_unavailable" | "too_large" | "write_failed";
  sizeChars: number;
  sizeBytes: number;
}

interface ToolResultArtifactMetadata extends ToolResultArtifactReference {
  scopeHash: string;
  toolCallId: string;
  toolName: string;
}

export type ToolResultArtifactCapture =
  | { reference: ToolResultArtifactReference }
  | { failure: ToolResultArtifactFailure };

export interface ToolResultArtifactStoreOptions {
  rootDir: string;
  getScope: () => ToolResultArtifactScope | null;
  ttlMs?: number;
  maxArtifactBytes?: number;
  maxScopeBytes?: number;
  maxScopeArtifacts?: number;
  now?: () => number;
}

export interface ToolResultArtifactReadResult {
  reference: ToolResultArtifactReference;
  text: string;
  offset: number;
  nextOffset: number | null;
  complete: boolean;
}

export interface ToolResultArtifactSearchMatch {
  offset: number;
  snippet: string;
}

export interface ToolResultArtifactSearchResult {
  reference: ToolResultArtifactReference;
  query: string;
  matches: ToolResultArtifactSearchMatch[];
  truncated: boolean;
}

function safeInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function artifactTextPath(scopeDir: string, id: string): string {
  return path.join(scopeDir, `${id}.txt`);
}

function artifactMetadataPath(scopeDir: string, id: string): string {
  return path.join(scopeDir, `${id}.json`);
}

function publicReference(metadata: ToolResultArtifactMetadata): ToolResultArtifactReference {
  const { version, id, sizeChars, sizeBytes, sha256, createdAt, expiresAt } = metadata;
  return { version, id, sizeChars, sizeBytes, sha256, createdAt, expiresAt };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { error: message },
  };
}

function formatSearchToolOutput(search: ToolResultArtifactSearchResult): string {
  const payload = {
    artifact_id: search.reference.id,
    query: search.query,
    matches: search.matches.map((match) => ({ ...match })),
    truncated: search.truncated,
    size_chars: search.reference.sizeChars,
    sha256: search.reference.sha256,
  };
  let rendered = JSON.stringify(payload, null, 2);
  while (rendered.length > MAX_READ_CHARS && payload.matches.length > 0) {
    payload.truncated = true;
    if (payload.matches.length > 1) {
      payload.matches.pop();
    } else {
      const match = payload.matches[0];
      const overflow = rendered.length - MAX_READ_CHARS;
      match.snippet = match.snippet.slice(0, Math.max(0, match.snippet.length - overflow));
    }
    rendered = JSON.stringify(payload, null, 2);
  }
  return rendered;
}

export function getToolResultArtifactReference(value: unknown): ToolResultArtifactReference | null {
  if (!value || typeof value !== "object") return null;
  const details = value as Record<string, unknown>;
  const candidate = details[TOOL_RESULT_ARTIFACT_DETAIL_KEY];
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Record<string, unknown>;
  if (row.version !== 1 || typeof row.id !== "string" || !ARTIFACT_ID_PATTERN.test(row.id)) return null;
  if (typeof row.sizeChars !== "number" || typeof row.sizeBytes !== "number" || typeof row.sha256 !== "string") return null;
  if (typeof row.createdAt !== "string" || typeof row.expiresAt !== "string") return null;
  return row as unknown as ToolResultArtifactReference;
}

export function getToolResultArtifactFailure(value: unknown): ToolResultArtifactFailure | null {
  if (!value || typeof value !== "object") return null;
  const details = value as Record<string, unknown>;
  const candidate = details[TOOL_RESULT_ARTIFACT_FAILURE_DETAIL_KEY];
  if (!candidate || typeof candidate !== "object") return null;
  const row = candidate as Record<string, unknown>;
  if (row.version !== 1 || !["scope_unavailable", "too_large", "write_failed"].includes(String(row.reason))) return null;
  if (typeof row.sizeChars !== "number" || typeof row.sizeBytes !== "number") return null;
  return row as unknown as ToolResultArtifactFailure;
}

export function getToolResultArtifactDetails(message: unknown): Record<string, unknown> | null {
  if (!message || typeof message !== "object") return null;
  const details = (message as { details?: unknown }).details;
  const reference = getToolResultArtifactReference(details);
  if (reference) return { [TOOL_RESULT_ARTIFACT_DETAIL_KEY]: reference };
  const failure = getToolResultArtifactFailure(details);
  if (failure) return { [TOOL_RESULT_ARTIFACT_FAILURE_DETAIL_KEY]: failure };
  return null;
}

export function formatToolResultArtifactReference(
  reference: ToolResultArtifactReference,
  preview: string,
  maxChars: number,
): string {
  const header = [
    "[Full tool output stored as a recoverable artifact]",
    `artifact_id: ${reference.id}`,
    `size_chars: ${reference.sizeChars}`,
    `size_bytes: ${reference.sizeBytes}`,
    `sha256: ${reference.sha256}`,
    `expires_at: ${reference.expiresAt}`,
    "Use tool_result_search to locate evidence, then tool_result_read with offset/limit to inspect it.",
  ].join("\n");
  const separator = "\n\nPreview:\n";
  const previewBudget = Math.max(0, maxChars - header.length - separator.length);
  if (previewBudget === 0) return header.slice(0, Math.max(0, maxChars));
  if (preview.length <= previewBudget) return header + separator + preview;

  const omission = "\n\n[... preview middle omitted ...]\n\n";
  const remaining = Math.max(0, previewBudget - omission.length);
  const headChars = Math.ceil(remaining * 0.7);
  const tailChars = remaining - headChars;
  return header + separator + preview.slice(0, headChars) + omission + preview.slice(-tailChars);
}

export function formatUnrecoverableToolResult(
  failure: ToolResultArtifactFailure,
  preview: string,
  maxChars: number,
): string {
  const notice = [
    "[Tool output exceeded the inline context, and the complete artifact is unavailable]",
    `reason: ${failure.reason}`,
    `size_chars: ${failure.sizeChars}`,
    `size_bytes: ${failure.sizeBytes}`,
    "The omitted portion cannot be recovered. Rerun the source tool with narrower filters or pagination.",
  ].join("\n");
  const budget = Math.max(0, maxChars - notice.length - 2);
  return `${notice}\n\n${preview.slice(0, budget)}`.slice(0, maxChars);
}

export class ToolResultArtifactStore {
  private readonly rootDir: string;
  private readonly getScope: () => ToolResultArtifactScope | null;
  private readonly ttlMs: number;
  private readonly maxArtifactBytes: number;
  private readonly maxScopeBytes: number;
  private readonly maxScopeArtifacts: number;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();
  private rootReady: Promise<void> | null = null;

  constructor(options: ToolResultArtifactStoreOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.getScope = options.getScope;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxArtifactBytes = options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    this.maxScopeBytes = options.maxScopeBytes ?? DEFAULT_MAX_SCOPE_BYTES;
    this.maxScopeArtifacts = options.maxScopeArtifacts ?? DEFAULT_MAX_SCOPE_ARTIFACTS;
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<void> {
    await this.ensureRoot();
  }

  async capture(input: { text: string; toolCallId: string; toolName: string }): Promise<ToolResultArtifactCapture> {
    const sizeBytes = Buffer.byteLength(input.text, "utf8");
    const failureBase = { version: 1 as const, sizeChars: input.text.length, sizeBytes };
    const scope = this.getScope();
    if (!scope?.agentId || !scope.sessionId) {
      return { failure: { ...failureBase, reason: "scope_unavailable" } };
    }
    if (sizeBytes > this.maxArtifactBytes || sizeBytes > this.maxScopeBytes) {
      return { failure: { ...failureBase, reason: "too_large" } };
    }

    const run = this.writeChain.then(async () => {
      await this.ensureRoot();
      const scopeHash = this.scopeHash(scope);
      const scopeDir = path.join(this.rootDir, scopeHash);
      await fs.mkdir(scopeDir, { recursive: true, mode: 0o700 });
      await fs.chmod(scopeDir, 0o700);
      await this.cleanAndReserve(scopeDir, sizeBytes);

      const id = `tra_${randomUUID().replaceAll("-", "")}`;
      const now = this.now();
      const metadata: ToolResultArtifactMetadata = {
        version: 1,
        id,
        scopeHash,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        sizeChars: input.text.length,
        sizeBytes,
        sha256: createHash("sha256").update(input.text, "utf8").digest("hex"),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + this.ttlMs).toISOString(),
      };
      await this.writeAtomically(artifactTextPath(scopeDir, id), input.text);
      try {
        await this.writeAtomically(artifactMetadataPath(scopeDir, id), JSON.stringify(metadata));
      } catch (error) {
        await fs.rm(artifactTextPath(scopeDir, id), { force: true });
        throw error;
      }
      return publicReference(metadata);
    });
    this.writeChain = run.then(() => undefined, () => undefined);
    try {
      return { reference: await run };
    } catch {
      return { failure: { ...failureBase, reason: "write_failed" } };
    }
  }

  async read(id: string, offset = 0, limit = DEFAULT_READ_CHARS): Promise<ToolResultArtifactReadResult> {
    const { metadata, text } = await this.load(id);
    const safeOffset = safeInteger(offset, 0, 0, text.length);
    const safeLimit = safeInteger(limit, DEFAULT_READ_CHARS, 1, MAX_READ_CHARS);
    const nextOffsetValue = Math.min(text.length, safeOffset + safeLimit);
    return {
      reference: publicReference(metadata),
      text: text.slice(safeOffset, nextOffsetValue),
      offset: safeOffset,
      nextOffset: nextOffsetValue < text.length ? nextOffsetValue : null,
      complete: nextOffsetValue >= text.length,
    };
  }

  async search(
    id: string,
    query: string,
    contextChars = DEFAULT_SEARCH_CONTEXT_CHARS,
    maxMatches = DEFAULT_SEARCH_MATCHES,
  ): Promise<ToolResultArtifactSearchResult> {
    const needle = query.trim();
    if (!needle) throw new Error("query must not be empty");
    if (needle.length > 512) throw new Error("query must be at most 512 characters");
    const { metadata, text } = await this.load(id);
    const safeContext = safeInteger(contextChars, DEFAULT_SEARCH_CONTEXT_CHARS, 0, MAX_SEARCH_CONTEXT_CHARS);
    const safeMaxMatches = safeInteger(maxMatches, DEFAULT_SEARCH_MATCHES, 1, MAX_SEARCH_MATCHES);
    const haystack = text.toLocaleLowerCase();
    const normalizedNeedle = needle.toLocaleLowerCase();
    const matches: ToolResultArtifactSearchMatch[] = [];
    let cursor = 0;
    let foundMore = false;
    while (cursor <= haystack.length) {
      const found = haystack.indexOf(normalizedNeedle, cursor);
      if (found < 0) break;
      if (matches.length >= safeMaxMatches) {
        foundMore = true;
        break;
      }
      const start = Math.max(0, found - safeContext);
      const end = Math.min(text.length, found + needle.length + safeContext);
      matches.push({ offset: found, snippet: text.slice(start, end) });
      cursor = found + Math.max(1, normalizedNeedle.length);
    }
    return {
      reference: publicReference(metadata),
      query: needle,
      matches,
      truncated: foundMore,
    };
  }

  private scopeHash(scope: ToolResultArtifactScope): string {
    return createHash("sha256").update(`${scope.agentId}\0${scope.sessionId}`, "utf8").digest("hex");
  }

  private ensureRoot(): Promise<void> {
    this.rootReady ??= (async () => {
      await fs.mkdir(this.rootDir, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(this.rootDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("tool result artifact root must be a real directory");
      }
      await fs.chmod(this.rootDir, 0o700);
    })();
    return this.rootReady;
  }

  private currentScopeDir(): string {
    const scope = this.getScope();
    if (!scope?.agentId || !scope.sessionId) throw new Error("tool result artifact scope is unavailable");
    return path.join(this.rootDir, this.scopeHash(scope));
  }

  private async load(id: string): Promise<{ metadata: ToolResultArtifactMetadata; text: string }> {
    if (!ARTIFACT_ID_PATTERN.test(id)) throw new Error("invalid tool result artifact id");
    const scopeDir = this.currentScopeDir();
    let metadata: ToolResultArtifactMetadata;
    try {
      metadata = JSON.parse(await fs.readFile(artifactMetadataPath(scopeDir, id), "utf8")) as ToolResultArtifactMetadata;
    } catch {
      throw new Error("tool result artifact not found in this session");
    }
    if (metadata.id !== id || metadata.scopeHash !== path.basename(scopeDir)) {
      throw new Error("tool result artifact not found in this session");
    }
    if (Date.parse(metadata.expiresAt) <= this.now()) {
      await this.removeArtifact(scopeDir, id);
      throw new Error("tool result artifact has expired");
    }
    let text: string;
    try {
      text = await fs.readFile(artifactTextPath(scopeDir, id), "utf8");
    } catch {
      throw new Error("tool result artifact content is unavailable");
    }
    const digest = createHash("sha256").update(text, "utf8").digest("hex");
    if (Buffer.byteLength(text, "utf8") !== metadata.sizeBytes || digest !== metadata.sha256) {
      throw new Error("tool result artifact failed integrity verification");
    }
    return { metadata, text };
  }

  private async cleanAndReserve(scopeDir: string, incomingBytes: number): Promise<void> {
    const entries = await fs.readdir(scopeDir, { withFileTypes: true });
    const now = this.now();
    const live: ToolResultArtifactMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(scopeDir, entry.name), "utf8")) as ToolResultArtifactMetadata;
        if (!ARTIFACT_ID_PATTERN.test(metadata.id) || Date.parse(metadata.expiresAt) <= now) {
          await this.removeArtifact(scopeDir, metadata.id);
          continue;
        }
        live.push(metadata);
      } catch {
        await fs.rm(path.join(scopeDir, entry.name), { force: true });
        const id = entry.name.slice(0, -".json".length);
        if (ARTIFACT_ID_PATTERN.test(id)) {
          await fs.rm(artifactTextPath(scopeDir, id), { force: true });
        }
      }
    }
    live.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    let usedBytes = live.reduce((sum, metadata) => sum + metadata.sizeBytes, 0);
    let liveCount = live.length;
    for (const metadata of live) {
      if (
        usedBytes + incomingBytes <= this.maxScopeBytes
        && liveCount + 1 <= this.maxScopeArtifacts
      ) break;
      await this.removeArtifact(scopeDir, metadata.id);
      usedBytes -= metadata.sizeBytes;
      liveCount -= 1;
    }
    if (usedBytes + incomingBytes > this.maxScopeBytes || liveCount + 1 > this.maxScopeArtifacts) {
      throw new Error("tool result artifact scope quota exceeded");
    }
  }

  private async removeArtifact(scopeDir: string, id: string): Promise<void> {
    if (!ARTIFACT_ID_PATTERN.test(id)) return;
    await Promise.all([
      fs.rm(artifactTextPath(scopeDir, id), { force: true }),
      fs.rm(artifactMetadataPath(scopeDir, id), { force: true }),
    ]);
  }

  private async writeAtomically(target: string, content: string): Promise<void> {
    const temp = `${target}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
}

function toolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block): string[] => {
    if (!block || typeof block !== "object") return [];
    const typed = block as { type?: unknown; text?: unknown };
    return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
  }).join("\n");
}

export function withToolResultArtifactCapture(
  tool: ToolDefinition,
  store: ToolResultArtifactStore,
): ToolDefinition {
  const originalExecute = tool.execute.bind(tool) as ToolDefinition["execute"];
  return {
    ...tool,
    execute: async (...executeArgs: Parameters<ToolDefinition["execute"]>) => {
      const [toolCallId] = executeArgs;
      const result = await originalExecute(...executeArgs);
      const text = toolResultText(result);
      if (!text || Buffer.byteLength(text, "utf8") < DEFAULT_CAPTURE_MIN_BYTES) return result;
      const capture = await store.capture({ text, toolCallId, toolName: tool.name });
      const resultRecord = result as unknown as Record<string, unknown>;
      const details = resultRecord.details && typeof resultRecord.details === "object"
        ? resultRecord.details as Record<string, unknown>
        : {};
      return {
        ...resultRecord,
        details: "reference" in capture
          ? { ...details, [TOOL_RESULT_ARTIFACT_DETAIL_KEY]: capture.reference }
          : { ...details, [TOOL_RESULT_ARTIFACT_FAILURE_DETAIL_KEY]: capture.failure },
      } as Awaited<ReturnType<typeof originalExecute>>;
    },
  };
}

export function createToolResultArtifactTools(store: ToolResultArtifactStore): ResolvedToolDefinition[] {
  const readTool: ResolvedToolDefinition = {
    name: "tool_result_read",
    label: "Read tool result artifact",
    description: "Read a bounded character range from a complete tool-result artifact. Use the artifact_id returned by an earlier tool result. Continue with next_offset until complete.",
    toolset: "artifact",
    parameters: Type.Object({
      artifact_id: Type.String({ description: "Opaque tool-result artifact ID." }),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset; defaults to 0." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_CHARS, description: `Characters to return; defaults to ${DEFAULT_READ_CHARS}.` })),
    }),
    execute: async (_toolCallId, args: any) => {
      try {
        const read = await store.read(args.artifact_id, args.offset, args.limit);
        const header = JSON.stringify({
          artifact_id: read.reference.id,
          offset: read.offset,
          next_offset: read.nextOffset,
          complete: read.complete,
          size_chars: read.reference.sizeChars,
          sha256: read.reference.sha256,
        });
        return {
          content: [{ type: "text" as const, text: `${header}\n${read.text}` }],
          details: { [TOOL_RESULT_ARTIFACT_DETAIL_KEY]: read.reference },
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  const searchTool: ResolvedToolDefinition = {
    name: "tool_result_search",
    label: "Search tool result artifact",
    description: "Search a complete tool-result artifact using a case-insensitive literal query. Returns bounded snippets and character offsets for follow-up tool_result_read calls.",
    toolset: "artifact",
    parameters: Type.Object({
      artifact_id: Type.String({ description: "Opaque tool-result artifact ID." }),
      query: Type.String({ minLength: 1, maxLength: 512, description: "Literal text to find (case-insensitive)." }),
      context_chars: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_SEARCH_CONTEXT_CHARS, description: `Characters included on each side; defaults to ${DEFAULT_SEARCH_CONTEXT_CHARS}.` })),
      max_matches: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_MATCHES, description: `Maximum matches; defaults to ${DEFAULT_SEARCH_MATCHES}.` })),
    }),
    execute: async (_toolCallId, args: any) => {
      try {
        const search = await store.search(args.artifact_id, args.query, args.context_chars, args.max_matches);
        return {
          content: [{ type: "text" as const, text: formatSearchToolOutput(search) }],
          details: { [TOOL_RESULT_ARTIFACT_DETAIL_KEY]: search.reference },
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  return [readTool, searchTool];
}
