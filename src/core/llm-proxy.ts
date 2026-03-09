/**
 * LLM Proxy — Translates Anthropic Messages API ↔ OpenAI Chat Completions API.
 *
 * Runs as a lightweight HTTP server on 127.0.0.1 with a random port.
 * The Claude Agent SDK subprocess connects via ANTHROPIC_BASE_URL.
 *
 * Architecture:
 *   Claude Code subprocess → POST /v1/messages (Anthropic fmt)
 *   → [this proxy] → POST {baseUrl}/chat/completions (OpenAI fmt)
 *   → OpenAI-compatible provider (Qwen, DeepSeek, Kimi…)
 */

import http from "node:http";
import { getDefaultLlm, type ProviderModelConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelCompat {
  supportsDeveloperRole?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: string;
  thinkingFormat?: string;
}

interface ModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  compat?: ModelCompat;
}

export interface ProxyConfig {
  baseUrl: string;
  apiKey: string;
  authHeader: boolean;
  model: ModelConfig;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function loadProxyConfig(): ProxyConfig | null {
  const llm = getDefaultLlm();
  if (!llm || llm.api !== "openai-completions") return null;

  return {
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    authHeader: llm.authHeader,
    model: llm.model as ModelConfig,
  };
}

/** Quick check — does settings.json have an openai-completions provider? */
export function hasOpenAIProvider(): boolean {
  return loadProxyConfig() !== null;
}

// ---------------------------------------------------------------------------
// Request translation  (Anthropic Messages → OpenAI Chat Completions)
// ---------------------------------------------------------------------------

function translateRequest(body: any, config: ProxyConfig): any {
  const messages: any[] = [];

  // --- System prompt ---
  if (body.system) {
    if (typeof body.system === "string") {
      messages.push({ role: "system", content: body.system });
    } else if (Array.isArray(body.system)) {
      const text = body.system
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      if (text) messages.push({ role: "system", content: text });
    }
  }

  // --- Messages ---
  for (const msg of body.messages ?? []) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        messages.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter((b: any) => b.type === "tool_result");
        const otherBlocks = msg.content.filter((b: any) => b.type !== "tool_result");

        // tool_result blocks → separate "tool" role messages
        for (const tr of toolResults) {
          let content: string;
          if (typeof tr.content === "string") {
            content = tr.content;
          } else if (Array.isArray(tr.content)) {
            content = tr.content
              .filter((c: any) => c.type === "text")
              .map((c: any) => c.text)
              .join("\n");
          } else {
            content = "";
          }
          messages.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: content || "(empty)",
          });
        }

        // Remaining content blocks → user message
        if (otherBlocks.length > 0) {
          const hasImages = otherBlocks.some((b: any) =>
            b.type === "image" || b.type === "image_url",
          );
          if (hasImages) {
            const contentArray = otherBlocks.map((b: any) => {
              if (b.type === "text") return { type: "text" as const, text: b.text };
              if (b.type === "image") {
                return {
                  type: "image_url" as const,
                  image_url: {
                    url: `data:${b.source?.media_type ?? "image/png"};base64,${b.source?.data ?? ""}`,
                  },
                };
              }
              return { type: "text" as const, text: JSON.stringify(b) };
            });
            messages.push({ role: "user", content: contentArray });
          } else {
            const text = otherBlocks
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n");
            if (text) messages.push({ role: "user", content: text });
          }
        }
      }
    } else if (msg.role === "assistant") {
      const assistantMsg: any = { role: "assistant" };

      if (typeof msg.content === "string") {
        assistantMsg.content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter((b: any) => b.type === "text");
        const toolUseBlocks = msg.content.filter((b: any) => b.type === "tool_use");
        const thinkingBlocks = msg.content.filter((b: any) => b.type === "thinking");

        // Text
        const nonEmptyText = textBlocks.filter((b: any) => b.text?.trim());
        if (nonEmptyText.length > 0) {
          assistantMsg.content = nonEmptyText.map((b: any) => b.text).join("");
        }

        // Thinking → reasoning_content (Qwen) or discard
        if (thinkingBlocks.length > 0 && config.model.compat?.thinkingFormat === "qwen") {
          assistantMsg.reasoning_content = thinkingBlocks
            .map((b: any) => b.thinking)
            .join("\n");
        }

        // Tool use → tool_calls
        if (toolUseBlocks.length > 0) {
          assistantMsg.tool_calls = toolUseBlocks.map((b: any) => ({
            id: b.id,
            type: "function",
            function: {
              name: b.name,
              arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input),
            },
          }));
        }

        if (!assistantMsg.content) assistantMsg.content = null;
      }

      messages.push(assistantMsg);
    }
  }

  // --- Build params ---
  const compat = config.model.compat ?? {};
  const params: any = {
    model: config.model.id,
    messages,
    stream: body.stream ?? false,
  };

  // max_tokens
  const maxTokensField = compat.maxTokensField || "max_tokens";
  if (body.max_tokens) {
    params[maxTokensField] = body.max_tokens;
  }

  // Tools
  if (body.tools && body.tools.length > 0) {
    params.tools = body.tools.map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  // Temperature
  if (body.temperature !== undefined) {
    params.temperature = body.temperature;
  }

  // Thinking / reasoning — DISABLED for SDK brain compatibility.
  // We don't translate reasoning_content back to thinking blocks (see streaming handler),
  // so don't request it from the upstream either.
  // Pi-agent handles reasoning natively via @mariozechner/pi-ai, not through this proxy.

  // Stream options — request usage in streaming chunks
  if (params.stream && compat.supportsUsageInStreaming !== false) {
    params.stream_options = { include_usage: true };
  }

  return params;
}

// ---------------------------------------------------------------------------
// Non-streaming response translation  (OpenAI → Anthropic)
// ---------------------------------------------------------------------------

function translateNonStreamResponse(openaiResp: any, requestModel: string): any {
  const choice = openaiResp.choices?.[0];
  if (!choice) {
    return {
      type: "error",
      error: { type: "api_error", message: "No choices in response" },
    };
  }

  const content: any[] = [];

  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: any;
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  let stop_reason = "end_turn";
  if (choice.finish_reason === "tool_calls") stop_reason = "tool_use";
  else if (choice.finish_reason === "length") stop_reason = "max_tokens";

  const usage = openaiResp.usage ?? {};

  return {
    id: `msg_proxy_${Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model: requestModel,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming response translation  (OpenAI SSE → Anthropic SSE)
// ---------------------------------------------------------------------------

async function handleStreamResponse(
  upstreamRes: Response,
  res: http.ServerResponse,
  requestModel: string,
  config: ProxyConfig,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });
  res.flushHeaders();

  // Helper to write a single Anthropic SSE event
  const writeEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // State machine
  let contentBlockIndex = -1;
  let currentBlockType: "text" | "tool_use" | "thinking" | null = null;
  let lastToolCallId: string | null = null;
  let messageStartSent = false;
  let outputTokens = 0;
  let hasTextContent = false;
  let hasToolCalls = false;
  let finishReason: string | null = null;
  let textLength = 0;

  const sendMessageStart = () => {
    if (messageStartSent) return;
    messageStartSent = true;
    writeEvent("message_start", {
      type: "message_start",
      message: {
        id: `msg_proxy_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [],
        model: requestModel,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const closeCurrentBlock = () => {
    if (currentBlockType !== null && contentBlockIndex >= 0) {
      writeEvent("content_block_stop", {
        type: "content_block_stop",
        index: contentBlockIndex,
      });
      currentBlockType = null;
    }
  };

  // Read upstream SSE
  const body = upstreamRes.body;
  if (!body) {
    sendMessageStart();
    writeEvent("message_stop", { type: "message_stop" });
    res.end();
    return;
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split into lines and process complete SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? ""; // keep the incomplete trailing line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();

        if (data === "[DONE]") {
          closeCurrentBlock();
          console.log(
            `[llm-proxy] Stream done: text=${hasTextContent}(${textLength}ch) tools=${hasToolCalls} finish=${finishReason} blocks=${contentBlockIndex + 1}`,
          );
          if (messageStartSent) {
            writeEvent("message_stop", { type: "message_stop" });
          }
          res.end();
          return;
        }

        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        sendMessageStart();

        // Usage
        if (chunk.usage) {
          outputTokens = chunk.usage.completion_tokens ?? 0;
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) {
          // finish_reason without delta
          if (choice.finish_reason) {
            closeCurrentBlock();
            let stopReason = "end_turn";
            if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
            else if (choice.finish_reason === "length") stopReason = "max_tokens";

            writeEvent("message_delta", {
              type: "message_delta",
              delta: { stop_reason: stopReason, stop_sequence: null },
              usage: { output_tokens: outputTokens },
            });
          }
          continue;
        }

        // --- Reasoning / thinking ---
        // IMPORTANT: Do NOT translate reasoning_content to Anthropic "thinking" blocks.
        // The Claude Agent SDK doesn't handle unsolicited thinking blocks from non-Claude
        // models — it gets confused and makes extra API calls that return only thinking
        // with no text output. Just discard the reasoning content silently.
        // (Pi-agent handles reasoning_content natively via @mariozechner/pi-ai.)

        // --- Text content ---
        if (delta.content != null && delta.content.length > 0) {
          hasTextContent = true;
          textLength += delta.content.length;
          if (currentBlockType !== "text") {
            closeCurrentBlock();
            contentBlockIndex++;
            currentBlockType = "text";
            writeEvent("content_block_start", {
              type: "content_block_start",
              index: contentBlockIndex,
              content_block: { type: "text", text: "" },
            });
          }
          writeEvent("content_block_delta", {
            type: "content_block_delta",
            index: contentBlockIndex,
            delta: { type: "text_delta", text: delta.content },
          });
        }

        // --- Tool calls ---
        if (delta.tool_calls) {
          hasToolCalls = true;
          for (const tc of delta.tool_calls) {
            // New tool call starts when we see an id
            if (tc.id && tc.id !== lastToolCallId) {
              closeCurrentBlock();
              contentBlockIndex++;
              currentBlockType = "tool_use";
              lastToolCallId = tc.id;
              writeEvent("content_block_start", {
                type: "content_block_start",
                index: contentBlockIndex,
                content_block: {
                  type: "tool_use",
                  id: tc.id,
                  name: tc.function?.name ?? "",
                  input: {},
                },
              });
            }

            // Arguments delta
            if (tc.function?.arguments) {
              writeEvent("content_block_delta", {
                type: "content_block_delta",
                index: contentBlockIndex,
                delta: {
                  type: "input_json_delta",
                  partial_json: tc.function.arguments,
                },
              });
            }
          }
        }

        // --- Finish reason ---
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
          closeCurrentBlock();

          let stopReason = "end_turn";
          if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
          else if (choice.finish_reason === "length") stopReason = "max_tokens";

          writeEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: outputTokens },
          });
        }
      }
    }

    // Stream ended without [DONE] — close gracefully
    closeCurrentBlock();
    if (messageStartSent) {
      writeEvent("message_stop", { type: "message_stop" });
    }
    res.end();
  } catch (err: any) {
    console.error("[llm-proxy] Stream error:", err.message);
    closeCurrentBlock();
    if (messageStartSent) {
      writeEvent("message_stop", { type: "message_stop" });
    }
    if (!res.writableEnded) res.end();
  }
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

let proxyInstance: { port: number; server: http.Server; stop: () => Promise<void> } | null = null;

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: ProxyConfig,
): Promise<void> {
  // Only handle POST /v1/messages
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "ok" }));
    return;
  }

  // Read request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const rawBody = Buffer.concat(chunks).toString("utf-8");

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid JSON body" },
    }));
    return;
  }

  const requestModel = body.model ?? "claude-sonnet-4-20250514";
  const openaiParams = translateRequest(body, config);
  const isStream = openaiParams.stream;

  const msgSummary = (body.messages ?? []).map((m: any) => {
    const role = m.role;
    if (typeof m.content === "string") return `${role}(text:${m.content.length})`;
    if (Array.isArray(m.content)) {
      const types = m.content.map((b: any) => b.type).join(",");
      return `${role}(${types})`;
    }
    return role;
  }).join(" → ");

  console.log(
    `[llm-proxy] POST /v1/messages → ${config.baseUrl}/chat/completions ` +
    `(model=${config.model.id}, stream=${isStream}, tools=${body.tools?.length ?? 0}, ` +
    `msgs=${body.messages?.length ?? 0}: ${msgSummary})`,
  );

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.authHeader) {
      headers["Authorization"] = `Bearer ${config.apiKey}`;
    }

    const upstreamUrl = `${config.baseUrl}/chat/completions`;
    const upstreamRes = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(openaiParams),
    });

    if (!upstreamRes.ok) {
      const errBody = await upstreamRes.text();
      const status = upstreamRes.status;
      console.error(`[llm-proxy] Upstream error ${status}: ${errBody.slice(0, 500)}`);
      const hint = (status === 401 || status === 403)
        ? ". Use /setup → Models to reconfigure your API key"
        : "";
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: `Upstream ${status}: ${errBody.slice(0, 500)}${hint}` },
      }));
      return;
    }

    if (isStream) {
      await handleStreamResponse(upstreamRes, res, requestModel, config);
    } else {
      const openaiResp = await upstreamRes.json();
      const anthropicResp = translateNonStreamResponse(openaiResp, requestModel);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(anthropicResp));
    }
  } catch (err: any) {
    console.error("[llm-proxy] Request error:", err.message);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
    }
    if (!res.writableEnded) {
      res.end(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: err.message },
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton lifecycle
// ---------------------------------------------------------------------------

export async function ensureProxy(): Promise<string> {
  if (proxyInstance) return `http://127.0.0.1:${proxyInstance.port}`;

  const config = loadProxyConfig();
  if (!config) {
    throw new Error("[llm-proxy] No openai-completions provider configured in settings.json");
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res, config).catch((err) => {
      console.error("[llm-proxy] Unhandled error:", err);
      if (!res.headersSent) res.writeHead(500);
      if (!res.writableEnded) res.end();
    });
  });

  return new Promise<string>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      proxyInstance = {
        port: addr.port,
        server,
        stop: () =>
          new Promise<void>((r) =>
            server.close(() => {
              proxyInstance = null;
              r();
            }),
          ),
      };
      console.log(
        `[llm-proxy] Started on port ${addr.port} → ${config.baseUrl} (model: ${config.model.id})`,
      );
      resolve(`http://127.0.0.1:${addr.port}`);
    });
    server.on("error", reject);
  });
}

export async function stopProxy(): Promise<void> {
  if (proxyInstance) {
    await proxyInstance.stop();
    console.log("[llm-proxy] Stopped");
  }
}
