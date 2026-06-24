/**
 * DingTalk (钉钉) channel handler.
 *
 * Connects to DingTalk via its Stream Mode WebSocket (`dingtalk-stream-sdk-nodejs`).
 * Routes messages dynamically via channel_bindings (not a hardcoded agent).
 * Supports the PAIR command for binding chat groups to agents.
 *
 * Reply path (Phase 1): once the agent finishes, we POST a markdown message
 * to the message's temporary `sessionWebhook` URL. The streaming "typing card"
 * UX is a reserved Phase 2 seam (see `dingtalk-card.ts`).
 *
 * Delivery ACK: DingTalk's Stream gateway redelivers any callback it does not
 * get a response for within a short window, and the SDK's `onCallback` does
 * NOT auto-ACK (unlike `onEvent`). We therefore ACK each robot message
 * immediately (`DWClient.send(messageId, {status:"SUCCESS"})`) in the listener,
 * BEFORE kicking off the agent work — otherwise every message is reprocessed,
 * which duplicates agent runs and makes a redelivered PAIR fail with "Invalid
 * or expired pairing code" (its code was consumed on the first delivery).
 *
 * Conversation model:
 *  - Group chats (route_type=group) are EPHEMERAL: every message spins up a
 *    fresh random sessionId, so the agent has no cross-message memory. This
 *    keeps shared group threads stateless and avoids one user's context
 *    leaking into another's question.
 *  - 1:1 chats (route_type=user) are MULTI-TURN: the conversation reuses a
 *    stable sessionId so AgentBox restores prior history (JSONL) and the agent
 *    remembers earlier turns. The conversationId→sessionId mapping is an
 *    in-process Map (see `conversationSessions`) — intentionally NOT persisted,
 *    so a Runtime restart starts the 1:1 conversation fresh.
 *  - `/new` resets a 1:1 conversation (drops the mapping, closes the old
 *    AgentBox session). In a group it is a no-op (already ephemeral).
 */

import crypto from "node:crypto";
import type { AgentBoxManager } from "../agentbox/manager.js";
import { AgentBoxClient, type PromptOptions } from "../agentbox/client.js";
import type { ChannelHandler } from "../channel-manager.js";
import { resolveBinding, handlePairingCode, isChannelAccessDenied } from "../channel-manager.js";
import { resolveAgentSystemPrompt } from "../agent-model-binding.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";
import { sessionRegistry } from "../session-registry.js";
import { collectResponse } from "./lark.js";
import {
  buildMarkdownMessage,
  buildTextMessage,
  EMPTY_RESULT_NOTICE,
  AGENT_ERROR_NOTICE,
} from "./dingtalk-card.js";

/** Robot-message callback topic (see SDK `constants`). */
const TOPIC_ROBOT = "/v1.0/im/bot/messages/get";

/**
 * Hosts we are willing to POST agent output to. DingTalk hands us a temporary
 * `sessionWebhook` per inbound frame; the frame is authenticated, but this
 * fetch is issued by the trusted Runtime process (inside the cluster), NOT the
 * agent sandbox — so an unexpected host would be a ready-made internal SSRF /
 * data-exfiltration channel. Pin replies to the DingTalk OpenAPI domains.
 */
const ALLOWED_WEBHOOK_HOSTS = new Set(["oapi.dingtalk.com", "api.dingtalk.com"]);

function isAllowedWebhookHost(host: string): boolean {
  return ALLOWED_WEBHOOK_HOSTS.has(host) || host.endsWith(".dingtalk.com");
}

/**
 * Build a log-safe error string. The DingTalk SDK fetches its access token
 * with the AppSecret in the URL query string (`gettoken?appkey=…&appsecret=…`),
 * and an axios error object carries `config.url`, so dumping a whole error can
 * leak the secret into log collectors. We log the message only, with any
 * `appsecret`/`accessKey` query value redacted as a belt-and-braces measure.
 */
function safeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/(appsecret|appkey|accessKey|access_token)=[^&\s]+/gi, "$1=***");
}

export interface DingTalkChannelConfig {
  /** ClientID — AppKey from the DingTalk developer console. */
  client_id: string;
  /** ClientSecret — AppSecret from the DingTalk developer console. */
  client_secret: string;
}

/**
 * Shape of the robot message payload carried in `DWClientDownStream.data`
 * (a JSON string). We read only the fields the handler needs.
 */
interface DingTalkRobotMessage {
  msgtype: string;
  text?: { content?: string };
  conversationId: string;
  conversationType?: string;  // "1" = 1:1, "2" = group
  sessionWebhook: string;
  msgId?: string;
}

/**
 * In-process map of a 1:1 conversation → its current AgentBox sessionId.
 * Reused so single chats accumulate multi-turn context. Group chats never
 * touch this map (they always use a throwaway random sessionId).
 *
 * Intentionally in-memory only: a Runtime restart forgets the pointer and the
 * next 1:1 message starts a fresh session (the old JSONL history is orphaned
 * but harmless). Keyed by `${channelId}:${conversationId}`.
 */
const conversationSessions = new Map<string, string>();

function conversationSessionKey(channelId: string, conversationId: string): string {
  return `${channelId}:${conversationId}`;
}

/** Test-only helper to reset the in-memory session map between cases. */
export function resetConversationSessionsForTest(): void {
  conversationSessions.clear();
}

/**
 * Create a DingTalk channel handler for one global channel record.
 */
export function createDingTalkHandler(
  channel: Record<string, any>,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
  frontendClient?: FrontendWsClient,
): ChannelHandler {
  const channelId: string = channel.id;
  const config: DingTalkChannelConfig =
    typeof channel.config === "string"
      ? JSON.parse(channel.config)
      : channel.config;

  let client: { disconnect(): void } | null = null;

  return {
    async start() {
      let sdk: typeof import("dingtalk-stream-sdk-nodejs");
      try {
        sdk = await import("dingtalk-stream-sdk-nodejs");
      } catch {
        console.error(`[dingtalk] dingtalk-stream-sdk-nodejs not installed — skipping channel ${channelId}`);
        return;
      }

      try {
        const dwClient = new sdk.DWClient({
          clientId: config.client_id,
          clientSecret: config.client_secret,
        });

        dwClient.registerCallbackListener(TOPIC_ROBOT, (downstream) => {
          // ACK the callback IMMEDIATELY. DingTalk's Stream gateway redelivers
          // any callback it does not receive a response for within a short
          // window — and the SDK's onCallback does NOT auto-ACK (unlike
          // onEvent). Without this, every message is re-sent, causing duplicate
          // agent runs and, for PAIR, a spurious "Invalid or expired pairing
          // code" on the redelivered copy (the code was consumed on first run).
          // The ACK is independent of the reply, which still goes out over the
          // sessionWebhook once the agent finishes.
          ackDingTalkCallback(dwClient, downstream);
          // Run the actual work detached so the WS read loop is never blocked.
          setImmediate(() => {
            handleDingTalkMessage(downstream, channelId, agentBoxManager, tlsOptions, frontendClient)
              .catch((err) => {
                console.error(`[dingtalk] Error handling message for channel=${channelId}:`, err);
              });
          });
        });

        await dwClient.connect();
        client = dwClient;
        console.log(`[dingtalk] Channel started id=${channelId} client_id=${config.client_id}`);
      } catch (err) {
        // Log message only — never the whole error object: the SDK's token
        // fetch puts the AppSecret in the request URL, which axios attaches to
        // the error as `config.url`.
        console.error(`[dingtalk] Failed to start channel ${channelId}: ${safeErrorMessage(err)}`);
      }
    },

    async stop() {
      if (client) {
        try { client.disconnect(); } catch (err) {
          console.error(`[dingtalk] Error disconnecting channel ${channelId}: ${safeErrorMessage(err)}`);
        }
      }
      client = null;
      // Drop this channel's 1:1 session pointers so a stop/start cycle does not
      // leak Map entries (one per active conversation). Entries are prefixed
      // with `${channelId}:`.
      const prefix = `${channelId}:`;
      for (const key of conversationSessions.keys()) {
        if (key.startsWith(prefix)) conversationSessions.delete(key);
      }
      console.log(`[dingtalk] Channel stopped id=${channelId}`);
    },
  };
}

/**
 * ACK a DingTalk Stream callback so the gateway marks it delivered and does
 * not redeliver. Exported for unit testing. Best-effort: a missing messageId
 * or a send failure is logged, never thrown into the WS read loop.
 */
export function ackDingTalkCallback(
  client: { send(messageId: string, value: unknown): void },
  downstream: { headers?: { messageId?: string } },
): void {
  try {
    const messageId = downstream?.headers?.messageId;
    if (messageId) client.send(messageId, { status: "SUCCESS" });
  } catch (err) {
    console.error("[dingtalk] Failed to ACK callback:", err);
  }
}

// ── Message handler ────────────────────────────────────────────

/**
 * Exported for unit tests. Consumes a raw `DWClientDownStream` whose `data`
 * field is a JSON string carrying the robot message.
 */
export async function handleDingTalkMessage(
  downstream: { data?: string },
  channelId: string,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
  frontendClient?: FrontendWsClient,
): Promise<void> {
  let message: DingTalkRobotMessage;
  try {
    if (!downstream?.data) return;
    message = JSON.parse(downstream.data);
  } catch {
    return;
  }

  if (!message || message.msgtype !== "text") return;

  const conversationId = message.conversationId;
  const sessionWebhook = message.sessionWebhook;
  if (!conversationId || !sessionWebhook) return;

  // conversationType "1" = 1:1 chat; "2" = group. Only an explicit "1" gets the
  // persistent multi-turn (1:1) treatment — anything else, including a missing
  // or future value, defaults to ephemeral group routing so an unknown type can
  // never accumulate cross-message context.
  const routeType: "group" | "user" = message.conversationType === "1" ? "user" : "group";

  let text = message.text?.content;
  if (!text || text.trim().length === 0) return;
  text = text.trim();

  // Check for PAIR command.
  const pairMatch = text.match(/^PAIR\s+([A-Z0-9]{6})$/i);
  if (pairMatch) {
    const code = pairMatch[1].toUpperCase();
    const result = await handlePairingCode(code, channelId, conversationId, routeType, frontendClient!);
    await replyToDingTalk(sessionWebhook, buildTextMessage(formatPairReply(result)));
    return;
  }

  // Check for /new command — resets a 1:1 conversation's multi-turn session.
  if (/^\/new$/i.test(text)) {
    await handleNewCommand(channelId, conversationId, routeType, sessionWebhook, agentBoxManager, tlsOptions, frontendClient);
    return;
  }

  // Look up binding for this conversation.
  const binding = await resolveBinding(channelId, conversationId, frontendClient!);
  if (!binding || isChannelAccessDenied(binding)) {
    console.log(`[dingtalk] No binding for channel=${channelId} conversation=${conversationId} — ignoring`);
    return;
  }

  const agentId = binding.agentId;
  // Tenant key for the conversation's context — used as the "user" in
  // chat_sessions and session registry. Mirrors lark's `lark:<chat_id>`.
  const conversationKey = `dingtalk:${conversationId}`;

  // Group chats are ephemeral (fresh context per message); 1:1 chats reuse a
  // stable session so the agent remembers earlier turns.
  let sessionId: string;
  if (routeType === "user") {
    const key = conversationSessionKey(channelId, conversationId);
    sessionId = conversationSessions.get(key) ?? crypto.randomUUID();
    conversationSessions.set(key, sessionId);
  } else {
    sessionId = crypto.randomUUID();
  }
  sessionRegistry.remember(sessionId, conversationKey, agentId);

  console.log(`[dingtalk] Message channel=${channelId} conversation=${conversationId} type=${routeType} \u2192 agent=${agentId} session=${sessionId}: "${text.slice(0, 80)}"`);

  const handle = await agentBoxManager.getOrCreate(agentId);
  const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);

  // Apply the agent's custom system prompt (best-effort — undefined falls back
  // to the built-in default template). Note: AgentBox only applies the template
  // at session creation, so an existing 1:1 multi-turn session keeps the prompt
  // it was created with until /new.
  const systemPromptTemplate = await resolveAgentSystemPrompt(agentId, frontendClient);

  const promptOpts: PromptOptions = { text, agentId, mode: "channel", sessionId, systemPromptTemplate };
  let resultText = "";
  let agentError: Error | null = null;
  try {
    const promptResult = await client.prompt(promptOpts);
    resultText = await collectResponse(client, promptResult.sessionId, "dingtalk");
  } catch (err) {
    agentError = err instanceof Error ? err : new Error(String(err));
    console.error(`[dingtalk] Agent execution failed for session=${sessionId}:`, agentError);
  }

  // Concurrency: a 1:1 session is single-threaded in AgentBox. A second
  // message that lands while the prior turn is still running gets a 409
  // ("Session is already running") — surface a friendly "still working" notice
  // rather than a scary error, and DON'T clobber the in-flight session.
  if (agentError && isSessionBusyError(agentError)) {
    await replyToDingTalk(sessionWebhook, buildTextMessage("\u23F3 上一条消息还在处理中，请稍候再发。"));
    return;
  }

  // On failure, reply with a generic notice only — the raw error message can
  // leak internal endpoints / infra details to everyone in the chat. The full
  // error was already logged above for operators.
  const finalBody = agentError
    ? AGENT_ERROR_NOTICE
    : (resultText || EMPTY_RESULT_NOTICE);

  // Errors and the empty-result notice go out as plain text; real answers as
  // markdown so formatting (code blocks, lists, bold) renders.
  const body = agentError
    ? buildTextMessage(finalBody)
    : (resultText ? buildMarkdownMessage(finalBody) : buildTextMessage(finalBody));
  await replyToDingTalk(sessionWebhook, body);
}

/**
 * Handle the `/new` command. In a 1:1 chat it drops the stored session (so the
 * next message starts fresh) and best-effort closes the old AgentBox session
 * to free resources. In a group it is a no-op — group chats are already
 * ephemeral, so there is no accumulated context to clear.
 */
async function handleNewCommand(
  channelId: string,
  conversationId: string,
  routeType: "group" | "user",
  sessionWebhook: string,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
  frontendClient?: FrontendWsClient,
): Promise<void> {
  if (routeType !== "user") {
    await replyToDingTalk(sessionWebhook, buildTextMessage("\u2139\uFE0F 群聊为临时会话，每条消息相互独立，无需 /new。"));
    return;
  }

  const key = conversationSessionKey(channelId, conversationId);
  const oldSessionId = conversationSessions.get(key);
  conversationSessions.delete(key);

  if (oldSessionId) {
    sessionRegistry.forget(oldSessionId);
    // Best-effort: tear down the old AgentBox session so its context/resources
    // are released. Needs the bound agent to locate the right AgentBox.
    try {
      const binding = await resolveBinding(channelId, conversationId, frontendClient!);
      if (binding && !isChannelAccessDenied(binding)) {
        const handle = await agentBoxManager.getOrCreate(binding.agentId);
        const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);
        await client.closeSession(oldSessionId);
      }
    } catch (err) {
      console.error(`[dingtalk] Failed to close old session=${oldSessionId} on /new:`, err);
    }
  }

  await replyToDingTalk(sessionWebhook, buildTextMessage("\u2705 已开启新会话，之前的上下文已清空。"));
}

/**
 * True when an AgentBox prompt failed because the session is already running
 * (HTTP 409). The client wraps non-2xx responses as `AgentBox request failed:
 * <status> <body>`, so we match on the status and the server's message text.
 */
function isSessionBusyError(err: Error): boolean {
  // Anchor to the client's fixed "request failed: <status>" prefix so a bare
  // "409" appearing elsewhere in an error body can't be misreported as busy.
  return /request failed: 409\b/i.test(err.message) || /already running/i.test(err.message);
}

/**
 * Build the PAIR-command reply. DingTalk is zh-CN only, so no locale branch.
 */
function formatPairReply(
  result: { success: boolean; agentName?: string; error?: string },
): string {
  if (result.success) {
    return `\u2705 绑定成功！此会话已连接到 Agent "${result.agentName}"。`;
  }
  return `\u274C 绑定失败: ${result.error}`;
}

/**
 * POST a message body to a DingTalk `sessionWebhook` URL. The webhook is a
 * temporary, signed URL the platform hands us per incoming message, so no
 * auth header is needed. Failures are logged, never thrown into the WS loop.
 */
export async function replyToDingTalk(
  sessionWebhook: string,
  body: Record<string, unknown>,
): Promise<void> {
  // SSRF / exfil guard: this fetch runs in the trusted Runtime process (inside
  // the cluster), so we only ever POST agent output to the DingTalk OpenAPI
  // domains — never to an arbitrary host smuggled in via the downstream frame.
  let host: string;
  try {
    const parsed = new URL(sessionWebhook);
    if (parsed.protocol !== "https:") {
      console.error(`[dingtalk] Refusing non-https sessionWebhook (protocol=${parsed.protocol})`);
      return;
    }
    host = parsed.hostname;
  } catch {
    console.error("[dingtalk] Refusing to reply to a malformed sessionWebhook URL");
    return;
  }
  if (!isAllowedWebhookHost(host)) {
    console.error(`[dingtalk] Refusing to reply to an unexpected sessionWebhook host=${host}`);
    return;
  }

  try {
    const res = await fetch(sessionWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[dingtalk] sessionWebhook reply failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error(`[dingtalk] Failed to reply via sessionWebhook: ${safeErrorMessage(err)}`);
  }
}
