import { createInterface } from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Type,
  type ImageContent,
  type ToolCall,
  type TSchema,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

type Access = "read" | "write" | "deny";

interface EngineToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface InitCommand {
  type: "init";
  cwd: string;
  sessionId: string;
  systemPrompt: string;
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey: string;
  thinkingLevel: ThinkingLevel;
  maxToolCalls: number;
  readOnly: boolean;
  allowedReadRoots: string[];
  filesystemAccess: Record<string, Access>;
  fileTools: string[];
  tools: EngineToolSpec[];
}

type Command =
  | InitCommand
  | { type: "query"; text: string }
  | { type: "tool_result"; id: string; result?: string; error?: string }
  | { type: "interrupt" }
  | { type: "close" };

interface PendingToolCall {
  resolve(value: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface AccessRule {
  root: string;
  access: Access;
}

const pendingToolCalls = new Map<string, PendingToolCall>();
let session: AgentSession | undefined;
let initConfig: InitCommand | undefined;
let queryChain = Promise.resolve();
let toolCallsThisTurn = 0;
let budgetExhausted = false;
let closing = false;

function send(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function safeError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  const secret = initConfig?.apiKey ?? "";
  if (secret) message = message.split(secret).join("[REDACTED]");
  return message
    .replace(/\bsk-[A-Za-z0-9_+\-/=]{8,}/gu, "[REDACTED]")
    .slice(0, 1000);
}

function inside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function normalizedRules(config: InitCommand): AccessRule[] {
  const entries = Object.entries(config.filesystemAccess).map(([root, access]) => ({
    root: canonicalRoot(root),
    access,
  }));
  if (config.readOnly) {
    for (const root of config.allowedReadRoots) entries.push({ root: canonicalRoot(root), access: "read" });
  } else {
    entries.push({ root: canonicalRoot(config.cwd), access: "write" });
    entries.push({ root: canonicalRoot(path.resolve(config.cwd, "raw")), access: "read" });
  }
  return entries.sort((a, b) => b.root.length - a.root.length);
}

function accessFor(target: string, rules: AccessRule[]): Access {
  return rules.find((rule) => inside(target, rule.root))?.access ?? "deny";
}

export async function resolveExisting(
  rawPath: string,
  cwd: string,
  rules: AccessRule[],
  required: "read" | "write",
): Promise<string> {
  if (!rawPath.trim()) throw new Error("path is required");
  const lexical = path.resolve(cwd, rawPath);
  const lexicalStat = await fs.promises.lstat(lexical);
  if (lexicalStat.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${rawPath}`);
  const real = await fs.promises.realpath(lexical);
  const access = accessFor(real, rules);
  if (access === "deny" || (required === "write" && access !== "write")) {
    throw new Error(`filesystem access denied: ${rawPath}`);
  }
  return real;
}

export async function resolveWriteTarget(
  rawPath: string,
  cwd: string,
  rules: AccessRule[],
): Promise<string> {
  if (!rawPath.trim()) throw new Error("path is required");
  const lexical = path.resolve(cwd, rawPath);
  try {
    const lexicalStat = await fs.promises.lstat(lexical);
    if (lexicalStat.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${rawPath}`);
    const target = await fs.promises.realpath(lexical);
    if (accessFor(target, rules) !== "write") {
      throw new Error(`filesystem write denied: ${rawPath}`);
    }
    return target;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  let ancestorLexical = path.dirname(lexical);
  while (true) {
    try {
      const ancestor = await fs.promises.realpath(ancestorLexical);
      if (accessFor(ancestor, rules) !== "write") {
        throw new Error(`filesystem write denied: ${rawPath}`);
      }
      const target = path.join(ancestor, path.relative(ancestorLexical, lexical));
      if (accessFor(target, rules) !== "write") {
        throw new Error(`filesystem write denied: ${rawPath}`);
      }
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const parent = await fs.promises.realpath(path.dirname(target));
      if (accessFor(parent, rules) !== "write") {
        throw new Error(`filesystem write denied: ${rawPath}`);
      }
      return path.join(parent, path.basename(target));
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      const next = path.dirname(ancestorLexical);
      if (next === ancestorLexical) throw new Error(`filesystem write denied: ${rawPath}`);
      ancestorLexical = next;
    }
  }
}

function consumeToolBudget(config: InitCommand) {
  toolCallsThisTurn += 1;
  if (toolCallsThisTurn <= config.maxToolCalls) return undefined;
  budgetExhausted = true;
  return {
    ...textResult(`Tool-call budget exhausted after ${config.maxToolCalls} calls.`),
    terminate: true,
  };
}

function budgeted(config: InitCommand, execute: ToolDefinition["execute"]): ToolDefinition["execute"] {
  return async (toolCallId, args, signal, onUpdate, context) => {
    const exhausted = consumeToolBudget(config);
    if (exhausted) return exhausted;
    return execute(toolCallId, args, signal, onUpdate, context);
  };
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

function toolError(error: unknown) {
  return textResult(`Tool denied or failed: ${safeError(error)}`, { error: true });
}

function mimeTypeFor(file: string): string | undefined {
  const ext = path.extname(file).toLowerCase();
  return {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  }[ext];
}

async function walkFiles(root: string, maxFiles = 10_000): Promise<string[]> {
  const out: string[] = [];
  const pending = [root];
  while (pending.length > 0 && out.length < maxFiles) {
    const current = pending.pop()!;
    for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) out.push(target);
      if (out.length >= maxFiles) break;
    }
  }
  return out.sort();
}

function fileToolDefinitions(config: InitCommand): ToolDefinition[] {
  const rules = normalizedRules(config);
  const selected = new Set(config.fileTools);
  const tools: ToolDefinition[] = [];

  if (selected.has("Read")) {
    tools.push({
      name: "Read",
      label: "Read",
      description: "Read a UTF-8 text file or supported image inside the declared KBC workspace.",
      parameters: Type.Object({
        file_path: Type.String(),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      executionMode: "sequential",
      execute: budgeted(config, async (_id, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        try {
          const target = await resolveExisting(String(args.file_path), config.cwd, rules, "read");
          const stat = await fs.promises.stat(target);
          if (!stat.isFile()) throw new Error("target is not a regular file");
          const mimeType = mimeTypeFor(target);
          if (mimeType) {
            if (stat.size > 10 * 1024 * 1024) throw new Error("image exceeds 10 MiB");
            const image: ImageContent = {
              type: "image",
              data: (await fs.promises.readFile(target)).toString("base64"),
              mimeType,
            };
            return { content: [image], details: { path: target, bytes: stat.size } };
          }
          if (stat.size > 2 * 1024 * 1024) throw new Error("text file exceeds 2 MiB");
          const lines = (await fs.promises.readFile(target, "utf8")).split(/\r?\n/u);
          const offset = Math.max(1, Math.floor(Number(args.offset ?? 1)));
          const limit = Math.min(2000, Math.max(1, Math.floor(Number(args.limit ?? 500))));
          const selectedLines = lines.slice(offset - 1, offset - 1 + limit);
          const numbered = selectedLines.map((line, index) => `${offset + index}: ${line}`).join("\n");
          return textResult(numbered || "(empty file)", {
            path: target,
            totalLines: lines.length,
            truncated: offset - 1 + limit < lines.length,
          });
        } catch (error) {
          return toolError(error);
        }
      }),
    });
  }

  if (selected.has("Write") && !config.readOnly) {
    tools.push({
      name: "Write",
      label: "Write",
      description: "Write a UTF-8 file inside the writable KBC workspace. Frozen raw/ sources are read-only.",
      parameters: Type.Object({ file_path: Type.String(), content: Type.String() }),
      executionMode: "sequential",
      execute: budgeted(config, async (_id, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        try {
          const target = await resolveWriteTarget(String(args.file_path), config.cwd, rules);
          await fs.promises.writeFile(target, String(args.content), "utf8");
          return textResult(`Wrote ${Buffer.byteLength(String(args.content), "utf8")} bytes to ${args.file_path}.`);
        } catch (error) {
          return toolError(error);
        }
      }),
    });
  }

  if (selected.has("Edit") && !config.readOnly) {
    tools.push({
      name: "Edit",
      label: "Edit",
      description: "Replace an exact string in a writable UTF-8 file inside the KBC workspace.",
      parameters: Type.Object({
        file_path: Type.String(),
        old_string: Type.String(),
        new_string: Type.String(),
        replace_all: Type.Optional(Type.Boolean()),
      }),
      executionMode: "sequential",
      execute: budgeted(config, async (_id, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        try {
          const target = await resolveExisting(String(args.file_path), config.cwd, rules, "write");
          const before = await fs.promises.readFile(target, "utf8");
          const oldString = String(args.old_string);
          if (!oldString) throw new Error("old_string must not be empty");
          const occurrences = before.split(oldString).length - 1;
          if (occurrences === 0) throw new Error("old_string was not found");
          if (!args.replace_all && occurrences !== 1) {
            throw new Error(`old_string is not unique (${occurrences} matches)`);
          }
          const after = args.replace_all
            ? before.split(oldString).join(String(args.new_string))
            : before.replace(oldString, String(args.new_string));
          await fs.promises.writeFile(target, after, "utf8");
          return textResult(`Edited ${args.file_path} (${args.replace_all ? occurrences : 1} replacement(s)).`);
        } catch (error) {
          return toolError(error);
        }
      }),
    });
  }

  if (selected.has("Glob")) {
    tools.push({
      name: "Glob",
      label: "Glob",
      description: "List files matching a glob pattern below a readable KBC workspace path.",
      parameters: Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String()),
      }),
      executionMode: "sequential",
      execute: budgeted(config, async (_id, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        try {
          const root = await resolveExisting(String(args.path ?? config.cwd), config.cwd, rules, "read");
          const stat = await fs.promises.stat(root);
          if (!stat.isDirectory()) throw new Error("glob path is not a directory");
          const pattern = String(args.pattern);
          const matches = (await walkFiles(root))
            .filter((file) => path.matchesGlob(path.relative(root, file).split(path.sep).join("/"), pattern))
            .slice(0, 500)
            .map((file) => path.relative(config.cwd, file).split(path.sep).join("/"));
          return textResult(matches.join("\n") || "No files matched.", { count: matches.length });
        } catch (error) {
          return toolError(error);
        }
      }),
    });
  }

  if (selected.has("Grep")) {
    tools.push({
      name: "Grep",
      label: "Grep",
      description: "Search bounded UTF-8 files for a regular expression inside a readable KBC workspace path.",
      parameters: Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String()),
        glob: Type.Optional(Type.String()),
      }),
      executionMode: "sequential",
      execute: budgeted(config, async (_id, rawArgs) => {
        const args = rawArgs as Record<string, unknown>;
        try {
          const root = await resolveExisting(String(args.path ?? config.cwd), config.cwd, rules, "read");
          const stat = await fs.promises.stat(root);
          const files = stat.isFile() ? [root] : await walkFiles(root, 5000);
          const expression = new RegExp(String(args.pattern), "u");
          const glob = args.glob ? String(args.glob) : undefined;
          const matches: string[] = [];
          for (const file of files) {
            if (matches.length >= 200) break;
            const rel = path.relative(root, file).split(path.sep).join("/");
            if (glob && !path.matchesGlob(rel, glob)) continue;
            const fileStat = await fs.promises.stat(file);
            if (fileStat.size > 2 * 1024 * 1024 || mimeTypeFor(file)) continue;
            let text: string;
            try {
              text = await fs.promises.readFile(file, "utf8");
            } catch {
              continue;
            }
            for (const [index, line] of text.split(/\r?\n/u).entries()) {
              expression.lastIndex = 0;
              if (expression.test(line)) {
                matches.push(`${path.relative(config.cwd, file).split(path.sep).join("/")}:${index + 1}:${line.slice(0, 1000)}`);
                if (matches.length >= 200) break;
              }
            }
          }
          return textResult(matches.join("\n") || "No matches found.", {
            count: matches.length,
            truncated: matches.length >= 200,
          });
        } catch (error) {
          return toolError(error);
        }
      }),
    });
  }

  return tools;
}

function hostToolDefinitions(config: InitCommand): ToolDefinition[] {
  return config.tools.map((spec) => ({
    name: spec.name,
    label: spec.name,
    description: spec.description,
    parameters: Type.Unsafe(spec.inputSchema) as TSchema,
    executionMode: "sequential",
    execute: budgeted(config, async (toolCallId, args) => {
      send({ type: "tool_call", id: toolCallId, name: spec.name, args });
      try {
        const result = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingToolCalls.delete(toolCallId);
            reject(new Error(`tool ${spec.name} timed out`));
          }, 120_000);
          pendingToolCalls.set(toolCallId, { resolve, reject, timer });
        });
        return textResult(result);
      } catch (error) {
        return toolError(error);
      }
    }),
  }));
}

function emptyResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

async function initialize(config: InitCommand): Promise<void> {
  if (session) throw new Error("runner is already initialized");
  if (!path.isAbsolute(config.cwd)) throw new Error("cwd must be absolute");
  if (!config.apiKey) throw new Error("pi_sdk requires an API key");
  if (!config.provider || !config.model) throw new Error("pi_sdk requires provider and model");
  if (config.maxToolCalls < 1) throw new Error("maxToolCalls must be positive");
  initConfig = config;

  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
  const bundled = modelRuntime.getModel(config.provider, config.model);
  if (!bundled) {
    throw new Error(`Pi 0.82.1 does not contain model ${config.provider}/${config.model}`);
  }
  if (config.baseUrl) {
    modelRuntime.registerProvider(config.provider, { baseUrl: config.baseUrl });
  }
  await modelRuntime.setRuntimeApiKey(config.provider, config.apiKey, { allowNetwork: false });
  const model = modelRuntime.getModel(config.provider, config.model);
  if (!model) throw new Error(`model disappeared after provider configuration: ${config.provider}/${config.model}`);

  const customTools = [...fileToolDefinitions(config), ...hostToolDefinitions(config)];
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: true, maxRetries: 2 },
  });
  const created = await createAgentSession({
    cwd: config.cwd,
    model,
    thinkingLevel: config.thinkingLevel,
    modelRuntime,
    noTools: "builtin",
    customTools,
    resourceLoader: emptyResourceLoader(config.systemPrompt),
    sessionManager: SessionManager.inMemory(config.cwd),
    settingsManager,
  });
  session = created.session;
  session.subscribe((event) => {
    if (event.type === "message_update") {
      send({ type: "activity" });
      return;
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") return;
    const content = Array.isArray(event.message.content) ? event.message.content : [];
    const text = content
      .filter((block): block is { type: "text"; text: string } => block?.type === "text")
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n\n");
    const tools = content
      .filter((block): block is ToolCall => block?.type === "toolCall")
      .map((block) => ({ name: block.name, args: block.arguments }));
    if (text || tools.length > 0) send({ type: "assistant", text, tools });
  });
  send({
    type: "ready",
    sessionId: config.sessionId,
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    tools: customTools.map((tool) => tool.name),
  });
}

function statsDelta(
  before: ReturnType<AgentSession["getSessionStats"]>,
  after: ReturnType<AgentSession["getSessionStats"]>,
) {
  return {
    input_tokens: Math.max(0, after.tokens.input - before.tokens.input),
    output_tokens: Math.max(0, after.tokens.output - before.tokens.output),
    cache_read_input_tokens: Math.max(0, after.tokens.cacheRead - before.tokens.cacheRead),
    cache_creation_input_tokens: Math.max(0, after.tokens.cacheWrite - before.tokens.cacheWrite),
  };
}

async function runQuery(text: string): Promise<void> {
  if (!session || !initConfig) throw new Error("runner is not initialized");
  toolCallsThisTurn = 0;
  budgetExhausted = false;
  const before = session.getSessionStats();
  try {
    await session.prompt(text);
    const after = session.getSessionStats();
    const context = session.getContextUsage();
    const messages = session.agent.state.messages;
    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    const stopReason = lastAssistant && "stopReason" in lastAssistant ? lastAssistant.stopReason : undefined;
    send({
      type: "turn_result",
      isError: budgetExhausted || stopReason === "error",
      subtype: budgetExhausted ? "error_max_turns" : stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error_during_execution" : "success",
      usage: statsDelta(before, after),
      contextUsage: {
        totalTokens: context?.tokens ?? 0,
        maxTokens: context?.contextWindow ?? 0,
      },
      numTurns: toolCallsThisTurn,
    });
  } catch (error) {
    send({
      type: "turn_result",
      isError: true,
      subtype: "error_during_execution",
      error: safeError(error),
    });
  }
}

function settleToolResult(command: Extract<Command, { type: "tool_result" }>): void {
  const pending = pendingToolCalls.get(command.id);
  if (!pending) return;
  pendingToolCalls.delete(command.id);
  clearTimeout(pending.timer);
  if (command.error) pending.reject(new Error(command.error));
  else pending.resolve(String(command.result ?? ""));
}

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  for (const pending of pendingToolCalls.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Pi runner is closing"));
  }
  pendingToolCalls.clear();
  session?.dispose();
  session = undefined;
  send({ type: "closed" });
  setImmediate(() => process.exit(0));
}

async function handle(command: Command): Promise<void> {
  switch (command.type) {
    case "init":
      await initialize(command);
      return;
    case "query":
      queryChain = queryChain.then(() => runQuery(command.text));
      await Promise.resolve();
      return;
    case "tool_result":
      settleToolResult(command);
      return;
    case "interrupt":
      await session?.abort();
      return;
    case "close":
      await shutdown();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
  readline.on("line", (line) => {
    void (async () => {
      try {
        const command = JSON.parse(line) as Command;
        await handle(command);
      } catch (error) {
        send({ type: "fatal", error: safeError(error) });
      }
    })();
  });
  readline.on("close", () => {
    void shutdown();
  });
}
