/**
 * Lark (飞书) channel handler.
 *
 * Connects to Lark via WebSocket-based event subscription.
 * Routes messages dynamically via channel_bindings (not hardcoded agent).
 * Supports PAIR command for binding chat groups to agents.
 */

import type { AgentBoxManager } from "../agentbox/manager.js";
import { AgentBoxClient, type PromptOptions } from "../agentbox/client.js";
import type { ChannelHandler } from "../channel-manager.js";
import {
  resolveBinding,
  setChannelContextMode,
  handlePairingCode,
  resetBindingSession,
  resolvePersonalBinding,
  handlePersonalPairingCode,
  resetPersonalSession,
  updateBindingMeta,
  updateChannelName,
  isChannelAccessDenied,
  type ResolvedChannelBinding,
  type ChannelAccessDenied,
} from "../channel-manager.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";
import { sessionRegistry } from "../session-registry.js";
import { appendMessage, bindMessageTraceId, ensureChatSession, recordChannelFeedback } from "../chat-repo.js";
import { buildRedactionConfigForModelConfig, redactText } from "../output-redactor.js";
import { resolveAgentModelBinding } from "../agent-model-binding.js";
import {
  openTypingCard,
  updateCardContent,
  finalizeCard,
  buildMilestoneCardMarkdown,
  applyFeedbackSelection,
  FEEDBACK_ACTION_KIND,
  sendModeCard,
  MODE_ACTION_KIND,
  PLACEHOLDER_BY_LOCALE,
  EMPTY_RESULT_NOTICE_BY_LOCALE,
  localeForDomain,
  type FeedbackActionValue,
  type ModeActionValue,
  type GroupContextMode,
  type LarkLocale,
} from "./lark-card.js";
import { collectImageAttachments, stripVisualBlocks, type RenderedReplyImage } from "./visual-image.js";
import { replyImageToLark } from "./lark-image.js";
import { collectInboundImages, type LarkImageRef } from "./inbound-image.js";
import { modelOptionsSupportImageInput } from "../../core/model-routing.js";
import { redactImageUrlsInText } from "../agentbox/image-url-ingest.js";
import { registerBackgroundChannelDelivery } from "./background-delivery.js";

const VISUAL_ONLY_NOTICE_BY_LOCALE = {
  "zh-CN": "已生成图片如下。",
  "en-US": "Image generated below.",
} as const;
const QUEUE_FULL_NOTICE_BY_LOCALE = {
  "zh-CN": "⏳ 当前会话还有较多消息排队处理中，请稍后再发。",
  "en-US": "⏳ This channel session already has several messages queued. Please try again later.",
} as const;
// Session is single-threaded in AgentBox: after waiting out the busy window (queue-until-idle)
// the session is still occupied (e.g. a long run_in_background exec job). Ask the user to retry
// rather than clobbering the in-flight work or dumping the raw 409.
const SESSION_BUSY_NOTICE_BY_LOCALE = {
  "zh-CN": "⏳ 还在处理上一条，请稍候再发。",
  "en-US": "⏳ Still working on the previous message — please try again shortly.",
} as const;
// Generic failure notice. The raw error can leak internal endpoints / infra to everyone in the
// chat, so we log the real error and show this instead.
const AGENT_ERROR_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 处理时出错了，请稍后重试。",
  "en-US": "❌ Something went wrong while processing this. Please try again later.",
} as const;
const NEW_SESSION_NOTICE_BY_LOCALE = {
  "zh-CN": "✅ 已开启新会话，此入口中的历史上下文已清空。",
  "en-US": "✅ Started a new session. Previous context for this channel entry has been cleared.",
} as const;
const MISSING_OWNER_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 当前群绑定缺少会话归属信息，请在 Agent 页面重新生成 PAIR code 并在群里重新绑定。",
  "en-US": "❌ This group binding is missing a session owner. Generate a fresh PAIR code from the Agent page and pair this group again.",
} as const;
const PERSONAL_BIND_REQUIRED_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 这个个人机器人需要先绑定 Sicore 账号。请打开 Sicore 的 Agent Channels 页面，点击“授权飞书账号”后再回来私聊。",
  "en-US": "❌ This personal bot requires Sicore authorization. Open the Sicore Agent Channels page, click “Authorize Feishu account”, then come back to this chat.",
} as const;
// sicore_authorized group: sender hasn't linked their Feishu account to Sicore.
const GROUP_ACCESS_UNBOUND_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 你的飞书账号还没绑定 Sicore，无法在群里使用这个助手。请打开 Sicore 的 Agent Channels 页面授权飞书账号后再试。",
  "en-US": "❌ Your Feishu account isn't linked to Sicore yet, so you can't use this assistant here. Open the Sicore Agent Channels page to authorize, then try again.",
} as const;
// sicore_authorized group: sender is linked but lacks read access to the agent.
const GROUP_ACCESS_DENIED_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 你没有这个助手的访问权限，请联系管理员授权。",
  "en-US": "❌ You don't have access to this assistant. Ask an admin to grant access.",
} as const;
// The card only ever shows the single latest step, so the milestone list is
// just an internal buffer for dedup against the previous step. Bound it anyway
// to keep memory flat if an agent over-emits.
const MILESTONE_CAP = 20;
const MAX_LARK_BINDING_QUEUE = 20;

interface QueuedLarkTask {
  run: () => Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface LarkBindingQueue {
  running: boolean;
  pending: QueuedLarkTask[];
}

const bindingQueues = new Map<string, LarkBindingQueue>();

export interface LarkChannelConfig {
  domain?: "feishu" | "lark";  // feishu = China (default), lark = Global
  app_id: string;
  app_secret: string;
  group_channel_id?: string;
  verification_token?: string;
  encrypt_key?: string;
  personal_bot?: {
    channel_id?: string;
    agent_id: string;
    access_mode: "open" | "sicore_authorized";
    owner_user_id?: string;
    authorize_url?: string;
    group_auto_bind?: boolean;
  };
}

/**
 * Create a Lark channel handler for one global channel record.
 */
export function createLarkHandler(
  channel: Record<string, any>,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
  frontendClient?: FrontendWsClient,
): ChannelHandler {
  const channelId: string = channel.id;
  const config: LarkChannelConfig =
    typeof channel.config === "string"
      ? JSON.parse(channel.config)
      : channel.config;

  let wsClient: { close(params?: { force?: boolean }): void } | null = null;

  return {
    async start() {
      let lark: typeof import("@larksuiteoapi/node-sdk");
      try {
        lark = await import("@larksuiteoapi/node-sdk");
      } catch {
        console.error(`[lark] @larksuiteoapi/node-sdk not installed — skipping channel ${channelId}`);
        return;
      }

      // domain: "lark" → open.larksuite.com (global), default → open.feishu.cn (China)
      const domain = config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
      const larkClient = new lark.Client({
        appId: config.app_id,
        appSecret: config.app_secret,
        domain,
      });

      // Fetch the bot's own open_id once at start. Group-message handling needs
      // it to tell an individual "@bot" from "@所有人": Feishu delivers @所有人
      // to an @bot-scoped app too (it mentions everyone, the bot included), so
      // at the event layer an @所有人 announcement is indistinguishable from a
      // real @bot unless we match the bot's own open_id. Best-effort: on
      // failure we fall back to @_all-exclusion (see isBotMentioned).
      let botOpenId: string | undefined;
      try {
        const botInfo: any = await (larkClient as any).request({
          method: "GET",
          url: "/open-apis/bot/v3/info",
        });
        const bot = botInfo?.bot ?? botInfo?.data?.bot;
        botOpenId = bot?.open_id;
        console.log(`[lark] Channel ${channelId} bot open_id=${botOpenId ?? "(unknown)"}`);
        // Persist the bot's real Feishu name so the Portal shows it instead of
        // the synthetic "${agent} Bot" placeholder. ONLY for per-agent personal
        // bots — a shared-app channel's name is admin-curated in the Channels
        // UI and must not be clobbered by the raw Feishu app_name on restart.
        // Best-effort + detached — a name write must never delay/fail startup.
        const appName: string | undefined = typeof bot?.app_name === "string" ? bot.app_name.trim() : undefined;
        if (appName && frontendClient && config.personal_bot) {
          updateChannelName(channelId, appName, frontendClient).catch((err) => {
            console.warn(`[lark] Could not persist bot name for channel ${channelId}: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[lark] Could not fetch bot info for channel ${channelId}; group @-mention gating falls back to @_all-exclusion: ${msg}`);
      }

      const dispatcher = new lark.EventDispatcher({
        verificationToken: config.verification_token,
        encryptKey: config.encrypt_key,
      });

      dispatcher.register({
        // Feishu's WSClient waits for this handler to resolve before it sends
        // the ACK frame back. If we hold it open while the agent runs (10-30s),
        // Feishu times out the in-flight event and redelivers — the handler
        // then runs a second time and the user sees two replies. Resolve
        // immediately and kick the actual work onto a detached task so the
        // ACK ships in <1ms and redelivery never triggers.
        "im.message.receive_v1": (data: any) => {
          setImmediate(() => {
            handleLarkMessage(data, larkClient, channelId, agentBoxManager, tlsOptions, frontendClient, localeForDomain(config.domain), config, botOpenId)
              .catch((err) => {
                console.error(`[lark] Error handling message for channel=${channelId}:`, err);
              });
          });
          return Promise.resolve();
        },
        // Card button clicks (👍/👎 feedback). The handler's return value IS
        // the callback response (toast shown to the clicker), so it resolves
        // synchronously and immediately — persistence runs detached inside the
        // handler to stay well within Feishu's ~3s callback window (see the
        // handleLarkCardAction doc comment / the 200671 fix).
        "card.action.trigger": (data: any) => {
          try {
            return handleLarkCardAction(data, larkClient, frontendClient);
          } catch (err) {
            console.error(`[lark] Error handling card action for channel=${channelId}:`, err);
            return undefined;
          }
        },
      });

      const ws = new lark.WSClient({
        appId: config.app_id,
        appSecret: config.app_secret,
      });

      try {
        await ws.start({ eventDispatcher: dispatcher });
        wsClient = ws;
        console.log(`[lark] Channel started id=${channelId} app=${config.app_id}`);
      } catch (err) {
        console.error(`[lark] Failed to start channel ${channelId}:`, err);
      }
    },

    async stop() {
      if (wsClient) wsClient.close({ force: true });
      wsClient = null;
      console.log(`[lark] Channel stopped id=${channelId}`);
    },
  };
}

export function resetLarkBindingQueuesForTest(): void {
  bindingQueues.clear();
}

function enqueueBindingTask(bindingId: string, run: () => Promise<void>): { accepted: true; done: Promise<void> } | { accepted: false } {
  let queue = bindingQueues.get(bindingId);
  if (!queue) {
    queue = { running: false, pending: [] };
    bindingQueues.set(bindingId, queue);
  }

  if (queue.pending.length >= MAX_LARK_BINDING_QUEUE) {
    return { accepted: false };
  }

  const done = new Promise<void>((resolve, reject) => {
    queue!.pending.push({ run, resolve, reject });
  });
  drainBindingQueue(bindingId);
  return { accepted: true, done };
}

function drainBindingQueue(bindingId: string): void {
  const queue = bindingQueues.get(bindingId);
  if (!queue || queue.running) return;
  const next = queue.pending.shift();
  if (!next) {
    bindingQueues.delete(bindingId);
    return;
  }

  queue.running = true;
  void (async () => {
    try {
      await next.run();
      next.resolve();
    } catch (err) {
      next.reject(err);
    } finally {
      const current = bindingQueues.get(bindingId);
      if (current) {
        current.running = false;
        drainBindingQueue(bindingId);
      }
    }
  })();
}

function getLarkSenderOpenId(data: any): string | null {
  const senderId = data?.sender?.sender_id ?? data?.event?.sender?.sender_id;
  const openId = senderId?.open_id;
  return typeof openId === "string" && openId.trim() ? openId.trim() : null;
}

function buildLarkSessionKey(senderOpenId: string | null, chatId: string): string {
  return senderOpenId ? `open_id:${senderOpenId}` : `chat:${chatId}`;
}

/**
 * Fetch the group chat title, best-effort. Only requires the bot to be a
 * member of the chat (scope im:chat:readonly) — no contacts permission.
 * Returns null on any failure (missing scope, bot kicked, SDK mock in tests).
 */
async function fetchLarkChatName(larkClient: any, chatId: string): Promise<string | null> {
  try {
    const resp: any = await larkClient.request({
      method: "GET",
      url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`,
    });
    const name = resp?.data?.name ?? resp?.name;
    return typeof name === "string" && name.trim() ? name.trim() : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[lark] Could not fetch chat name for chat=${chatId}: ${msg}`);
    return null;
  }
}

// Per-binding refresh attempts this process. A successful refresh pins the
// counter to the cap (done for this gateway lifetime — renames are picked up
// after a restart); a transient fetch failure leaves room to retry on later
// messages, bounded so a persistently-failing API isn't hammered.
const bindingNameRefreshAttempts = new Map<string, number>();
const BINDING_NAME_REFRESH_MAX_ATTEMPTS = 3;

/**
 * Fire-and-forget: refresh the binding's cached chat title when the platform
 * reports a different (or first) name. Display-only — failures are logged and
 * never affect message handling.
 */
function backfillBindingDisplayName(
  larkClient: any,
  channelId: string,
  chatId: string,
  binding: ResolvedChannelBinding,
  frontendClient: FrontendWsClient,
): void {
  const attempts = bindingNameRefreshAttempts.get(binding.bindingId) ?? 0;
  if (attempts >= BINDING_NAME_REFRESH_MAX_ATTEMPTS) return;
  // Count the attempt up front so concurrent messages can't stampede the API.
  bindingNameRefreshAttempts.set(binding.bindingId, attempts + 1);
  void (async () => {
    const name = await fetchLarkChatName(larkClient, chatId);
    if (!name) return; // transient failure — later messages may retry up to the cap
    bindingNameRefreshAttempts.set(binding.bindingId, BINDING_NAME_REFRESH_MAX_ATTEMPTS);
    if (name === binding.displayName) return;
    try {
      await updateBindingMeta(channelId, chatId, name, frontendClient);
      console.log(`[lark] Binding name refreshed channel=${channelId} chat=${chatId} name="${name}"`);
    } catch (err) {
      console.warn(`[lark] Failed to update binding name for chat=${chatId}:`, err);
    }
  })();
}

const MODE_LABEL_BY_LOCALE: Record<LarkLocale, Record<GroupContextMode, string>> = {
  "zh-CN": { shared: "团队模式(全群共享上下文)", per_user: "个人模式(各自独立上下文)" },
  "en-US": { shared: "Team mode (shared context)", per_user: "Personal mode (per-user context)" },
};

const MODE_TOAST_BY_LOCALE: Record<LarkLocale, { ok: (m: GroupContextMode) => string; fail: string }> = {
  "zh-CN": {
    ok: (m) => `已切换为${m === "shared" ? "团队模式" : "个人模式"}`,
    fail: "切换失败,请重试。",
  },
  "en-US": {
    ok: (m) => `Switched to ${m === "shared" ? "Team" : "Personal"} mode`,
    fail: "Couldn't switch mode. Please try again.",
  },
};

const MODE_ANNOUNCE_BY_LOCALE: Record<LarkLocale, (m: GroupContextMode) => string> = {
  "zh-CN": (m) =>
    m === "shared"
      ? `本群已切换为${MODE_LABEL_BY_LOCALE["zh-CN"].shared};之后大家的消息按全群共享处理。`
      : `本群已切换为${MODE_LABEL_BY_LOCALE["zh-CN"].per_user};之后每个人各自独立对话。`,
  "en-US": (m) =>
    m === "shared"
      ? `This group is now in ${MODE_LABEL_BY_LOCALE["en-US"].shared}; messages are handled as one shared conversation.`
      : `This group is now in ${MODE_LABEL_BY_LOCALE["en-US"].per_user}; each person now talks to the bot separately.`,
};

const MODE_UNBOUND_NOTICE_BY_LOCALE: Record<LarkLocale, string> = {
  "zh-CN": "❌ 本群还没绑定助手,无法设置上下文模式。请先用 PAIR 绑定。",
  "en-US": "❌ This group isn't bound to an assistant yet, so there's no context mode to set. Pair it first.",
};

// Shared groups use one group-level session, so a single member's /new would
// wipe everyone's context — disallowed. A confirmed "reset the whole room" is a
// future, confirmation-gated action; for now, point the user at their options.
const SHARED_NEW_REJECTED_NOTICE_BY_LOCALE: Record<LarkLocale, string> = {
  "zh-CN": "团队模式(全群共享上下文)不支持单人重置——一个人 /new 会清空整群的上下文。如需独立对话,请用 /mode 切换为个人模式,或另建一个群。",
  "en-US": "Team mode (shared group context) doesn't support a per-person /new — one reset would wipe the whole group's context. For a private thread, switch to Personal mode with /mode, or start a separate group.",
};

const FEEDBACK_TOAST_BY_LOCALE: Record<LarkLocale, { ok: string; fail: string }> = {
  "zh-CN": { ok: "已收到你的反馈，谢谢！", fail: "反馈记录失败，请稍后再试。" },
  "en-US": { ok: "Feedback recorded — thanks!", fail: "Could not record feedback. Please try again." },
};

/**
 * Handle a `card.action.trigger` callback. Only feedback buttons (our
 * FEEDBACK_ACTION_KIND discriminator) are processed; anything else returns
 * undefined so future card actions can add their own handling.
 *
 * The return value is the card-callback response Feishu shows as a toast.
 * Feishu enforces a hard ~3s budget on that response measured END-TO-END
 * (its edge → this pod → back). We MUST NOT block it on the persist RPC:
 * persistence hops to Portal/sicore over WS, and that latency plus the two
 * network legs intermittently blew the 3s budget — Feishu then rejected an
 * otherwise-valid response with business error 200671, even though the vote
 * had already been written. So respond OPTIMISTICALLY and immediately, and
 * run persistence + the button-state echo fully detached. Feedback is
 * best-effort (and confirmed reliable in practice); a rare persist failure is
 * logged rather than surfaced, which is strictly better than showing 200671
 * on a click that did save.
 */
export function handleLarkCardAction(
  data: any,
  larkClient: any,
  frontendClient?: FrontendWsClient,
): { toast: { type: string; content: string } } | undefined {
  // EventDispatcher flattens `event.*` onto the top level (same as messages).
  // Some Feishu/CardKit versions deliver `action.value` as a JSON string
  // rather than a parsed object — accept both so a click doesn't silently
  // no-op on those clients.
  const rawValue = data?.action?.value;
  let value: { kind?: string; [k: string]: unknown } | undefined;
  if (typeof rawValue === "string") {
    try { value = JSON.parse(rawValue); } catch { value = undefined; }
  } else {
    value = rawValue as { kind?: string } | undefined;
  }
  if (!value) return undefined;

  // Context-mode switch buttons take the same self-contained-value + optimistic
  // toast + detached side-effect shape as feedback (200671 discipline).
  if (value.kind === MODE_ACTION_KIND) {
    return handleModeSwitchAction(value as Partial<ModeActionValue>, data, larkClient, frontendClient);
  }

  if (value.kind !== FEEDBACK_ACTION_KIND) return undefined;
  const fb = value as Partial<FeedbackActionValue>;

  const locale: LarkLocale = fb.locale === "en-US" ? "en-US" : "zh-CN";
  const toasts = FEEDBACK_TOAST_BY_LOCALE[locale];
  const rating = fb.rating === "up" || fb.rating === "down" ? fb.rating : null;
  const operatorOpenId: string | undefined = data?.operator?.open_id;
  if (!rating || !fb.session_id || !fb.card_id || !operatorOpenId) {
    console.warn(`[lark] Dropping malformed feedback action card=${fb.card_id ?? "?"} rating=${fb.rating ?? "?"} operator=${operatorOpenId ?? "?"}`);
    return { toast: { type: "error", content: toasts.fail } };
  }
  const { session_id: sessionId, card_id: cardId, channel_id: channelId } = fb;

  // Detached: persist the vote, then echo the button highlight. Neither is on
  // the callback-response critical path (see the 3s-budget note above).
  void (async () => {
    try {
      const result = await recordChannelFeedback({
        sessionId,
        messageRef: cardId,
        rating,
        senderExternalId: operatorOpenId,
        channelId: channelId ?? null,
        source: "lark",
      });
      if (!result?.success) {
        console.warn(`[lark] Feedback persist rejected card=${cardId}: ${result?.error ?? "unknown"}`);
        return;
      }
      console.log(`[lark] Feedback recorded card=${cardId} session=${sessionId} rating=${rating} sender=${operatorOpenId}`);
      // Cosmetic: highlight the chosen button. Never rejects (best-effort boolean).
      void applyFeedbackSelection(larkClient, fb as FeedbackActionValue, rating);
    } catch (err) {
      console.error(`[lark] Feedback persist failed card=${cardId}:`, err);
    }
  })();

  return { toast: { type: "success", content: toasts.ok } };
}

/**
 * Handle a context-mode switch button. Responds with an optimistic toast and
 * runs persistence + the group announcement fully detached (Feishu's ~3s
 * callback budget — same reasoning as feedback). Any group member may switch;
 * the visible announcement is the social control (design decision), and it also
 * tells everyone the conversation just reset.
 */
function handleModeSwitchAction(
  value: Partial<ModeActionValue>,
  data: any,
  larkClient: any,
  frontendClient?: FrontendWsClient,
): { toast: { type: string; content: string } } {
  const locale: LarkLocale = value.locale === "en-US" ? "en-US" : "zh-CN";
  const toasts = MODE_TOAST_BY_LOCALE[locale];
  const mode: GroupContextMode | null =
    value.mode === "shared" ? "shared" : value.mode === "per_user" ? "per_user" : null;
  if (!mode || !value.channel_id || !value.route_key) {
    console.warn(`[lark] Dropping malformed mode action channel=${value.channel_id ?? "?"} mode=${value.mode ?? "?"}`);
    return { toast: { type: "error", content: toasts.fail } };
  }
  const channelId = value.channel_id;
  const routeKey = value.route_key;

  // Optimistically flip the runtime's own view now: drop the old buffer + cache
  // and record the new mode, so THIS runtime stops/starts retaining chatter
  // immediately (no wait on the persist round-trip).
  forgetGroupState(channelId, routeKey);
  rememberGroupMode(channelId, routeKey, mode);

  void (async () => {
    try {
      const result = await setChannelContextMode(channelId, routeKey, mode, frontendClient);
      if (!result?.success) {
        console.warn(`[lark] Mode switch persist rejected chat=${routeKey}: ${result?.error ?? "unknown"}`);
        return;
      }
      console.log(`[lark] Context mode set chat=${routeKey} mode=${mode}`);
      // Announce in the group — audit trail + everyone learns the reset.
      await larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: routeKey,
          msg_type: "text",
          content: JSON.stringify({ text: MODE_ANNOUNCE_BY_LOCALE[locale](mode) }),
        },
      });
    } catch (err) {
      console.error(`[lark] Mode switch failed chat=${routeKey}:`, err);
    }
  })();

  return { toast: { type: "success", content: toasts.ok(mode) } };
}

/**
 * Whether a group message is actually directed at THIS bot.
 *
 * Feishu delivers a group message to an app scoped to "receive @bot messages"
 * whenever the bot is mentioned — but "@所有人" (@all) mentions *everyone*, the
 * bot included, so an @所有人 announcement is delivered too and looks identical
 * to a real @bot at the event layer. We must match the bot's own open_id:
 * "@所有人" carries key "@_all" and never the bot's open_id, so a strict
 * open_id match excludes it (and any "@someone-else").
 *
 * Degraded path — bot-info fetch failed, so `botOpenId` is unknown: we can't
 * positively identify the bot, but we can still drop "@所有人" explicitly by
 * its "@_all" key. This kills the reported announcement-spam case without
 * muting the bot when its open_id couldn't be resolved.
 */
function isBotMentioned(message: any, botOpenId?: string): boolean {
  const mentions = message?.mentions as
    | Array<{ id?: { open_id?: string }; key?: string }>
    | undefined;
  if (!mentions || mentions.length === 0) return false;
  if (botOpenId) return mentions.some((m) => m.id?.open_id === botOpenId);
  return mentions.some((m) => m.key !== "@_all");
}

/**
 * Placeholder text for an image-only message (no caption). Keeps the user
 * message row, session title, and prompt non-empty so the audit transcript
 * still shows "user sent image(s)".
 */
const IMAGE_ONLY_PLACEHOLDER = "[image]";

/**
 * Pull the user text and any inbound image references out of a Feishu message.
 * This is the ONLY place message content is parsed — `imageRefs` is carried
 * through the queue as a structured value (no re-parse downstream).
 *
 *   - text  → `content.text`
 *   - image → `content.image_key`
 *   - post  → rich text whose `content` is a `Node[][]` (array of paragraphs of
 *             nodes); flatten and split by `tag`: img → image_key, text → text.
 *
 * Unknown types yield empty text + no refs (caller drops them).
 */
export function extractInbound(message: any): { text: string; imageRefs: LarkImageRef[] } {
  const msgType: string = message?.message_type;
  let raw: any;
  try {
    raw = JSON.parse(message?.content ?? "");
  } catch {
    return { text: "", imageRefs: [] };
  }

  if (msgType === "text") {
    return { text: stripMentions(typeof raw?.text === "string" ? raw.text : ""), imageRefs: [] };
  }

  if (msgType === "image") {
    const imageKey = typeof raw?.image_key === "string" ? raw.image_key : null;
    return { text: "", imageRefs: imageKey ? [{ imageKey }] : [] };
  }

  if (msgType === "post") {
    const imageRefs: LarkImageRef[] = [];
    const textParts: string[] = [];
    // Post content is normally delivered flat as `{ title, content: Node[][] }`,
    // but some Feishu API/SDK versions deliver the locale-nested send-shape
    // `{ zh_cn: { title, content }, en_us: {…} }` on receive — accept both so a
    // nested payload is not silently dropped (it would otherwise yield neither
    // text nor image and the whole turn would be discarded).
    const post = Array.isArray(raw?.content) ? raw : firstLocalePost(raw);
    if (typeof post?.title === "string" && post.title) textParts.push(post.title);
    const paragraphs: any[][] = Array.isArray(post?.content) ? post.content : [];
    for (const node of paragraphs.flat()) {
      if (node?.tag === "img" && typeof node?.image_key === "string") {
        imageRefs.push({ imageKey: node.image_key });
      } else if ((node?.tag === "text" || node?.tag === "a") && typeof node?.text === "string") {
        textParts.push(node.text);
      }
      // A hyperlink's href may itself be an image URL — surface it so the unified
      // text-URL resolver (AgentBoxClient.prompt) can pick it up.
      if (node?.tag === "a" && typeof node?.href === "string") {
        textParts.push(node.href);
      }
    }
    return { text: stripMentions(textParts.join(" ")), imageRefs };
  }

  return { text: "", imageRefs: [] };
}

function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, "").trim();
}

/** Feishu post may arrive locale-nested as `{ zh_cn: { content: Node[][] } }`;
 *  pick the first locale block that carries a `content` array. */
function firstLocalePost(raw: any): any {
  if (!raw || typeof raw !== "object") return undefined;
  for (const v of Object.values(raw)) {
    if (v && typeof v === "object" && Array.isArray((v as any).content)) return v;
  }
  return undefined;
}

// ── Group context mode (shared vs per_user) ──────────────────────
//
// The server (portal adapter) owns the shared-vs-isolated decision and encodes
// it in the session key it returns; the runtime only needs the mode to decide
// whether to RETAIN non-@ chatter. Two pieces of runtime-local state support
// that, both keyed by `${channelId}:${chatId}` and both intentionally
// process-memory only (a channel app holds one long connection from one
// runtime, so there is no cross-process buffer to reconcile; a restart drops
// un-drained chatter — a bounded, documented loss).

// Cache of each group's mode, populated on every @-turn's resolveBinding so the
// non-@ ingestion gate costs no RPC. Short TTL; an in-group /mode switch busts
// the entry immediately.
const GROUP_MODE_TTL_MS = 60_000;
const groupModeCache = new Map<string, { mode: GroupContextMode; at: number }>();

// Discussion buffer for shared groups: non-@ chatter accumulated per group and
// drained into the next @-turn's prompt. Bounded by count AND chars so a busy
// group can't blow up memory or the prompt; `truncated` records that older
// lines were dropped so the agent can be told the transcript is partial.
const DISCUSSION_BUFFER_MAX_MSGS = 100;
const DISCUSSION_BUFFER_MAX_CHARS = 8000;
interface DiscussionLine { sender: string; text: string; }
const discussionBuffers = new Map<string, { lines: DiscussionLine[]; truncated: boolean }>();

// Both maps are keyed by group and bounded per entry (mode = one small record;
// buffer = the MAX_MSGS/MAX_CHARS caps). This bounds the NUMBER of groups too,
// so a bot in very many groups can't grow either map without limit — evicting
// the oldest (insertion-ordered) entry, same shape as the feedback echo cache.
const GROUP_STATE_MAX = 2000;

function evictOldestIfFull<K, V>(map: Map<K, V>, cap: number, incomingKey: K): void {
  if (map.has(incomingKey) || map.size < cap) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

function groupStateKey(channelId: string, chatId: string): string {
  return `${channelId}:${chatId}`;
}

function rememberGroupMode(channelId: string, chatId: string, mode: GroupContextMode): void {
  const key = groupStateKey(channelId, chatId);
  evictOldestIfFull(groupModeCache, GROUP_STATE_MAX, key);
  groupModeCache.set(key, { mode, at: Date.now() });
}

/** Fresh cached mode, or undefined on miss/expiry. Never guesses — an unknown
 *  group is treated as "not confirmed shared", so its chatter is NOT retained. */
function cachedGroupMode(channelId: string, chatId: string): GroupContextMode | undefined {
  const key = groupStateKey(channelId, chatId);
  const entry = groupModeCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > GROUP_MODE_TTL_MS) {
    groupModeCache.delete(key);
    return undefined;
  }
  return entry.mode;
}

/** Drop cached mode + any buffered chatter for a group (used on a /mode switch). */
function forgetGroupState(channelId: string, chatId: string): void {
  const key = groupStateKey(channelId, chatId);
  groupModeCache.delete(key);
  discussionBuffers.delete(key);
}

function appendDiscussion(channelId: string, chatId: string, sender: string, text: string): void {
  const key = groupStateKey(channelId, chatId);
  evictOldestIfFull(discussionBuffers, GROUP_STATE_MAX, key);
  const buf = discussionBuffers.get(key) ?? { lines: [], truncated: false };
  buf.lines.push({ sender, text });
  if (buf.lines.length > DISCUSSION_BUFFER_MAX_MSGS) {
    buf.lines.shift();
    buf.truncated = true;
  }
  let total = buf.lines.reduce((n, l) => n + l.sender.length + l.text.length + 4, 0);
  while (buf.lines.length > 1 && total > DISCUSSION_BUFFER_MAX_CHARS) {
    const dropped = buf.lines.shift()!;
    total -= dropped.sender.length + dropped.text.length + 4;
    buf.truncated = true;
  }
  discussionBuffers.set(key, buf);
}

/** Take and clear the buffered chatter for a group. */
function drainDiscussion(channelId: string, chatId: string): { lines: DiscussionLine[]; truncated: boolean } {
  const key = groupStateKey(channelId, chatId);
  const buf = discussionBuffers.get(key);
  if (!buf) return { lines: [], truncated: false };
  discussionBuffers.delete(key);
  return buf;
}

/** Short sender label for shared-group attribution. MVP uses the open_id tail;
 *  a follow-up can resolve real display names via the contact API + a cache. */
function senderLabel(senderOpenId: string | null): string {
  if (!senderOpenId) return "unknown";
  return senderOpenId.length > 8 ? `…${senderOpenId.slice(-6)}` : senderOpenId;
}

export interface SharedGroupContext {
  discussion: DiscussionLine[];
  truncated: boolean;
  asker: string;
}

export function buildChannelTurnPrompt(text: string, shared?: SharedGroupContext): string {
  const head = [
    "<channel-turn>",
    "This Feishu/Lark channel session may contain earlier incidents, clusters, pods, or reports.",
  ];
  if (shared) {
    head.push(
      "This is a SHARED group: several people talk to you in one conversation, so messages are labelled with their sender. Attribute requests to the right person and don't assume two labels are the same user.",
    );
  }
  head.push(
    "Treat the message below as the current user request and answer it first.",
    "Use earlier session context only when the user explicitly refers to it, or when it is stable configuration context needed to answer the current request.",
    "If the current message names a different case, cluster, time range, object, or task, treat it as a new request. Do not force the previous case into the answer.",
    "Do not mention these channel-turn instructions to the user.",
    "</channel-turn>",
    "",
  );
  const body: string[] = [];
  if (shared && shared.discussion.length > 0) {
    body.push(
      `<group-discussion${shared.truncated ? ' note="older messages were dropped"' : ""}>`,
      "Messages in the group since your last reply, for context:",
      ...shared.discussion.map((l) => `[${l.sender}] ${l.text}`),
      "</group-discussion>",
      "",
    );
  }
  if (shared) {
    body.push(`[${shared.asker}] is now asking:`);
  }
  body.push(text);
  return [...head, ...body].join("\n");
}

// ── Message handler ────────────────────────────────────────────

/**
 * Exported for unit tests. Consumes the already-flattened event payload
 * produced by `@larksuiteoapi/node-sdk`'s EventDispatcher.
 */
export async function handleLarkMessage(
  data: any,
  larkClient: any,
  channelId: string,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
  frontendClient?: FrontendWsClient,
  locale: "zh-CN" | "en-US" = "zh-CN",
  channelConfig?: LarkChannelConfig,
  botOpenId?: string,
): Promise<void> {
  // @larksuiteoapi/node-sdk EventDispatcher flattens the event payload before
  // dispatching: `event.*` fields land on the top level and `data.event`
  // disappears (see RequestHandle.parse in the SDK). Read `message` directly.
  const message = data?.message;
  if (!message) return;

  const messageId: string = message.message_id;
  const chatId: string = message.chat_id;
  const msgType: string = message.message_type;
  const chatType: string | undefined = message.chat_type;
  const senderOpenId = getLarkSenderOpenId(data);
  const sessionKey = buildLarkSessionKey(senderOpenId, chatId);

  // Raw receipt log: fires for EVERY delivered event before any drop, so a
  // group message that arrives but is filtered (non-text, empty after @-strip)
  // is still visible. Lets us tell "never delivered" from "silently dropped".
  console.log(`[lark] recv event chat=${chatId} chat_type=${chatType} msg_type=${msgType} sender=${senderOpenId ?? "?"} channelCfg=${channelId}`);

  // Accept text, native image, and rich-text (post, may embed images). Other
  // types (audio/file/sticker/…) are still dropped.
  if (msgType !== "text" && msgType !== "image" && msgType !== "post") return;

  const { text, imageRefs } = extractInbound(message);
  // Drop only when there is neither text NOR an image — an image-only message
  // has empty text but must continue.
  if (text.length === 0 && imageRefs.length === 0) return;

  const personalBot = channelConfig?.personal_bot;
  const personalChannelId = personalBot?.channel_id ?? channelId;
  const groupChannelId = channelConfig?.group_channel_id ?? (personalBot ? null : channelId);
  if (chatType === "p2p") {
    if (!personalBot) {
      console.log(`[lark] Ignoring p2p message for non-personal channel=${channelId}`);
      return;
    }
    if (!senderOpenId) {
      await replyToLark(larkClient, messageId, "❌ Missing Feishu sender open_id.");
      return;
    }
    const pairMatch = text.match(/^PAIR\s+([A-Z0-9]{6})$/i);
    if (pairMatch) {
      if (personalBot.access_mode !== "sicore_authorized") {
        await replyToLark(larkClient, messageId, locale === "en-US"
          ? "This open personal bot does not require PAIR."
          : "这个公开个人机器人不需要 PAIR。");
        return;
      }
      const code = pairMatch[1].toUpperCase();
      const result = await handlePersonalPairingCode(code, personalChannelId, senderOpenId, frontendClient!);
      await replyToLark(larkClient, messageId, formatPersonalPairReply(result, locale));
      return;
    }

    const binding = await resolvePersonalBinding(personalChannelId, senderOpenId, frontendClient!);
    if (!binding) {
      if (personalBot.access_mode === "sicore_authorized") {
        await replyToLark(larkClient, messageId, formatPersonalBindRequiredReply(personalBot.authorize_url, locale));
      } else {
        console.log(`[lark] No personal binding for open channel=${channelId} sender=${senderOpenId}`);
      }
      return;
    }

    const personalSessionKey = binding.sessionKey ?? `open_id:${senderOpenId}`;
    const queueKey = `${binding.bindingId}:${personalSessionKey}`;
    const queued = enqueueBindingTask(queueKey, () => processQueuedLarkMessage({
      text,
      imageRefs,
      messageId,
      chatId,
      senderOpenId,
      sessionKey: personalSessionKey,
      channelId: personalChannelId,
      route: "personal",
      larkClient,
      agentBoxManager,
      tlsOptions,
      frontendClient,
      locale,
    }));
    if (!queued.accepted) {
      await replyToLark(larkClient, messageId, QUEUE_FULL_NOTICE_BY_LOCALE[locale]);
      return;
    }
    await queued.done;
    return;
  }

  if (!groupChannelId) {
    console.log(`[lark] Ignoring group message for personal-only channel=${channelId}`);
    return;
  }

  // Check for PAIR command
  const pairMatch = text.match(/^PAIR\s+([A-Z0-9]{6})$/i);
  if (pairMatch) {
    const code = pairMatch[1].toUpperCase();
    // Seed the binding's display name with the group title (best-effort).
    const chatName = await fetchLarkChatName(larkClient, chatId);
    const result = await handlePairingCode(code, groupChannelId, chatId, "group", frontendClient!, chatName ?? undefined);

    const replyText = formatPairReply(result, locale);
    await replyToLark(larkClient, messageId, replyText);
    return;
  }

  // /mode — summon the context-mode switch card. Handled before the @-gate so
  // it works with or without an @bot (like PAIR); command words are exact.
  if (/^\/mode$/i.test(text.trim())) {
    const modeBinding = await resolveBinding(groupChannelId, chatId, frontendClient!, sessionKey, senderOpenId ?? undefined);
    if (isChannelAccessDenied(modeBinding)) {
      await replyToLark(larkClient, messageId, formatGroupAccessDeniedReply(modeBinding, locale));
      return;
    }
    if (!modeBinding) {
      await replyToLark(larkClient, messageId, MODE_UNBOUND_NOTICE_BY_LOCALE[locale]);
      return;
    }
    const current: GroupContextMode = modeBinding.contextMode === "shared" ? "shared" : "per_user";
    rememberGroupMode(groupChannelId, chatId, current);
    const sent = await sendModeCard(larkClient, messageId, current, groupChannelId, chatId, locale);
    if (!sent) {
      await replyToLark(larkClient, messageId, `${MODE_LABEL_BY_LOCALE[locale][current]}`);
    }
    return;
  }

  // Only respond when THIS bot is individually @-mentioned. Feishu also
  // delivers "@所有人" to an @bot-scoped app (it mentions everyone, the bot
  // included), so an @所有人 announcement arrives looking just like a real
  // @bot — without this gate the bot replies to group-wide announcements that
  // were never aimed at it. Skips "@所有人" and "@someone-else"; PAIR above is
  // exempt (explicit command). Gated on chat_type==="group" so the binding/
  // access checks below stay reachable only for messages aimed at the bot.
  if (chatType === "group" && !isBotMentioned(message, botOpenId)) {
    // Non-@ group message. In a group KNOWN to be shared, retain it as passive
    // discussion context for the next @-turn — WITHOUT running the agent or
    // touching the AgentBox (idle pods must not be woken by group chatter).
    // In a per_user group, or one whose mode we haven't confirmed shared,
    // drop it immediately: privacy discipline — only a confirmed-shared group
    // may retain chatter (the receive-all-messages scope is app-level, so the
    // bot sees chatter from groups it must not buffer).
    if (text.length > 0 && cachedGroupMode(groupChannelId, chatId) === "shared") {
      appendDiscussion(groupChannelId, chatId, senderLabel(senderOpenId), text);
      console.log(`[lark] Buffered non-@ discussion for shared group chat=${chatId}`);
    } else {
      console.log(`[lark] Group message not directed at bot (chat=${chatId}) — ignoring (@所有人 / @others / no @bot)`);
    }
    return;
  }

  // Look up binding for this chat. Pass sender_open_id so the Portal can
  // auto-bind / per-sender resolve group bots and pick the session key.
  const binding = await resolveBinding(groupChannelId, chatId, frontendClient!, sessionKey, senderOpenId ?? undefined);
  if (isChannelAccessDenied(binding)) {
    // sicore_authorized group: this sender isn't allowed. Feishu only delivers
    // @-mentioned group messages, so the message is already directed at the bot
    // — a single short hint is fine, not spam.
    await replyToLark(larkClient, messageId, formatGroupAccessDeniedReply(binding, locale));
    return;
  }
  if (!binding) {
    console.log(`[lark] No binding for channel=${groupChannelId} chat=${chatId} — ignoring`);
    // Don't spam the group with "not paired" for every message.
    // Only reply if the message looks like it's directed at the bot (@mention).
    return;
  }

  // Keep the binding's cached group title fresh (display-only, detached).
  backfillBindingDisplayName(larkClient, groupChannelId, chatId, binding, frontendClient!);

  // Use the SERVER-authoritative session key (not the local open_id default) for
  // both the queue and the queued context, so the two-path contract holds:
  //   - open group     → open_id:<sender>  (per-sender: concurrent + isolated)
  //   - authorized group → sicore_user:<id> (per-user)
  //   - legacy single binding session → "" (binding-level queue + /new reset)
  // /new then resets the right session, and same-session senders serialize.
  // Cache the group's mode so the non-@ ingestion gate can decide whether to
  // retain chatter without an RPC per message. Only an explicit "shared" is
  // shared; an absent field (e.g. an older portal) is treated as per_user so we
  // never buffer chatter for a group we can't confirm is shared (privacy-safe).
  const contextMode: GroupContextMode = binding.contextMode === "shared" ? "shared" : "per_user";
  // If the mode changed out of band (a console switch, or another actor) since
  // we last cached it, drop any buffered chatter — it belonged to the previous
  // mode and must not resurface (e.g. after a per_user detour back to shared).
  const cachedMode = cachedGroupMode(groupChannelId, chatId);
  if (cachedMode && cachedMode !== contextMode) forgetGroupState(groupChannelId, chatId);
  rememberGroupMode(groupChannelId, chatId, contextMode);

  const effectiveSessionKey = binding.sessionKey ?? "";
  const queueKey = `${binding.bindingId}:${binding.sessionKey ?? "__binding__"}`;
  const queued = enqueueBindingTask(queueKey, () => processQueuedLarkMessage({
    text,
    imageRefs,
    messageId,
    chatId,
    senderOpenId,
    sessionKey: effectiveSessionKey,
    channelId: groupChannelId,
    route: "group",
    contextMode,
    larkClient,
    agentBoxManager,
    tlsOptions,
    frontendClient,
    locale,
  }));
  if (!queued.accepted) {
    await replyToLark(larkClient, messageId, QUEUE_FULL_NOTICE_BY_LOCALE[locale]);
    return;
  }
  await queued.done;
}

interface QueuedLarkMessageContext {
  text: string;
  imageRefs: LarkImageRef[];
  messageId: string;
  chatId: string;
  senderOpenId: string | null;
  sessionKey: string;
  channelId: string;
  route: "group" | "personal";
  /** Group route only: "shared" drains the discussion buffer into the prompt
   *  and attributes the asker; absent/"per_user" behaves as an isolated chat. */
  contextMode?: GroupContextMode;
  larkClient: any;
  agentBoxManager: AgentBoxManager;
  tlsOptions?: { cert: string; key: string; ca: string };
  frontendClient?: FrontendWsClient;
  locale: "zh-CN" | "en-US";
}

async function processQueuedLarkMessage(ctx: QueuedLarkMessageContext): Promise<void> {
  const {
    text,
    imageRefs,
    messageId,
    chatId,
    senderOpenId,
    sessionKey,
    channelId,
    route,
    contextMode,
    larkClient,
    agentBoxManager,
    tlsOptions,
    frontendClient,
    locale,
  } = ctx;

  if (/^\/new$/i.test(text)) {
    // A shared group has ONE group-level session, so a single member's /new
    // would clear everyone's context — reject it instead of resetting. (A
    // confirmation-gated "reset the whole room" is deferred.) per_user groups
    // and personal chats reset the caller's own session as before.
    if (contextMode === "shared") {
      await replyToLark(larkClient, messageId, SHARED_NEW_REJECTED_NOTICE_BY_LOCALE[locale]);
      return;
    }
    await handleNewCommand(route, channelId, chatId, sessionKey, messageId, larkClient, agentBoxManager, tlsOptions, frontendClient, locale);
    return;
  }

  // After the command branch (matched on the raw text): an image whose caption
  // is exactly a command word (e.g. "/new") is routed as that command and its
  // image dropped — an accepted edge, since commands are exact-match only.
  // An image-only message has empty text, so give it a placeholder. Replace
  // `text` uniformly here (not just in promptOpts) so the session title,
  // persisted user row, and logs all show "user sent image(s)".
  const effectiveText = text.length === 0 && imageRefs.length > 0 ? IMAGE_ONLY_PLACEHOLDER : text;

  const binding = await resolveQueuedBinding(route, channelId, chatId, senderOpenId, frontendClient!, sessionKey);
  if (!binding) {
    console.log(`[lark] Binding disappeared before queued run channel=${channelId} chat=${chatId} route=${route}`);
    return;
  }
  if (!binding.createdBy) {
    await replyToLark(larkClient, messageId, MISSING_OWNER_NOTICE_BY_LOCALE[locale]);
    return;
  }

  const agentId = binding.agentId;
  const sessionId = binding.sessionId;
  sessionRegistry.remember(sessionId, binding.createdBy, agentId);
  // Channel audit actor (NOT runtime identity — that stays `createdBy` via
  // remember() above). The sender's raw open_id is the "same person" key for
  // channel audit; it is stamped on the SESSION (chat_sessions), never falls
  // back to the binding owner. open_id is NULL when the event omits it.
  const senderExternalId = senderOpenId ?? null;

  console.log(`[lark] Message channel=${channelId} chat=${chatId} sender=${senderOpenId ?? "unknown"} → agent=${agentId} session=${sessionId}: "${effectiveText.slice(0, 80)}" images=${imageRefs.length}`);

  // Persist with signed-URL credentials stripped (the prompt still uses the full
  // URL — see promptText below — so resolution is unaffected). Keeps DB rows /
  // session title free of plaintext Signature/AccessKeyId.
  const persistedText = redactImageUrlsInText(effectiveText);
  let promptMessageId: string;
  try {
    await ensureChatSession(sessionId, agentId, binding.createdBy, persistedText, persistedText, "channel", undefined, { senderExternalId, channelId });
    promptMessageId = await appendMessage({
      sessionId,
      role: "user",
      content: persistedText,
      metadata: { source: "lark", channelId, chatId, messageId, bindingId: binding.bindingId, senderOpenId, sessionKey, route },
    });
  } catch (err) {
    console.error(`[lark] Failed to persist channel user message session=${sessionId}:`, err);
    await replyToLark(larkClient, messageId, `❌ ${err instanceof Error ? err.message : String(err)}`.slice(0, 500));
    return;
  }

  // Open the typing-indicator card FIRST so the user sees immediate feedback.
  // If the CardKit APIs fail we fall back to posting a plain text reply
  // once the agent is done (preserves the pre-card behaviour).
  const cardSession = await openTypingCard(larkClient, messageId, PLACEHOLDER_BY_LOCALE[locale]);
  let deliveredTextChars = 0;
  // Live "current step" indicator. Two milestone sources feed it: explicit
  // channel_update tool calls (agent-curated) AND auto-derived first lines of
  // intermediate assistant turns (collectChannelResponse.onMilestone). The card
  // shows ONLY the single latest step (⏳), replaced in place as work proceeds —
  // no accumulating checklist — and on finalize the step is replaced entirely by
  // the conclusion. `milestones` is kept only to dedup against the last step;
  // renders use the latest entry. Re-renders are coalesced to respect Feishu's
  // update rate.
  const milestones: string[] = [];
  let cardFlushInflight = false;
  let cardFlushDirty = false;
  let cardFinalizing = false;
  let cardFlushPromise: Promise<void> | null = null;
  const flushMilestoneCard = (): Promise<void> => {
    if (!cardSession || cardFinalizing) return Promise.resolve();
    if (cardFlushInflight) { cardFlushDirty = true; return cardFlushPromise ?? Promise.resolve(); }
    cardFlushInflight = true;
    cardFlushPromise = (async () => {
      try {
        do {
          cardFlushDirty = false;
          // Render only the single latest step — never an accumulating list.
          const md = buildMilestoneCardMarkdown({ milestones: milestones.slice(-1) });
          if (md.trim()) await updateCardContent(larkClient, cardSession, md);
        } while (cardFlushDirty && !cardFinalizing);
      } catch (err) {
        console.warn(`[lark] milestone card flush failed for session=${sessionId}:`, err);
      } finally {
        cardFlushInflight = false;
      }
    })();
    return cardFlushPromise;
  };
  // Returns a promise the channel_update path awaits (deterministic delivered
  // bool); the narration onMilestone path ignores it (must not block the SSE
  // loop). Bursts coalesce — a flush in flight just marks the card dirty.
  const addMilestone = (text: string): Promise<void> => {
    const t = (text ?? "").trim();
    if (!t || milestones[milestones.length - 1] === t) return Promise.resolve(); // skip empty/dup
    milestones.push(t);
    if (milestones.length > MILESTONE_CAP) milestones.shift();
    return flushMilestoneCard();
  };
  registerBackgroundChannelDelivery(sessionId, async (backgroundMessage) => {
    if ("text" in backgroundMessage) {
      const display = stripVisualBlocks(backgroundMessage.text);
      if (!display || !display.trim()) return true;

      if (backgroundMessage.kind === "final") {
        const md = buildMilestoneCardMarkdown({ milestones: [], finalText: display });
        const delivered = await deliverVisibleChannelText(larkClient, messageId, cardSession, md, true);
        if (delivered) deliveredTextChars = md.length;
        return delivered;
      }

      // milestone / artifact → accumulate into the checklist (coalesced render).
      await addMilestone(display);
      return true;
    }

    const display = stripVisualBlocks(backgroundMessage.content) || EMPTY_RESULT_NOTICE_BY_LOCALE[locale];
    if (!shouldDeliverBackgroundReply(display, deliveredTextChars)) return true;
    const md = buildMilestoneCardMarkdown({ milestones: [], finalText: display });
    if (cardSession) {
      const ok = await finalizeCard(larkClient, cardSession, md);
      if (ok) {
        deliveredTextChars = md.length;
        return true;
      }
      console.warn(`[lark] Background card update failed for session=${sessionId}; falling back to text reply`);
    }
    await replyToLark(larkClient, messageId, md);
    deliveredTextChars = md.length;
    return true;
  });

  // Get or create AgentBox for this agent (shared across all callers).
  const handle = await agentBoxManager.getOrCreate(agentId);
  const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);

  const modelBinding = frontendClient
    ? await resolveAgentModelBinding(agentId, frontendClient)
    : null;
  // Native Lark images are vision-gated too, mirroring the text-URL path: a
  // non-vision model can't use them and would fail-closed at AgentBox media
  // filtering, so skip the download entirely for non-vision models (the [image]
  // placeholder in effectiveText still records that the user sent an image).
  // Text image URLs are NOT handled here — they are resolved generically (and
  // vision-gated) at the `AgentBoxClient.prompt()` boundary, shared with Portal
  // Web chat / a2a / cron.
  const visionCapable = modelOptionsSupportImageInput({
    modelProvider: modelBinding?.modelProvider,
    modelId: modelBinding?.modelId,
    modelConfig: modelBinding?.modelConfig,
    modelRouting: modelBinding?.modelRouting,
  });
  const images = visionCapable
    ? await collectInboundImages({ imageRefs, larkClient, messageId })
    : [];
  // Non-vision model + the user sent native image(s): they were dropped (can't be
  // used). Tell the model so it can inform the user — mirroring the text-URL path,
  // where a non-vision model at least sees the URL and can say it can't open it.
  const promptText = !visionCapable && imageRefs.length > 0
    ? `${effectiveText}\n[Note: the user attached ${imageRefs.length} image(s), but the current model cannot read images.]`
    : effectiveText;
  // Shared group: drain the chatter buffered since the last reply and attribute
  // the asker, so the agent answers @-turns with the whole group's context.
  const drained = contextMode === "shared" ? drainDiscussion(channelId, chatId) : undefined;
  const sharedContext: SharedGroupContext | undefined = drained
    ? { discussion: drained.lines, truncated: drained.truncated, asker: senderLabel(senderOpenId) }
    : undefined;
  const promptOpts: PromptOptions = {
    text: buildChannelTurnPrompt(promptText, sharedContext),
    agentId,
    mode: "channel",
    sessionId,
    modelProvider: modelBinding?.modelProvider,
    modelId: modelBinding?.modelId,
    modelConfig: modelBinding?.modelConfig,
    modelRouting: modelBinding?.modelRouting,
    systemPromptTemplate: modelBinding?.systemPrompt?.trim() || undefined,
    ...(images.length ? { images } : {}),
  };
  let resultText = "";
  let replyImages: RenderedReplyImage[] = [];
  let agentError: Error | null = null;
  let sessionBusy = false;
  try {
    // queue-until-idle: wait out a busy session instead of dumping a raw 409.
    const promptResult = await promptWithBusyRetry(client, promptOpts);
    await bindMessageTraceId(promptMessageId, promptResult.sessionId, promptResult.traceId).catch((bindErr) => {
      console.warn(`[lark] failed to bind prompt trace session=${promptResult.sessionId} message=${promptMessageId}:`, bindErr);
    });
    const collected = await collectChannelResponse(client, promptResult.sessionId, "lark", {
      includeImages: true,
      onMilestone: addMilestone,
      locale,
      // Audit: persist assistant + tool rows so the channel transcript matches
      // web/api/a2a (origin="channel" set on the session above). Tool output on
      // this stream is already sanitized at the agentbox boundary.
      persist: { agentId, modelConfig: modelBinding?.modelConfig, traceId: promptResult.traceId },
    });
    resultText = collected.text;
    replyImages = collected.images;
  } catch (err) {
    if (isSessionBusyError(err)) {
      // Still busy after the retry window — surface a friendly notice, don't clobber.
      sessionBusy = true;
      console.warn(`[lark] Session still busy after retry for session=${sessionId}`);
    } else {
      agentError = err instanceof Error ? err : new Error(String(err));
      console.error(`[lark] Agent execution failed for session=${sessionId}:`, agentError);
    }
  }

  // Session-busy and other errors both get a sanitized notice \u2014 the raw error (internal
  // endpoints, 409 JSON) must never reach the chat; it was logged above.
  const finalBody = sessionBusy
    ? SESSION_BUSY_NOTICE_BY_LOCALE[locale]
    : agentError
      ? AGENT_ERROR_NOTICE_BY_LOCALE[locale]
      : (resultText || EMPTY_RESULT_NOTICE_BY_LOCALE[locale]);
  if (agentError || sessionBusy) replyImages = [];
  const displayBody = stripVisualBlocks(finalBody, { stripSourceBlocks: replyImages.length > 0 })
    || VISUAL_ONLY_NOTICE_BY_LOCALE[locale];
  // The final card is JUST the conclusion — the live step indicator is replaced
  // entirely, no milestone trail is kept on the card.
  const finalCardBody = buildMilestoneCardMarkdown({ milestones: [], finalText: displayBody });

  // Stop any further coalesced milestone renders and let the in-flight one
  // settle, so finalizeCard isn't overwritten by a later (higher-sequence)
  // milestone-only update.
  cardFinalizing = true;
  if (cardFlushPromise) { try { await cardFlushPromise; } catch { /* logged in flush */ } }

  if (cardSession) {
    // Only solicit 👍/👎 on a real answer — never under an error or
    // empty-result notice, where a click would write a rating against a
    // non-answer and skew the feedback signal Metrics aggregates.
    const isAnswer = !agentError && resultText.trim().length > 0;
    const ok = await finalizeCard(larkClient, cardSession, finalCardBody,
      isAnswer ? { ctx: { sessionId, channelId }, locale } : undefined);
    deliveredTextChars = finalCardBody.length;
    if (!ok) {
      // Partial-failure path: the card is visible but stuck in streaming
      // state. We log but do NOT post a second reply — that would produce
      // duplicate messages in the group.
      console.warn(`[lark] Card finalize incomplete for cardId=${cardSession.cardId}; user may see stuck placeholder`);
    }
  } else if (resultText || agentError || sessionBusy) {
    // Card could not be opened; fall back to a plain text reply with whatever we have —
    // a real answer, an error notice, OR the session-busy notice (sessionBusy carries no
    // resultText/agentError, so it must be listed explicitly or the busy notice is dropped).
    await replyToLark(larkClient, messageId, finalCardBody);
    deliveredTextChars = finalCardBody.length;
  }

  await replyVisualImages(larkClient, messageId, replyImages);
}

async function resolveQueuedBinding(
  route: "group" | "personal",
  channelId: string,
  chatId: string,
  senderOpenId: string | null,
  frontendClient: FrontendWsClient,
  sessionKey: string,
): Promise<ResolvedChannelBinding | null> {
  if (route === "personal") {
    if (!senderOpenId) return null;
    return resolvePersonalBinding(channelId, senderOpenId, frontendClient);
  }
  const result = await resolveBinding(channelId, chatId, frontendClient, sessionKey, senderOpenId ?? undefined);
  // If access was revoked between enqueue and run, treat as gone (the queued
  // task then skips). The pre-enqueue check already replied any access hint.
  return isChannelAccessDenied(result) ? null : result;
}

/**
 * Build the access-denied reply for a sicore_authorized group, in the channel's
 * locale. Appends the authorize URL for the "unbound" case.
 */
function formatGroupAccessDeniedReply(
  denied: ChannelAccessDenied,
  locale: "zh-CN" | "en-US",
): string {
  if (denied.reason === "denied") {
    return GROUP_ACCESS_DENIED_NOTICE_BY_LOCALE[locale];
  }
  const base = GROUP_ACCESS_UNBOUND_NOTICE_BY_LOCALE[locale];
  return denied.authorizeUrl ? `${base}\n${denied.authorizeUrl}` : base;
}

async function handleNewCommand(
  route: "group" | "personal",
  channelId: string,
  chatId: string,
  sessionKey: string,
  messageId: string,
  larkClient: any,
  agentBoxManager: AgentBoxManager,
  tlsOptions?: { cert: string; key: string; ca: string },
  frontendClient?: FrontendWsClient,
  locale: "zh-CN" | "en-US" = "zh-CN",
): Promise<void> {
  const reset = route === "personal"
    ? await resetPersonalSession(channelId, sessionKey, frontendClient!)
    : await resetBindingSession(channelId, chatId, frontendClient!, sessionKey);
  if (!reset.success || !reset.sessionId || !reset.agentId) {
    await replyToLark(larkClient, messageId, `❌ ${reset.error ?? "Failed to reset session"}`);
    return;
  }

  if (reset.oldSessionId) {
    sessionRegistry.forget(reset.oldSessionId);
    try {
      const handle = await agentBoxManager.getOrCreate(reset.agentId);
      const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);
      await client.closeSession(reset.oldSessionId);
    } catch (err) {
      console.error(`[lark] Failed to close old session=${reset.oldSessionId} on /new:`, err);
    }
  }

  await replyToLark(larkClient, messageId, NEW_SESSION_NOTICE_BY_LOCALE[locale]);
}

/**
 * Build the PAIR-command reply in the channel's locale. Kept here (not in
 * lark-card) because it's plain-text (uses replyToLark, not CardKit) and
 * tightly coupled to the handler's PAIR branch.
 */
function formatPairReply(
  result: { success: boolean; agentName?: string; error?: string },
  locale: "zh-CN" | "en-US",
): string {
  if (result.success) {
    return locale === "en-US"
      ? `\u2705 Paired! This group is now connected to agent "${result.agentName}".`
      : `\u2705 绑定成功！此群组已连接到 Agent "${result.agentName}"。`;
  }
  return locale === "en-US"
    ? `\u274C Pairing failed: ${result.error}`
    : `\u274C 绑定失败: ${result.error}`;
}

function formatPersonalBindRequiredReply(
  authorizeUrl: string | undefined,
  locale: "zh-CN" | "en-US",
): string {
  const base = PERSONAL_BIND_REQUIRED_NOTICE_BY_LOCALE[locale];
  if (!authorizeUrl) return base;
  return locale === "en-US"
    ? `${base}\n${authorizeUrl}`
    : `${base}\n${authorizeUrl}`;
}

function formatPersonalPairReply(
  result: { success: boolean; agentName?: string; error?: string },
  locale: "zh-CN" | "en-US",
): string {
  if (result.success) {
    return locale === "en-US"
      ? `\u2705 Authorized! This personal bot is now connected to agent "${result.agentName}".`
      : `\u2705 授权成功！这个个人机器人已连接到 Agent "${result.agentName}"。`;
  }
  return locale === "en-US"
    ? `\u274C Authorization failed: ${result.error}`
    : `\u274C 授权失败: ${result.error}`;
}

async function replyToLark(larkClient: any, messageId: string, text: string): Promise<void> {
  try {
    // Feishu's SDK does NOT throw on a non-zero API code (e.g. missing
    // im:message send scope) — it returns {code,msg} in the body. Surface it,
    // otherwise a permission failure looks like a silent no-op.
    const resp = await larkClient.im.message.reply({
      path: { message_id: messageId },
      data: { content: JSON.stringify({ text }), msg_type: "text" },
    });
    if (resp && typeof resp.code === "number" && resp.code !== 0) {
      console.error(`[lark] reply API returned non-zero code for messageId=${messageId}: code=${resp.code} msg=${resp.msg}`);
    }
  } catch (err) {
    console.error(`[lark] Failed to reply to messageId=${messageId}:`, err);
  }
}

function shouldDeliverBackgroundReply(text: string, previousChars: number): boolean {
  const chars = text.trim().length;
  if (chars === 0) return false;
  return !(previousChars > 80 && chars < 120 && chars < previousChars * 0.75);
}

/**
 * True when an AgentBox prompt failed with HTTP 409 ("Session is already running") — the session
 * is single-threaded and something (previous turn / lingering background exec / synthetic delivery)
 * still holds the brain. The client wraps non-2xx as `AgentBox request failed: <status> <body>`
 * with a `.status` field.
 */
function isSessionBusyError(err: unknown): boolean {
  if (err && typeof err === "object" && (err as { status?: number }).status === 409) return true;
  const m = err instanceof Error ? err.message : String(err);
  return /request failed: 409\b/i.test(m) || /already running/i.test(m);
}

/**
 * queue-until-idle: the per-binding queue already serialises a sender's messages, but a turn can
 * end while a run_in_background exec job (or the synthetic delivery turn) still holds the session —
 * so the next dequeued message can still hit 409. Retry with backoff until the session frees; give
 * up after maxWaitMs so a genuinely stuck/long job doesn't pin the handler forever (caller then
 * shows the friendly busy notice). Never surfaces the raw 409.
 */
async function promptWithBusyRetry(
  client: AgentBoxClient,
  opts: PromptOptions,
  maxWaitMs = 45_000,
): Promise<Awaited<ReturnType<AgentBoxClient["prompt"]>>> {
  const started = Date.now();
  let delay = 500;
  for (;;) {
    try {
      return await client.prompt(opts);
    } catch (err) {
      if (!isSessionBusyError(err) || Date.now() - started >= maxWaitMs) throw err;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 3000);
    }
  }
}

async function deliverVisibleChannelText(
  larkClient: any,
  messageId: string,
  cardSession: Awaited<ReturnType<typeof openTypingCard>>,
  text: string,
  terminal: boolean,
): Promise<boolean> {
  if (cardSession) {
    const ok = terminal
      ? await finalizeCard(larkClient, cardSession, text)
      : await updateCardContent(larkClient, cardSession, text);
    if (ok) return true;
    console.warn(`[lark] Channel-visible card update failed for messageId=${messageId}; falling back to text reply`);
  }
  await replyToLark(larkClient, messageId, text);
  return true;
}

async function replyVisualImages(larkClient: any, messageId: string, images: RenderedReplyImage[]): Promise<void> {
  for (const { kind, image } of images) {
    const ok = await replyImageToLark(larkClient, messageId, image);
    if (!ok) {
      console.warn(`[lark] ${kind} image reply failed for messageId=${messageId}; markdown card remains primary`);
    }
  }
}

// ── SSE response collector ─────────────────────────────────────

export interface CollectedChannelResponse {
  text: string;
  images: RenderedReplyImage[];
}

export async function collectResponse(
  client: AgentBoxClient,
  sessionId: string,
  logPrefix = "lark",
  options: { persist?: ChannelPersistContext } = {},
): Promise<string> {
  return (await collectChannelResponse(client, sessionId, logPrefix, { persist: options.persist })).text;
}

/**
 * Opt-in audit persistence for the channel path. When set, collectChannelResponse
 * writes the same user/assistant/tool transcript that web/api/a2a get via the
 * runtime's sse-consumer, so IM-channel sessions are fully auditable (not just
 * the inbound user message). `modelConfig` drives the same apiKey/baseUrl
 * redaction the sse-consumer applies. The caller has already persisted the user
 * message + ensured the session row (origin="channel").
 */
export interface ChannelPersistContext {
  agentId: string;
  modelConfig?: { apiKey?: string; baseUrl?: string };
  traceId?: string;
}

export async function collectChannelResponse(
  client: AgentBoxClient,
  sessionId: string,
  logPrefix = "lark",
  options: { includeImages?: boolean; onMilestone?: (text: string) => void; persist?: ChannelPersistContext; locale?: LarkLocale } = {},
): Promise<CollectedChannelResponse> {
  const parts: string[] = [];
  const images: RenderedReplyImage[] = [];
  const seenImageKeys = new Set<string>();
  // Track the latest assistant turn so we only reply with the *final* text
  // (tool-use turns emit intermediate message_end events that aren't meant
  // for the user). pi-agent's agent_end signals the last turn is complete.
  let lastAssistantText = "";

  // ── Audit persistence (opt-in) ──────────────────────────────────────────
  // Mirrors the field mapping in sse-consumer.ts so a channel transcript looks
  // like a web/api/a2a one. Tool content + input are redacted with the same
  // model-config redactor. Best-effort: a persist failure must never break the
  // user-facing reply, so each write is wrapped and swallowed-with-log.
  const persist = options.persist;
  const redaction = persist ? buildRedactionConfigForModelConfig(persist.modelConfig) : null;
  const redact = (s: string): string => (redaction ? redactText(s, redaction) : s);
  // FIFO per-tool queues to pair start↔end (same approach as sse-consumer's
  // pendingTool* maps). Caveat inherited from there: multiple *concurrent*
  // same-name calls finishing out of order can mispair, skewing that row's
  // durationMs. Only affects the audit metric, never the reply; acceptable.
  const toolInputs = new Map<string, string[]>();
  const toolStarts = new Map<string, number[]>();
  const pushQ = <T,>(m: Map<string, T[]>, k: string, v: T): void => { const a = m.get(k) ?? []; a.push(v); m.set(k, a); };
  const shiftQ = <T,>(m: Map<string, T[]>, k: string): T | undefined => m.get(k)?.shift();
  const persistRow = async (msg: Parameters<typeof appendMessage>[0]): Promise<void> => {
    try { await appendMessage({ ...msg, traceId: persist?.traceId ?? msg.traceId }); }
    catch (err) { console.warn(`[${logPrefix}] audit persist failed session=${sessionId}:`, err); }
  };

  try {
    for await (const event of client.streamEvents(sessionId)) {
      const ev = event as Record<string, any>;

      // Live tool progress → milestone. A FOREGROUND sub-agent batch blocks the parent inside one
      // tool call, so no intermediate assistant turn fires while it runs — without this the card
      // sits frozen at the last line for the whole (multi-minute) batch. spawn_subagent streams
      // group progress via tool_execution_update; surface it as the current ⏳ step. (Background
      // groups instead report via group_progress, not this SSE.)
      if (ev.type === "tool_execution_update" && options.onMilestone) {
        const items = Array.isArray(ev.partialResult?.details?.items) ? ev.partialResult.details.items : null;
        let milestone = "";
        if (items) {
          // Structured group progress → render in the channel locale (the tool's own activity
          // text is hard-coded English; localize here where we know the locale).
          const total = items.length;
          const done = items.filter((i: any) => i?.status !== "queued" && i?.status !== "running").length;
          milestone = (options.locale === "en-US")
            ? `Running sub-agents… ${done}/${total} done`
            : `子任务执行中… ${done}/${total} 完成`;
        } else {
          // Non-group progress (single-agent step activity): fall back to the raw activity text.
          const blocks = Array.isArray(ev.partialResult?.content) ? ev.partialResult.content : [];
          const activity = blocks
            .filter((b: any) => b?.type === "text")
            .map((b: any) => (b.text ?? "") as string)
            .join(" ")
            .trim();
          milestone = activity ? (condenseMilestone(activity) || activity) : "";
        }
        if (milestone) options.onMilestone(milestone);
      }

      if (ev.type === "content_block_delta" && ev.delta?.text) parts.push(ev.delta.text);
      if (ev.type === "text" && typeof ev.text === "string") parts.push(ev.text);

      // Capture tool input + start time for the matching tool_execution_end.
      if (persist && (ev.type === "tool_execution_start" || ev.type === "tool_start")) {
        const name = (ev.toolName as string) || (ev.name as string) || "tool";
        pushQ(toolInputs, name, ev.args ? JSON.stringify(ev.args) : "");
        pushQ(toolStarts, name, Date.now());
      }

      if (ev.type === "tool_execution_end" || ev.type === "tool_end") {
        if (options.includeImages) collectImageAttachments(ev.result?.content, images, seenImageKeys);
        if (persist) {
          const name = (ev.toolName as string) || (ev.name as string) || "tool";
          const resultText = Array.isArray(ev.result?.content)
            ? ev.result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text ?? "").join("")
            : "";
          let outcome: "success" | "error" | "blocked" = "success";
          if (ev.result?.details?.blocked) outcome = "blocked";
          else if (ev.result?.details?.error) outcome = "error";
          const input = shiftQ(toolInputs, name) || "";
          const startedAt = shiftQ(toolStarts, name);
          await persistRow({
            sessionId,
            role: "tool",
            content: redact(resultText),
            toolName: name,
            toolInput: input ? redact(input) : null,
            outcome,
            durationMs: startedAt != null ? Date.now() - startedAt : null,
          });
        }
      }

      if (options.includeImages && ev.type === "message_end" && (ev.message?.role === "toolResult" || ev.message?.role === "tool")) {
        collectImageAttachments(ev.message?.content, images, seenImageKeys);
      }
      // pi-agent-brain emits the final assistant reply as message_end with
      // a content array of blocks; collect the text blocks only.
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const blocks = Array.isArray(ev.message.content) ? ev.message.content : [];
        if (options.includeImages) collectImageAttachments(blocks, images, seenImageKeys);
        const turnText = contentBlocksToMarkdown(blocks);
        if (turnText) {
          // A NEW assistant turn means the PREVIOUS one was an intermediate
          // step (the agent narrated, then called a tool) — surface its first
          // line as a progress milestone. The final turn is never followed by
          // another, so it stays the answer, not a milestone.
          if (lastAssistantText && options.onMilestone) {
            const m = condenseMilestone(lastAssistantText);
            if (m) options.onMilestone(m);
          }
          lastAssistantText = turnText;
          // Persist every assistant turn (intermediate narration + final answer),
          // mirroring sse-consumer. Awaited so its created_at precedes the next
          // tool row in the transcript.
          if (persist) await persistRow({ sessionId, role: "assistant", content: redact(turnText) });
        }
      }
    }
  } catch (err) {
    console.error(`[${logPrefix}] SSE collect error for session=${sessionId}:`, err);
  }
  // Prefer the last full assistant turn; fall back to streamed deltas if the
  // brain only emits content_block_delta events.
  const text = lastAssistantText || parts.join("");
  return { text, images };
}

/**
 * Condense an intermediate assistant turn into a one-line progress milestone:
 * first non-empty line, strip a leading heading marker, cap length. Inline
 * code/bold pass through so chips still render.
 */
function condenseMilestone(text: string): string {
  const firstLine = text.split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  const clean = firstLine.replace(/^#{1,6}\s+/, "").trim();
  if (!clean) return "";
  return clean.length > 90 ? `${clean.slice(0, 88)}…` : clean;
}

function contentBlocksToMarkdown(blocks: unknown[]): string {
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return "";
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") return rec.text;
    return "";
  }).join("");
}
