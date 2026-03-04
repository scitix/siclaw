/**
 * ClaudeSdkBrain — BrainSession implementation using @anthropic-ai/claude-agent-sdk.
 *
 * Core design:
 * - Each prompt() call invokes SDK query() and consumes the async generator
 * - Events are normalized to pi-agent format (frontend already adapted)
 * - Custom tools are exposed via in-process MCP server (tool adapter)
 * - Plan system is supported through MCP tool handlers + external auto-continue loop
 */

import type {
  BrainSession,
  BrainModelInfo,
  BrainContextUsage,
  BrainSessionStats,
} from "../brain-session.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { adaptToolsForSdk } from "../tool-adapter.js";
import type { DpState } from "../../tools/dp-tools.js";

/** Lazy-loaded SDK imports (only when claude-sdk brain is actually used) */
let sdkModule: {
  query: any;
  tool: any;
  createSdkMcpServer: any;
};

async function loadSdk() {
  if (!sdkModule) {
    // Dynamic import — only resolves when claude-agent-sdk is installed
    sdkModule = await import(/* webpackIgnore: true */ "@anthropic-ai/claude-agent-sdk" as any);
  }
  return sdkModule;
}

export interface ClaudeSdkBrainConfig {
  systemPrompt: string;
  systemPromptAppend?: string;
  model?: string;
  cwd?: string;
  customTools: ToolDefinition[];
  /** When set, route SDK API calls through the LLM proxy */
  proxyUrl?: string;
  /** External MCP server configs — merged into SDK's mcpServers option */
  externalMcpServers?: Record<string, any>;
  /** Mutable DP state ref — enables auto-continue when DP checklist has pending items */
  dpState?: DpState;
}

export class ClaudeSdkBrain implements BrainSession {
  readonly brainType = "claude-sdk" as const;

  private listeners = new Set<(event: any) => void>();
  private sessionId?: string;
  private abortController?: AbortController;
  private currentModel?: string;
  private mcpServerConfig: any;  // McpSdkServerConfigWithInstance from SDK

  // Token tracking (accumulated across queries)
  private totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  private totalCost = 0;

  /** Tracks whether the current query produced any user-visible text */
  private queryHadText = false;

  /** Tracks whether the last assistant message in the current query had content */
  private lastMsgHadContent = false;

  /** Queued steer messages — executed as follow-up prompts after current query completes */
  private steerQueue: string[] = [];

  constructor(private config: ClaudeSdkBrainConfig) {
    this.currentModel = config.model;
  }

  /**
   * Initialize the MCP server with adapted tools (lazy, on first prompt).
   */
  private async ensureMcpServer(): Promise<void> {
    if (this.mcpServerConfig) return;

    const sdk = await loadSdk();

    // Adapt pi-agent tools to SDK format via the tool adapter.
    // The tool adapter's onToolStart/onToolEnd callbacks emit events.
    const adapted = adaptToolsForSdk(this.config.customTools, {
      onToolStart: (toolName, args) => {
        this.emit({ type: "tool_execution_start", toolName, args });
      },
      onToolEnd: (toolName, result, isError) => {
        this.emit({ type: "tool_execution_end", toolName, result, isError });
      },
    });

    // Convert AdaptedTool[] into SdkMcpToolDefinition[] using the SDK's tool() helper
    const sdkTools = adapted.map((t) =>
      sdk.tool(t.name, t.description, t.inputSchema, t.handler),
    );

    this.mcpServerConfig = sdk.createSdkMcpServer({
      name: "siclaw",
      version: "1.0.0",
      tools: sdkTools,
    });
  }

  async prompt(text: string): Promise<void> {
    await this.ensureMcpServer();
    const sdk = await loadSdk();

    this.abortController = new AbortController();
    this.emit({ type: "agent_start" });

    try {
      await this.runQuery(sdk, text);

      // Empty response guard: Kimi-K2.5 sometimes returns a completely empty
      // response (0 content blocks) on the final turn after tool results.
      // Pi-agent handles this via the streamFn wrapper in agent-factory.ts;
      // SDK brain needs its own retry here.
      if (!this.lastMsgHadContent) {
        console.log("[claude-sdk-brain] Last message was empty, requesting conclusion");
        await this.runQuery(sdk, "Based on the tool execution results above, please provide a summary and conclusion.");
      }

      // Process queued steer messages (e.g. hypothesis confirmation arriving mid-run)
      while (this.steerQueue.length > 0) {
        const steerText = this.steerQueue.shift()!;
        console.log(`[claude-sdk-brain] Processing queued steer: ${steerText.slice(0, 80)}`);
        await this.runQuery(sdk, steerText);
      }

      // DP auto-continue: if DP is active and checklist has pending items,
      // nudge the model to proceed to the next phase. Kimi-K2.5 sometimes
      // stops after completing a phase instead of chaining to the next one.
      // Cap at 3 nudges to prevent infinite loops.
      if (this.config.dpState) {
        let nudges = 0;
        const MAX_DP_NUDGES = 3;
        while (nudges < MAX_DP_NUDGES && this.config.dpState.checklist) {
          const pending = this.config.dpState.checklist.items.filter(
            (i) => i.status === "pending" || i.status === "in_progress",
          );
          if (pending.length === 0) break;
          nudges++;
          const nextPhase = pending[0].label;
          console.log(`[claude-sdk-brain] DP auto-continue (${nudges}/${MAX_DP_NUDGES}): ${nextPhase}`);
          await this.runQuery(sdk, `Please continue the deep investigation with the next phase: ${nextPhase}.`);
          // Drain any steer messages that arrived during this query
          while (this.steerQueue.length > 0) {
            const steerText = this.steerQueue.shift()!;
            await this.runQuery(sdk, steerText);
          }
        }
      }
    } finally {
      this.emit({ type: "agent_end", messages: [] });
    }
  }

  /**
   * Execute a single SDK query and consume all messages.
   */
  private async runQuery(sdk: any, prompt: string): Promise<void> {
    this.queryHadText = false;
    this.lastMsgHadContent = false;
    this.emit({ type: "turn_start" });

    const queryOptions: any = {
      // Use plain string system prompt — NOT preset: "claude_code".
      // The claude_code preset injects Claude Code's full system prompt, which tells
      // the model to "use tools for everything". Kimi-K2.5 takes this literally and
      // never produces text output. Pi-agent uses our SRE prompt directly.
      systemPrompt: this.config.systemPromptAppend
        ? `${this.config.systemPrompt}\n\n${this.config.systemPromptAppend}`
        : this.config.systemPrompt,
      model: this.currentModel,
      resume: this.sessionId,
      abortController: this.abortController,
      mcpServers: {
        siclaw: this.mcpServerConfig,
        ...this.buildExternalMcpServers(),
      },
      permissionMode: "bypassPermissions" as const,
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      cwd: this.config.cwd ?? process.cwd(),
      // Disable all builtin tools — use only our MCP tools
      tools: [] as string[],
    };

    // Route through LLM proxy when configured
    if (this.config.proxyUrl) {
      queryOptions.env = {
        ...process.env,
        ANTHROPIC_BASE_URL: this.config.proxyUrl,
        ANTHROPIC_API_KEY: "sk-proxy", // proxy handles auth with real key
      };
    }

    const q = sdk.query({ prompt, options: queryOptions });

    for await (const msg of q) {
      this.processSdkMessage(msg);
    }

    this.emit({ type: "turn_end", toolResults: [] });
  }

  async abort(): Promise<void> {
    this.abortController?.abort();
  }

  subscribe(listener: (event: any) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async reload(): Promise<void> {
    // Force MCP server recreation on next prompt
    this.mcpServerConfig = null;
  }

  async steer(text: string): Promise<void> {
    // SDK doesn't support mid-run message injection like pi-agent.
    // Queue the message — it will be executed as a follow-up query
    // after the current prompt's main query completes (via steerQueue drain in prompt()).
    console.log(`[claude-sdk-brain] steer() called — queuing for after current query: ${text.slice(0, 80)}`);
    this.steerQueue.push(text);
  }

  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = [...this.steerQueue];
    this.steerQueue.length = 0;
    return { steering, followUp: [] };
  }

  getContextUsage(): BrainContextUsage | undefined {
    // SDK manages context internally; we don't have direct access.
    // Return undefined — callers handle this gracefully.
    return undefined;
  }

  getSessionStats(): BrainSessionStats {
    return {
      tokens: { ...this.totalTokens },
      cost: this.totalCost,
    };
  }

  getModel(): BrainModelInfo | undefined {
    if (!this.currentModel) return undefined;
    return {
      id: this.currentModel,
      name: this.currentModel,
      provider: "anthropic",
      contextWindow: 200000,
      maxTokens: 16384,
      reasoning: true,
    };
  }

  async setModel(model: BrainModelInfo): Promise<void> {
    this.currentModel = model.id;
  }

  findModel(provider: string, modelId: string): BrainModelInfo | undefined {
    // SDK brain uses model ID directly; return a synthetic info object
    return {
      id: modelId,
      name: modelId,
      provider,
      contextWindow: 200000,
      maxTokens: 16384,
      reasoning: true,
    };
  }

  registerProvider(_name: string, _config: Record<string, unknown>): void {
    // Claude SDK brain uses model ID directly, no registry needed
  }

  // ---------- Private helpers ----------

  /**
   * Convert MCP server config to SDK-compatible McpServerConfig format.
   * SDK uses `type` field ("stdio" | "sse" | "http") instead of `transport`.
   */
  private buildExternalMcpServers(): Record<string, any> {
    const servers = this.config.externalMcpServers;
    if (!servers) return {};

    const result: Record<string, any> = {};
    for (const [name, config] of Object.entries(servers)) {
      const transport = config.transport as string;
      switch (transport) {
        case "stdio":
          result[name] = {
            type: "stdio",
            command: config.command,
            args: config.args,
            env: config.env,
          };
          break;
        case "sse":
          result[name] = {
            type: "sse",
            url: config.url,
            headers: config.headers,
          };
          break;
        case "streamable-http":
          result[name] = {
            type: "http",
            url: config.url,
            headers: config.headers,
          };
          break;
        default:
          console.warn(`[claude-sdk-brain] Unknown MCP transport: ${transport}`);
      }
    }
    return result;
  }

  private emit(event: any): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[claude-sdk-brain] Listener error:", err);
      }
    }
  }

  /**
   * Process a single SDK message and emit normalized pi-agent events.
   */
  private processSdkMessage(msg: any): void {
    // Debug: log all SDK messages
    if (msg.type === "assistant") {
      const content = msg.message?.content ?? msg.content ?? [];
      const types = Array.isArray(content)
        ? content.map((b: any) => b.type === "text" ? `text(${b.text?.length ?? 0})` : b.type).join(",")
        : typeof content === "string" ? `string(${content.length})` : "?";
      console.log(`[claude-sdk-brain] SDK msg: type=${msg.type} content=[${types}]`);
    } else if (msg.type === "stream_event") {
      const evt = msg.event;
      if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta") {
        // Don't spam — only log first text delta per message
        if (!this.queryHadText) {
          console.log(`[claude-sdk-brain] SDK msg: stream_event text_delta (first)`);
        }
      } else if (evt?.type !== "ping") {
        console.log(`[claude-sdk-brain] SDK msg: stream_event ${evt?.type ?? "?"} ${evt?.delta?.type ?? ""}`);
      }
    } else if (msg.type !== "system" || msg.subtype !== "status") {
      console.log(`[claude-sdk-brain] SDK msg: type=${msg.type} subtype=${msg.subtype ?? ""}`);
    }

    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          // Capture session ID for resume
          this.sessionId = msg.session_id;
        } else if (msg.subtype === "compact_boundary") {
          this.emit({ type: "auto_compaction_start", reason: "threshold" });
          this.emit({ type: "auto_compaction_end", result: null, aborted: false, willRetry: false });
        } else if (msg.subtype === "status") {
          if (msg.status === "compacting") {
            this.emit({ type: "auto_compaction_start", reason: "threshold" });
          } else if (msg.status === null) {
            this.emit({ type: "auto_compaction_end", result: null, aborted: false, willRetry: false });
          }
        }
        break;

      case "assistant": {
        // Complete assistant message — only emit if we haven't already streamed it.
        // With includePartialMessages: true, stream_event messages arrive first,
        // followed by the complete "assistant" message. Skip to avoid duplicates.
        // We still capture the content for token tracking purposes.
        break;
      }

      case "stream_event": {
        // Partial streaming events
        const event = msg.event;
        if (!event) break;

        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          if (event.delta.text) {
            this.queryHadText = true;
            this.lastMsgHadContent = true;
          }
          this.emit({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: event.delta.text,
            },
          });
        } else if (event.type === "content_block_start") {
          // content_block_start with tool_use marks content in this message
          if (event.content_block?.type === "tool_use") {
            this.lastMsgHadContent = true;
          }
        } else if (event.type === "message_start") {
          // Reset per-message tracking on each new assistant message
          this.lastMsgHadContent = false;
          this.emit({
            type: "message_start",
            message: { role: "assistant", content: [] },
          });
        } else if (event.type === "message_stop") {
          this.emit({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "end_turn",
            },
          });
        }
        break;
      }

      case "result": {
        // Final result — update token stats
        const usage = msg.usage;
        if (usage) {
          this.totalTokens.input += usage.input_tokens ?? 0;
          this.totalTokens.output += usage.output_tokens ?? 0;
          this.totalTokens.cacheRead += usage.cache_read_input_tokens ?? 0;
          this.totalTokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
          this.totalTokens.total = this.totalTokens.input + this.totalTokens.output;
        }
        this.totalCost += msg.total_cost_usd ?? 0;
        break;
      }

      case "rate_limit_event": {
        // Map to auto_retry events
        const info = msg.rate_limit_info;
        if (info?.status === "rejected") {
          this.emit({
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 5000,
            errorMessage: "Rate limited",
          });
        }
        break;
      }

      // tool_progress, tool_use_summary, etc. — not mapped (no pi-agent equivalent)
      default:
        break;
    }
  }

}
