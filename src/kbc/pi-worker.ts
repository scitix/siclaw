import path from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager, VERSION,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createPiExecutionSession } from "../core/pi-execution.js";
import type { LlmCallEnvelope } from "../core/llm-call-recorder.js";
import { withResolvedModelCompat } from "../core/model-compat.js";
import { createGuardRegistry } from "../core/guard-pipeline.js";
import { estimateMessageChars, PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE } from "../core/tool-result-context-guard.js";
import {
  parseWorkerInput, PI_WORKER_MAX_FRAME_BYTES,
  type WorkerInit, type WorkerInput,
} from "./pi-worker-protocol.js";

type ToolReply = Extract<WorkerInput, { type: "tool_result" }>;
type Execution = Awaited<ReturnType<typeof createPiExecutionSession>>;

/** Private JSONL worker; file/tool bodies and compilation checkpoints stay in Python. */
export class PiCompilerWorker {
  private config?: WorkerInit;
  private execution?: Execution;
  private active?: { id: string; task: Promise<void>; interrupted: boolean };
  private pendingTools = new Map<string, { turnId: string; resolve: (reply: ToolReply) => void; reject: (error: Error) => void }>();
  private calls = 0;
  private toolCalls = 0;
  private closing = false;
  private lastActivity = 0;

  constructor(
    private readonly send: (frame: Record<string, unknown>) => void,
    private readonly fail: (error: Error) => void,
  ) {}

  private emit(type: string, fields: Record<string, unknown> = {}) {
    this.send({ v: 1, session_id: this.config?.session_id, turn_id: this.active?.id, type, ...fields });
  }

  private safeError(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    const secrets = [this.config?.api_key, ...Object.values(this.config?.headers ?? {})];
    for (const secret of secrets) if (secret) message = message.replaceAll(secret, "[REDACTED]");
    return message.slice(0, 2000);
  }

  private safeCall(call: LlmCallEnvelope | undefined): LlmCallEnvelope | undefined {
    if (!call) return undefined;
    return {
      ...call,
      ...(call.error_message ? { error_message: this.safeError(call.error_message) } : {}),
      ...(call.aux_calls ? { aux_calls: call.aux_calls.map(aux => this.safeCall(aux)!) } : {}),
    };
  }

  async accept(frame: WorkerInput): Promise<void> {
    if (frame.type === "close") { await this.close(); return; }
    if (this.closing) throw new Error("Worker is closing");
    if (frame.type === "init") {
      if (this.config) throw new Error("Worker already initialized");
      await this.initialize(frame);
      return;
    }
    if (!this.execution) throw new Error("Worker is not initialized");
    if (frame.type === "tool_result") {
      const pending = this.pendingTools.get(frame.call_id);
      // A late reply must never settle a tool in a later turn.
      if (pending?.turnId === frame.turn_id) {
        this.pendingTools.delete(frame.call_id);
        pending.resolve(frame);
      }
      return;
    }
    if (frame.type === "interrupt") {
      if (this.active?.id === frame.turn_id) {
        this.active.interrupted = true;
        // Do not await here: the reader must continue accepting tool-cancel
        // acknowledgements before the agent can settle.
        this.execution.session.agent.abort();
        this.execution.session.abortCompaction();
      }
      return;
    }
    if (this.active) throw new Error("Previous turn has not settled");
    this.calls = 0;
    this.toolCalls = 0;
    const active = { id: frame.turn_id, task: Promise.resolve(), interrupted: false };
    this.active = active;
    active.task = this.prompt(frame).catch(error => {
      this.fail(error instanceof Error ? error : new Error("Worker turn failed"));
    }).finally(() => {
      if (this.active === active) this.active = undefined;
    });
  }

  private async initialize(config: WorkerInit): Promise<void> {
    this.config = config;
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: path.join(config.state_dir, "models-cache.json"), refreshOnCreate: false,
    });
    const normalized = withResolvedModelCompat({ api: config.model.api, models: [config.model] }).models[0];
    const { provider, baseUrl, api, ...model } = normalized;
    modelRuntime.registerProvider(provider, {
      baseUrl, api, models: [model], authHeader: config.auth_header ?? api !== "openai-codex-responses",
    });
    await modelRuntime.setRuntimeApiKey(provider, config.api_key);
    const resolved = modelRuntime.getModel(provider, model.id);
    if (!resolved) throw new Error("Configured compiler model could not be registered");
    const services = await createAgentSessionServices({
      cwd: config.cwd, agentDir: config.state_dir, modelRuntime,
      settingsManager: SettingsManager.inMemory({
        // The domain orchestrator owns retry and batch reconstruction. Neither
        // a second original prompt nor an implicit summary may replay writes.
        retry: { enabled: false }, compaction: { enabled: false },
      }),
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true,
        noThemes: true, noContextFiles: true, systemPrompt: config.system_prompt,
      },
    });
    const tools: ToolDefinition[] = config.tools.map(tool => ({
      name: tool.name, label: tool.name, description: tool.description,
      // Preserve JSON Schema just as the MCP adapter does. Pi validates and
      // coerces raw schemas; TypeBox re-encoding would change that behavior.
      parameters: tool.parameters as ToolDefinition["parameters"],
      execute: async (callId, args, signal) => {
        const turnId = this.active?.id;
        if (!turnId || signal?.aborted) throw new Error("Tool execution aborted");
        const reply = new Promise<ToolReply>((resolve, reject) => {
          this.pendingTools.set(callId, { turnId, resolve, reject });
        });
        const cancel = () => this.emit("tool_cancel", { call_id: callId });
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          this.toolCalls++;
          this.emit("tool_request", { call_id: callId, name: tool.name, arguments: args });
          const result = await reply;
          if (signal?.aborted) throw new Error("Tool execution aborted");
          if (result.is_error) throw new Error(result.content.filter(part => part.type === "text").map(part => part.text).join("\n"));
          return { content: result.content, details: {} };
        } finally {
          signal?.removeEventListener("abort", cancel);
          this.pendingTools.delete(callId);
        }
      },
    }));
    const guards = createGuardRegistry(resolved.contextWindow);
    // Host tools already paginate and bound their output. The conversational
    // guard converts oversized mixed-media results into text, which silently
    // removes scanned PDF evidence. Compilation must preserve its evidence or
    // fail explicitly so the domain can rebuild with a smaller source batch.
    guards.context = [{ name: "compiler-context-budget", handler: messages => {
      const budget = (resolved.contextWindow - resolved.maxTokens) * 0.75 * 4;
      const estimated = config.system_prompt.length + messages.reduce((sum, message) => sum + estimateMessageChars(message), 0);
      if (estimated > budget) throw new Error(PREEMPTIVE_CONTEXT_OVERFLOW_MESSAGE);
    } }];
    this.execution = await createPiExecutionSession({
      services, sessionManager: SessionManager.create(config.cwd, path.join(config.state_dir, "sessions")),
      model: resolved, thinkingLevel: config.thinking_level, customTools: tools,
      guards,
      onModelEnvelope: manifest => this.emit("model_envelope", { manifest }),
    });
    const { session, llmCallRecorder } = this.execution;
    llmCallRecorder.setUsageSink({
      context: () => ({ sessionId: config.session_id, requestId: this.active?.id,
        executionRole: "root", executorRole: config.executor_role ?? "compile" }),
      record: observation => this.emit("model_usage", { observation }),
    });
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (requestedModel, context, options) => {
      if (this.calls >= config.max_model_calls) throw new Error("KBC_MODEL_CALL_BUDGET_EXCEEDED");
      this.calls++;
      this.emit("model_request", { call: this.calls, model: requestedModel.id, provider: requestedModel.provider });
      return stream(requestedModel, context, {
        ...options, maxRetries: 0, headers: { ...options?.headers, ...config.headers },
      });
    };
    session.subscribe(event => {
      if (!this.active) return;
      if (event.type === "message_update") {
        if (Date.now() - this.lastActivity >= 100) {
          this.lastActivity = Date.now();
          this.emit("activity");
        }
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message as AssistantMessage & { llmCall?: LlmCallEnvelope };
        this.execution!.llmCallRecorder.attachPendingFailure(message);
        this.emit("assistant", {
          content: message.content.filter(part => part.type !== "thinking").map(part => {
            if (part.type !== "toolCall") return part;
            // Full arguments travel once, in tool_request. These fields serve
            // the existing read/search labels without duplicating large writes.
            const args = Object.fromEntries(Object.entries(part.arguments).filter(([key]) =>
              ["file_path", "path", "pattern"].includes(key)));
            return { type: "toolCall", id: part.id, name: part.name, arguments: args };
          }),
          stop_reason: message.stopReason,
          llm_call: this.safeCall(message.llmCall),
        });
      } else if (event.type === "tool_execution_start") {
        this.emit("tool_start", { call_id: event.toolCallId, name: event.toolName });
      } else if (event.type === "tool_execution_end") {
        this.emit("tool_end", { call_id: event.toolCallId, name: event.toolName, is_error: event.isError });
      }
    });
    this.emit("ready", { sdk_version: VERSION });
  }

  private async prompt(frame: Extract<WorkerInput, { type: "prompt" }>): Promise<void> {
    const { session, llmCallRecorder } = this.execution!;
    llmCallRecorder.beginPrompt(Date.now(), { explicit: true });
    const before = session.messages.length;
    try {
      await session.prompt(frame.text, { images: frame.images, expandPromptTemplates: false });
      const terminal = session.messages.slice(before).reverse().find(message => message.role === "assistant") as AssistantMessage | undefined;
      const reason = terminal?.stopReason;
      const interrupted = this.active?.interrupted || reason === "aborted";
      const error = terminal?.errorMessage ?? (reason === "length" ? "Model output limit reached" : "No terminal assistant response");
      const completed = !interrupted && reason === "stop";
      this.emit("result", {
        outcome: interrupted ? "aborted" : completed ? "completed" : "failed",
        stop_reason: reason,
        model_calls: this.calls,
        tool_calls: this.toolCalls,
        usage: terminal ? {
          input_tokens: terminal.usage.input, output_tokens: terminal.usage.output,
          cache_read_input_tokens: terminal.usage.cacheRead,
          cache_creation_input_tokens: terminal.usage.cacheWrite,
        } : undefined,
        context_window: this.config!.model.contextWindow,
        ...(completed || interrupted ? {} : {
          error: this.safeError(error),
          api_error_status: providerStatus(error),
        }),
      });
    } catch (error) {
      this.emit("result", {
        outcome: this.active?.interrupted ? "aborted" : "failed",
        error: this.safeError(error), api_error_status: providerStatus(error), model_calls: this.calls, tool_calls: this.toolCalls,
      });
    } finally {
      llmCallRecorder.endPrompt({ explicit: true });
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.active) this.active.interrupted = true;
    this.execution?.session.agent.abort();
    for (const pending of this.pendingTools.values()) pending.reject(new Error("Worker transport closed"));
    this.pendingTools.clear();
    await this.active?.task;
    this.execution?.session.dispose();
  }
}

function providerStatus(error: unknown): number | undefined {
  const text = error instanceof Error ? error.message : String(error);
  const match = text.match(/(?:\bHTTP\s*|\bstatus(?:\s+code)?[\s:=]*|^)(4\d\d|5\d\d)\b/i);
  return match ? Number(match[1]) : undefined;
}

export async function runPiCompilerWorker(): Promise<void> {
  let queuedBytes = 0;
  let output = Promise.resolve();
  let outputError: Error | undefined;
  const fail = (error: Error) => process.stdin.destroy(error);
  const worker = new PiCompilerWorker(frame => {
    const line = JSON.stringify(frame) + "\n";
    const size = Buffer.byteLength(line);
    if (size > PI_WORKER_MAX_FRAME_BYTES || queuedBytes + size > 2 * PI_WORKER_MAX_FRAME_BYTES) throw new Error("Worker output budget exceeded");
    queuedBytes += size;
    output = output.then(async () => {
      if (outputError) return;
      if (!process.stdout.write(line)) await once(process.stdout, "drain");
      queuedBytes -= size;
    }).catch(error => {
      outputError = error instanceof Error ? error : new Error("Worker output failed");
      fail(outputError);
    });
  }, fail);
  let chunks: Buffer[] = [];
  let frameBytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for await (const input of process.stdin) {
      let chunk = input as Buffer;
      while (chunk.length) {
        const end = chunk.indexOf(10);
        const part = end < 0 ? chunk : chunk.subarray(0, end);
        frameBytes += part.length;
        if (frameBytes > PI_WORKER_MAX_FRAME_BYTES) throw new Error("Worker input budget exceeded");
        chunks.push(part);
        if (end < 0) break;
        const line = Buffer.concat(chunks, frameBytes);
        chunks = [];
        frameBytes = 0;
        await worker.accept(parseWorkerInput(JSON.parse(decoder.decode(line))));
        chunk = chunk.subarray(end + 1);
      }
    }
    if (frameBytes) throw new Error("Incomplete worker frame");
  } finally {
    await worker.close();
    await output;
  }
  if (outputError) throw outputError;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPiCompilerWorker().catch(() => {
    // The parent owns diagnostics; never print a credential-bearing init frame
    // or provider payload into pod logs on a protocol failure.
    process.stderr.write("kbc_pi_worker_failed\n");
    process.exitCode = 1;
  });
}
