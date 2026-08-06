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
  issuePersonalApiKey,
  getPersonalApiKeyStatus,
  updateBindingMeta,
  updateChannelName,
  isChannelAccessDenied,
  isOpenAccessTier,
  type ResolvedChannelBinding,
  type ChannelAccessDenied,
  type PersonalApiKeyIssueResult,
  type PersonalApiKeyStatusResult,
  type PersonalAccessDenied,
  beginTicketIntake,
  getActiveTicketIntake,
  transitionTicketIntake,
} from "../channel-manager.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";
import { sessionRegistry } from "../session-registry.js";
import { sessionTurnLocks } from "../session-turn-lock.js";
import { appendMessage, bindMessageTraceId, ensureChatSession, recordChannelFeedback } from "../chat-repo.js";
import { buildRedactionConfigForModelConfig, redactText } from "../output-redactor.js";
import { resolveAgentModelBinding } from "../agent-model-binding.js";
import {
  openTypingCard,
  updateCardContent,
  finalizeCard,
  postFinalCard,
  type FeedbackContext,
  buildMilestoneCardMarkdown,
  applyFeedbackSelection,
  FEEDBACK_ACTION_KIND,
  sendModeCard,
  MODE_ACTION_KIND,
  PLACEHOLDER_BY_LOCALE,
  EMPTY_RESULT_NOTICE_BY_LOCALE,
  localeForDomain,
  sendLinkActionCard,
  type FeedbackActionValue,
  type ModeActionValue,
  type GroupContextMode,
  type LarkLocale,
  TICKET_INTAKE_ACTION_KIND,
  type TicketIntakeActionValue,
  type TicketIntakeCardContext,
  buildTicketIntakeReviewMarkdown,
} from "./lark-card.js";
import { collectImageAttachments, stripVisualBlocks, type RenderedReplyImage } from "./visual-image.js";
import { replyImageToLark } from "./lark-image.js";
import { collectInboundImages, type LarkImageRef } from "./inbound-image.js";
import { modelOptionsSupportImageInput } from "../../core/model-routing.js";
import { redactImageUrlsInText } from "../agentbox/image-url-ingest.js";
import { registerBackgroundChannelDelivery } from "./background-delivery.js";
import { buildTicketIntakeAgentContext, type TicketIntakeRecord } from "../../shared/ticket-intake.js";

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

// Gated group, sender's account not linked yet.
const GROUP_ACCESS_UNBOUND_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 你的账号还没完成关联，暂时无法在群里使用这个助手。",
  "en-US": "❌ Your account isn't linked yet, so you can't use this assistant here.",
} as const;
// Gated group, sender is linked but lacks access to this agent.
const GROUP_ACCESS_DENIED_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 你没有这个助手的使用权限。",
  "en-US": "❌ You don't have access to this assistant.",
} as const;
/**
 * How to proceed, when the channel has a personal bot to talk to.
 *
 * A group refusal must NOT carry the authorization URL. Two reasons: it is noise posted to
 * everyone present, and the real self-service step differs per sender (link an account vs request
 * access) — the private chat resolves that per person and can hand over a single-use link, which
 * must never appear in a room where anyone could open it. So the group says "DM me" and the DM
 * does the work.
 */
const GROUP_ACCESS_DM_HINT_BY_LOCALE = {
  "zh-CN": "请私聊我完成授权，然后回群里重试。",
  "en-US": "DM me to get access, then try again here.",
} as const;
// Group-only channel WITH a console URL: it is the sender's own authorization page.
const GROUP_ACCESS_SELF_SERVE_HINT_BY_LOCALE = {
  "zh-CN": "请打开下面的链接完成授权，然后回群里重试：",
  "en-US": "Open the link below to authorize, then try again here:",
} as const;
// Group-only channel with no URL either: nothing the sender can do alone.
const GROUP_ACCESS_ADMIN_HINT_BY_LOCALE = {
  "zh-CN": "请联系管理员授权。",
  "en-US": "Ask an admin to grant access.",
} as const;
// /apikey: the frontend RPC threw (transport down, or a frontend that doesn't
// implement it at all). The user is waiting on a pickup link, so say something —
// staying silent here reads as "the bot is broken".
const API_KEY_UNAVAILABLE_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 暂时无法处理 API Key 请求，请稍后重试。",
  "en-US": "❌ The API key service is unavailable right now — please try again later.",
} as const;
// /apikey: one request for this sender is already in flight. Issuing ROTATES, so letting a
// second one through would mint a second key and silently kill the first pickup link.
const API_KEY_BUSY_NOTICE_BY_LOCALE = {
  "zh-CN": "⏳ 正在处理你上一条 API Key 请求，请稍等几秒。",
  "en-US": "⏳ Your previous API key request is still running — give it a few seconds.",
} as const;
// Personal chat, sender refused on a gated tier, and the frontend told us nothing about why
// (it predates the `denied` contract, or sent an unknown tier). Generic on purpose — we have no
// reason code and no link to offer. What matters is that SOMETHING is said: the previous code
// only logged for any tier it didn't recognise, so a gated user's message vanished without a
// reply and the bot looked dead.
const PERSONAL_ACCESS_GATED_NOTICE_BY_LOCALE = {
  "zh-CN": "❌ 使用这个助手需要先获得授权。",
  "en-US": "❌ This assistant requires authorization.",
} as const;
// A configured console URL is the sender's own authorization page — tell them to open it.
const PERSONAL_ACCESS_SELF_SERVE_HINT_BY_LOCALE = {
  "zh-CN": "请打开下面的链接完成授权，然后回来重试：",
  "en-US": "Open the link below to authorize, then try again:",
} as const;
// No URL configured: nothing the sender can do alone.
const PERSONAL_ACCESS_ADMIN_HINT_BY_LOCALE = {
  "zh-CN": "请联系管理员开通。",
  "en-US": "Ask an admin to grant you access.",
} as const;
// Localized copy per `denied.reason`. Keyed on the CONTRACT field rather than rendering the
// frontend's prose, so both channel locales are served (a Lark-global tenant reads English) —
// the frontend does not know the channel's locale and should not have to.
// A Map, not an object literal: `reason` arrives from the frontend, and an object lookup walks
// the prototype chain — `reason: "toString"` would return a Function, pass the `!template` check,
// and be rendered (or JSON-serialized to `{}`, which the platform rejects, silently dropping the
// very reply this feature exists to deliver).
const PERSONAL_DENIAL_COPY_BY_LOCALE: Record<LarkLocale, Map<string, string>> = {
  "zh-CN": new Map([
    // Not yet linked: send them to link, once.
    ["binding_required", "❌ 使用这个助手需要先关联账号。"],
    // ALREADY linked but unauthorized — must not say "go link", they did that.
    ["access_request_required", "❌ 你还没有这个助手的使用权限，可以点下面的链接申请。"],
    // Unauthorized and self-service is closed: no link exists to offer.
    ["access_denied", "❌ 你没有这个助手的使用权限，请联系该助手的负责人开通。"],
  ]),
  "en-US": new Map([
    ["binding_required", "❌ Using this assistant requires linking your account first."],
    ["access_request_required", "❌ You don't have access to this assistant yet — request it via the link below."],
    ["access_denied", "❌ You don't have access to this assistant. Ask its owner to grant it."],
  ]),
};
// Appended when a one-time `actionUrl` is present. The remaining validity is DERIVED from
// `expiresAtMs`; never restate the frontend's TTL as a constant here (it changes without this
// file noticing — a lesson from the /apikey copy).
const PERSONAL_DENIAL_LINK_HINT_BY_LOCALE: Record<LarkLocale, (minutes: number | null) => string> = {
  "zh-CN": (m) => (m === null
    ? "请点击下面的链接完成，链接仅可打开一次："
    : `请在 ${m} 分钟内点击下面的链接完成，仅可打开一次：`),
  "en-US": (m) => (m === null
    ? "Open the link below to continue — it works only once:"
    : `Open the link below within ${m} minute${m === 1 ? "" : "s"} — it works only once:`),
};
// Button label per reason for the CARD form. A generic verb backs any future reason so it still
// gets a usable button rather than falling back to raw text.
const PERSONAL_DENIAL_BUTTON_BY_LOCALE: Record<LarkLocale, Map<string, string>> = {
  "zh-CN": new Map([
    ["binding_required", "关联账号"],
    ["access_request_required", "申请权限"],
  ]),
  "en-US": new Map([
    ["binding_required", "Link account"],
    ["access_request_required", "Request access"],
  ]),
};
// Card footnote for a single-use link. Validity is DERIVED from `expiresAtMs`, same rule as the
// text form — never restate the frontend's TTL as a constant.
const SINGLE_USE_LINK_NOTE_BY_LOCALE: Record<LarkLocale, (minutes: number | null) => string> = {
  "zh-CN": (m) => (m === null ? "仅可打开一次" : `仅可打开一次 · ${m} 分钟内有效`),
  "en-US": (m) => (m === null ? "Opens once" : `Opens once · valid for ${m} minute${m === 1 ? "" : "s"}`),
};
// Shown instead of a dead link: the frontend mints a fresh one on the sender's next message, so
// resending is the actual recovery. Handing over an already-expired URL just sends them to an
// error page with no hint that anything can be done about it.
const PERSONAL_DENIAL_LINK_EXPIRED_BY_LOCALE: Record<LarkLocale, string> = {
  "zh-CN": "之前的链接已过期，请再发一条消息获取新链接。",
  "en-US": "The previous link has expired — send another message to get a fresh one.",
};
// Bound on the frontend's free-form prose. Deliberately NOT applied to the rendered result: a
// truncated URL is a guaranteed dead link, and the platform's text limit sits far above anything
// rendered here (see truncateDenialProse).
const PERSONAL_DENIAL_MESSAGE_MAX_CHARS = 1000;
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
  /** Opt-in support intake; disabled on existing bots until their agent is configured for it. */
  ticket_intake_enabled?: boolean;
  personal_bot?: {
    channel_id?: string;
    agent_id: string;
    // Admission tier, decided ENTIRELY by the frontend — the runtime never interprets it to
    // allow or refuse, it only picks fallback copy when a refusal arrives without a reason.
    // `open`/`sicore_authorized` are the legacy spellings of `public`/`granted`. Typed as a
    // union plus `string` on purpose: a frontend may introduce a tier this build has never
    // heard of, and the branch below must treat that as "gated", never as "let everyone in".
    access_mode: "open" | "public" | "identified" | "granted" | "sicore_authorized" | (string & {});
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
  groupModeCache.clear();
  discussionBuffers.clear();
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

/**
 * Feishu's own word for what kind of party sent this — "user", "app", … The
 * value is passed through verbatim rather than mapped to a boolean: we do not
 * control the vocabulary, and a value we have not seen before must reach the
 * Portal intact instead of being flattened into "not a user".
 *
 * Nothing in this file branches on it. It exists so the Portal can tell a bot
 * from a person at all — until now it received only an open_id, which an app
 * sender may not even have, leaving "a bot wrote this" and "we could not
 * identify the writer" indistinguishable.
 */
function getLarkSenderType(data: any): string | null {
  const t = data?.sender?.sender_type ?? data?.event?.sender?.sender_type;
  return typeof t === "string" && t.trim() ? t.trim() : null;
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

const TICKET_INTAKE_TOAST_BY_LOCALE = {
  "zh-CN": { start: "好的，我来帮你提交工单。", confirm: "正在确认工单信息。", continue: "请继续发送需要补充或修改的信息。", cancel: "正在取消。", fail: "操作失败，请刷新后重试。", forbidden: "只有发起人可以操作这份工单。" },
  "en-US": { start: "Okay, I'll help you submit a ticket.", confirm: "Confirming the ticket details.", continue: "Send the details you want to add or change.", cancel: "Cancelling.", fail: "Action failed. Refresh and try again.", forbidden: "Only the requester can operate this ticket." },
} as const;

/**
 * Handle a `card.action.trigger` callback for feedback, group mode, and
 * user-started ticket intake. Unknown discriminators return undefined.
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

  if (value.kind === TICKET_INTAKE_ACTION_KIND) {
    return handleTicketIntakeAction(value as Partial<TicketIntakeActionValue>, data, larkClient, frontendClient);
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
        ...(typeof fb.message_id === "string" && fb.message_id.trim() ? { messageId: fb.message_id.trim() } : {}),
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

function handleTicketIntakeAction(
  value: Partial<TicketIntakeActionValue>,
  data: any,
  larkClient: any,
  frontendClient?: FrontendWsClient,
): { toast: { type: string; content: string } } {
  const locale: LarkLocale = value.locale === "en-US" ? "en-US" : "zh-CN";
  const copy = TICKET_INTAKE_TOAST_BY_LOCALE[locale];
  const operator = typeof data?.operator?.open_id === "string" ? data.operator.open_id : "";
  const action = value.action;
  if (!operator || operator !== value.requester_external_id) {
    return { toast: { type: "error", content: copy.forbidden } };
  }
  if (!action || !["start", "confirm", "continue", "cancel"].includes(action)) {
    return { toast: { type: "error", content: copy.fail } };
  }
  if (action === "start") {
    if (!value.session_id || !value.channel_id || !value.source_message_id) {
      return { toast: { type: "error", content: copy.fail } };
    }
  } else if (!value.intake_id || !Number.isInteger(value.revision) || Number(value.revision) < 1) {
    return { toast: { type: "error", content: copy.fail } };
  }

  void (async () => {
    try {
      const sourceMessageId = typeof value.source_message_id === "string" ? value.source_message_id : "";
      const result = action === "start"
        ? await beginTicketIntake({
            sessionId: String(value.session_id ?? ""),
            channelId: String(value.channel_id ?? ""),
            requesterExternalId: operator,
            sourceMessageId: String(value.source_message_id ?? ""),
          }, frontendClient)
        : await transitionTicketIntake({
            intakeId: String(value.intake_id ?? ""),
            requesterExternalId: operator,
            revision: Number(value.revision),
            action,
          }, frontendClient);
      if (!result.success) {
        console.warn(`[lark] Ticket intake ${action} rejected: ${result.error ?? "unknown"}`);
        if (sourceMessageId) await replyToLark(larkClient, sourceMessageId, copy.fail);
        return;
      }
      if (sourceMessageId) {
        const notice = action === "confirm"
          ? (locale === "zh-CN" ? "✅ 已确认工单信息。" : "✅ Ticket details confirmed.")
          : action === "cancel"
            ? (locale === "zh-CN" ? "已取消提交工单。" : "Ticket submission cancelled.")
            : action === "continue"
              ? copy.continue
              : (locale === "zh-CN"
                  ? "好的，我来帮你提交工单。请继续发送问题背景、影响范围和期望结果。"
                  : "Okay, I'll help you submit a ticket. Send the issue context, impact scope, and expected result.");
        await replyToLark(larkClient, sourceMessageId, notice);
      }
    } catch (err) {
      console.error(`[lark] Ticket intake ${action} failed:`, err);
    }
  })();

  return { toast: { type: "success", content: copy[action] } };
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
  const senderType = getLarkSenderType(data);
  const sessionKey = buildLarkSessionKey(senderOpenId, chatId);
  // Every group message carries a provider-native Topic candidate. The
  // server-authoritative contextMode decides the product behavior after binding
  // resolution: per_user uses the Topic; shared stays on the main-group path.
  const isGroupMessage = chatType === "group";
  const eventRootMessageId = typeof message.root_id === "string" && message.root_id.trim()
    ? message.root_id.trim()
    : messageId;
  const threadId = typeof message.thread_id === "string" && message.thread_id.trim()
    ? message.thread_id.trim()
    : null;
  // Ordinary Feishu quote replies also carry root_id. Only thread_id proves
  // that this event belongs to a Topic; otherwise an explicit @ starts a new
  // bot conversation rooted at the current message.
  const rootMessageId = threadId ? eventRootMessageId : messageId;
  const topicConversationKey = isGroupMessage ? `lark_thread:${rootMessageId}` : undefined;

  // Raw receipt log: fires for EVERY delivered event before any drop, so a
  // group message that arrives but is filtered (non-text, empty after @-strip)
  // is still visible. Lets us tell "never delivered" from "silently dropped".
  // senderType is logged beside the id because `sender=?` alone cannot say WHY
  // we have no identity: an event with no sender_id at all and one whose
  // sender_id simply omits open_id look identical here, and they lead to
  // opposite conclusions about whether a sender can ever be authorized.
  console.log(`[lark] recv event chat=${chatId} chat_type=${chatType} msg_type=${msgType} sender=${senderOpenId ?? "?"} sender_type=${senderType ?? "?"} channelCfg=${channelId}`);

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
      // Gate on OPEN-ness, not on the one legacy gated spelling: a bot on any gated tier still
      // needs its pairing code forwarded. Comparing against the one legacy literal told a
      // `granted`/`identified` bot's users "this bot is open, no PAIR needed" and threw their
      // code away — a gated bot described as public, with no way to bind.
      if (isOpenAccessTier(personalBot.access_mode)) {
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

    // /apikey — self-service API key issuing. Claims the WHOLE `/apikey …` namespace so a
    // malformed subcommand can never fall through to the agent. Parsing is deliberately
    // deterministic and returns here: the LLM must never sit in the credential-issuing loop,
    // or one prompt injection becomes an issuing primitive.
    //
    // Placed BEFORE binding resolution on purpose — an `open` personal bot is the primary use
    // case and its users need no binding at all. Admission is the frontend's call (it also
    // fails closed on an inactive personal bot); the runtime only forwards the sender identity.
    const apiKeyCommand = parseApiKeyCommand(text);
    if (apiKeyCommand) {
      const { subcommand } = apiKeyCommand;
      // Only an EXACT bare `/apikey` may rotate. Anything else gets usage help and issues no
      // RPC at all, so a typo can't destroy the key the user meant to inspect.
      if (subcommand !== "" && subcommand !== "status") {
        await replyToLark(larkClient, messageId, formatApiKeyUsageReply(locale));
        return;
      }
      if (!frontendClient) {
        console.warn(`[lark] /apikey unavailable — no frontend client (channel=${personalChannelId})`);
        await replyToLark(larkClient, messageId, API_KEY_UNAVAILABLE_NOTICE_BY_LOCALE[locale]);
        return;
      }
      const label = subcommand === "status" ? "status" : "issue";
      const inFlightKey = `${personalChannelId}:${senderOpenId}`;
      if (apiKeyRequestsInFlight.has(inFlightKey)) {
        console.log(`[lark] /apikey ${label} rejected — already in flight for sender=${senderOpenId}`);
        await replyToLark(larkClient, messageId, API_KEY_BUSY_NOTICE_BY_LOCALE[locale]);
        return;
      }
      apiKeyRequestsInFlight.add(inFlightKey);
      try {
        let reply: string;
        // True once the frontend has COMMITTED a rotation for this request: the requester's old
        // key is already dead, so failing to hand over the new pickup link is a real loss rather
        // than a retriable no-op.
        let carriesCommittedRotation = false;
        // Set when the pickup link went out as a card (button, so the client cannot unfurl and
        // consume the one-time token). Non-null means delivery was already attempted here and the
        // shared text reply below must be skipped.
        let cardDelivered: boolean | null = null;
        if (subcommand === "status") {
          const status = await getPersonalApiKeyStatus(personalChannelId, senderOpenId, frontendClient);
          reply = formatApiKeyStatusReply(status, locale);
          console.log(`[lark] /apikey status channel=${personalChannelId} sender=${senderOpenId} ok=${status.success} exists=${status.exists ?? "?"}`);
        } else {
          // messageId is forwarded as a stable request id so the frontend CAN make issuing
          // idempotent across a redelivery or a second replica — the in-process guard above
          // cannot span either.
          const issued = await issuePersonalApiKey(personalChannelId, senderOpenId, frontendClient, messageId);
          reply = formatApiKeyIssueReply(issued, locale);
          carriesCommittedRotation = Boolean(issued.success && issued.pickupUrl);
          // Audit line for a credential-mutating command: this path bypasses chat persistence,
          // so without it a "my key stopped working" report has no runtime-side evidence of who
          // rotated what and when. Never log the pickup URL — it is a bearer credential.
          console.log(`[lark] /apikey issue channel=${personalChannelId} sender=${senderOpenId} ok=${issued.success} rotated=${issued.rotated ?? false}`);
          if (issued.success && issued.pickupUrl) {
            cardDelivered = await deliverSingleUseLink(larkClient, messageId, locale, {
              body: formatApiKeyIssueCardBody(issued, locale),
              buttonLabel: API_KEY_PICKUP_BUTTON_BY_LOCALE[locale],
              url: issued.pickupUrl,
              expiresAtMs: issued.expiresAt,
            }, reply);
          } else {
            // A refusal that still offers a live self-service link gets the same card treatment:
            // the lead line plus how to resume in the body, the one-time URL behind the button.
            const denialCard = buildApiKeyDenialCard(issued.denied, locale);
            if (denialCard) {
              cardDelivered = await deliverSingleUseLink(larkClient, messageId, locale, denialCard, reply);
            }
          }
        }
        // `replyToLark` swallows both throws and non-zero Feishu codes, so delivery has to be
        // CHECKED here rather than inferred from the absence of an exception. When a rotation has
        // already committed, retry once for the transient case and then leave a high-signal line
        // naming the sender: their previous key is invalid and the new link never arrived. The
        // command stays safely retryable — another `/apikey` rotates again and returns a fresh
        // link — which is what keeps this recoverable instead of a lost credential.
        const delivered = cardDelivered ?? await replyToLark(larkClient, messageId, reply);
        if (!delivered && carriesCommittedRotation) {
          if (!(await replyToLark(larkClient, messageId, reply))) {
            console.error(
              `[lark] /apikey issue UNDELIVERED after rotation — channel=${personalChannelId} ` +
              `sender=${senderOpenId}: the previous key is already invalid and the new pickup link ` +
              `did not reach them; they must send /apikey again`,
            );
          }
        }
      } catch (err) {
        // Unlike PAIR (whose failure escapes to the top-level catch), stay explicit here: the
        // user is waiting on a pickup link, and silence reads as a broken bot.
        console.error(`[lark] /apikey ${label} failed for channel=${personalChannelId} sender=${senderOpenId}:`, err);
        await replyToLark(larkClient, messageId, API_KEY_UNAVAILABLE_NOTICE_BY_LOCALE[locale]);
      } finally {
        apiKeyRequestsInFlight.delete(inFlightKey);
      }
      return;
    }

    const { binding, denied } = await resolvePersonalBinding(personalChannelId, senderOpenId, frontendClient!, senderType ?? undefined);
    if (!binding) {
      // The frontend owns the admission decision; the runtime's whole gate is "did a binding come
      // back". All that is left is telling the sender what to do next.
      const deniedReply = denied ? formatPersonalDenialReply(denied, locale) : null;
      if (deniedReply) {
        console.log(`[lark] Personal access denied channel=${personalChannelId} sender=${senderOpenId} reason=${denied?.reason ?? "?"}`);
        // A live single-use link goes out as a card with an action button so the client cannot
        // unfurl (and thereby consume) it. An expired link, or a refusal with no link at all,
        // has nothing to put on a button — send the text form.
        const template = denied?.reason ? PERSONAL_DENIAL_COPY_BY_LOCALE[locale].get(denied.reason) : undefined;
        // A structured `actionUrl` goes on a button whenever we have one that is usable — including
        // for a reason this build has never seen. Falling straight to text there printed a one-time
        // URL where a client unfurl could fetch and consume the token before the sender tapped it,
        // which is the whole property this delivery path exists to hold. Only a reason KNOWN to
        // have no self-service step (`access_denied`) is excluded, by `rendersActionLink`.
        if (denied && rendersActionLink(denied, locale)) {
          await deliverSingleUseLink(larkClient, messageId, locale, {
            body: template ?? truncateDenialProse(denied.message) ?? PERSONAL_ACCESS_GATED_NOTICE_BY_LOCALE[locale],
            buttonLabel: PERSONAL_DENIAL_BUTTON_BY_LOCALE[locale].get(denied.reason ?? "")
              ?? PERSONAL_DENIAL_BUTTON_NEUTRAL_BY_LOCALE[locale],
            url: denied.actionUrl,
            expiresAtMs: denied.expiresAtMs,
          }, deniedReply);
        } else {
          await replyToLark(larkClient, messageId, deniedReply);
        }
      } else if (!denied && isOpenAccessTier(personalBot.access_mode)) {
        // Open tier AND no refusal at all: the frontend auto-binds, so a missing binding is an
        // anomaly (deactivated config, transient error) rather than a refusal — nothing useful to
        // say. Gated on `!denied` because an explicit refusal we could not render is still a
        // refusal: it must fall through and get the generic notice, not silence.
        console.log(`[lark] No personal binding for open channel=${channelId} sender=${senderOpenId}`);
      } else {
        // Gated tier with no reason from the frontend. MUST still answer: previously any tier
        // this build didn't recognise fell here and only logged, so the sender's message vanished
        // with no reply at all and the bot looked broken. Every gated tier gets the same generic
        // notice — the frontend's `denied` is what makes a refusal specific.
        console.log(`[lark] Personal access gated (no reason) channel=${personalChannelId} sender=${senderOpenId} tier=${personalBot.access_mode}`);
        await replyToLark(larkClient, messageId, formatPersonalGatedReply(personalBot.authorize_url, locale));
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
      senderType: senderType ?? undefined,
      sessionKey: personalSessionKey,
      channelId: personalChannelId,
      route: "personal",
      larkClient,
      agentBoxManager,
      tlsOptions,
      frontendClient,
      locale,
      ticketIntakeEnabled: channelConfig?.ticket_intake_enabled === true,
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

  // /apikey is personal-chat only. Drop it here — silently, and before the @-gate so an
  // @bot mention can't route it to the agent either. A group reply is visible to everyone
  // in the group, and this flow hands back a credential pickup link; answering at all
  // (even "DM me") turns someone's provisioning into group noise.
  if (parseApiKeyCommand(text)) {
    console.log(`[lark] /apikey ignored in group chat=${chatId} — personal chat only`);
    return;
  }

  // Computed here rather than at the @-gate below: /mode needs both.
  const botMentioned = isBotMentioned(message, botOpenId);
  const isThreadFollowup = isGroupMessage && threadId !== null && rootMessageId !== messageId;

  // /mode — summon the context-mode switch card. Command words are exact, and
  // the bot must be @-mentioned: this switches the mode for the WHOLE group, and
  // nothing in the pipeline checks who the sender is (Feishu reports app senders
  // the same way it reports people, sometimes without any id at all). Handling it
  // before the @-gate meant any group member — or any other BOT in the room —
  // could reconfigure the group by typing two words at nobody in particular.
  // Requiring that costs the sender four characters and makes the change an act
  // aimed at us. A follow-up inside a topic WE opened counts too — it is already
  // scoped to a conversation the bot owns, and inside a topic people rightly stop
  // @-ing. Without that second arm, `/mode` in a topic would fall past the @-gate
  // (thread follow-ups are allowed through) and reach the model as a prompt.
  // PAIR stays exempt: it carries its own one-time code.
  if (/^\/mode$/i.test(text.trim()) && (botMentioned || isThreadFollowup)) {
    const modeBinding = await resolveBinding(
      groupChannelId,
      chatId,
      frontendClient!,
      sessionKey,
      senderOpenId ?? undefined,
      undefined,
      false,
      senderType ?? undefined,
    );
    if (isChannelAccessDenied(modeBinding)) {
      await replyToLark(larkClient, messageId, formatGroupAccessDeniedReply(modeBinding, locale, dmCanResolveAccess(personalBot)));
      return;
    }
    if (!modeBinding) {
      await replyToLark(larkClient, messageId, MODE_UNBOUND_NOTICE_BY_LOCALE[locale]);
      return;
    }
    const current: GroupContextMode = modeBinding.contextMode === "shared" ? "shared" : "per_user";
    // /mode changes the whole group. Keep a root invocation visible on the
    // main-group path; only retain the card inside an already-established Topic.
    const modeReplyInThread = isThreadFollowup && current === "per_user";
    rememberGroupMode(groupChannelId, chatId, current);
    const sent = await sendModeCard(larkClient, messageId, current, groupChannelId, chatId, locale, modeReplyInThread);
    if (!sent) {
      await replyToLark(larkClient, messageId, `${MODE_LABEL_BY_LOCALE[locale][current]}`, modeReplyInThread);
    }
    return;
  }

  // Only respond when THIS bot is individually @-mentioned, except inside a
  // topic that personal mode already scoped to a root message. Feishu also
  // delivers "@所有人" to an @bot-scoped app (it mentions everyone, the bot
  // included), so an @所有人 announcement arrives looking just like a real
  // @bot — without this gate the bot replies to group-wide announcements that
  // were never aimed at it. Skips "@所有人" and "@someone-else"; PAIR above is
  // exempt (explicit command). Gated on chat_type==="group" so the binding/
  // access checks below stay reachable only for messages aimed at the bot.
  const conversationExistingOnly = isThreadFollowup && !botMentioned;
  if (chatType === "group" && !botMentioned) {
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
      return;
    }
    if (!isThreadFollowup) {
      console.log(`[lark] Group message not directed at bot (chat=${chatId}) — ignoring (@所有人 / @others / no @bot)`);
      return;
    }
  }

  // Look up binding for this chat. Pass sender_open_id so the Portal can
  // auto-bind / per-sender resolve group bots and pick the session key.
  const binding = await resolveBinding(
    groupChannelId,
    chatId,
    frontendClient!,
    sessionKey,
    senderOpenId ?? undefined,
    topicConversationKey,
    conversationExistingOnly,
    senderType ?? undefined,
  );
  if (isChannelAccessDenied(binding)) {
    // A no-@ Topic/quote follow-up is never an authorization prompt. If the
    // server cannot reuse an existing authorized topic session, stay silent;
    // explicit @ messages still receive the normal access hint.
    if (conversationExistingOnly) return;
    // Gated group: this sender isn't allowed. The message is either an explicit @ or a follow-up
    // in a previously established bot topic, so a single short hint is appropriate.
    await replyToLark(larkClient, messageId, formatGroupAccessDeniedReply(binding, locale, dmCanResolveAccess(personalBot)));
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
  //   - personal topic → <participant-key>:lark_thread:<root message>
  //   - shared group → chat:<route-key> (topic candidates are ignored)
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

  // A no-@ message inside a Feishu topic is a continuation only in personal
  // mode. Team mode deliberately stays on the old main-group path; an
  // unrelated/manual topic must not wake the shared Agent session.
  if (isThreadFollowup && !botMentioned && contextMode === "shared") {
    if (text.length > 0) {
      appendDiscussion(groupChannelId, chatId, senderLabel(senderOpenId), text);
      console.log(`[lark] Buffered no-@ topic discussion after resolving shared group chat=${chatId}`);
    }
    return;
  }

  const personalTopicMode = isGroupMessage && contextMode === "per_user";
  const conversationKey = personalTopicMode ? topicConversationKey : undefined;
  const replyInThread = personalTopicMode;
  const effectiveSessionKey = binding.sessionKey ?? "";
  const queueKey = `${binding.bindingId}:${binding.sessionKey ?? "__binding__"}`;
  const queued = enqueueBindingTask(queueKey, () => processQueuedLarkMessage({
    text,
    imageRefs,
    messageId,
    chatId,
    senderOpenId,
    senderType: senderType ?? undefined,
    sessionKey: effectiveSessionKey,
    channelId: groupChannelId,
    route: "group",
    contextMode,
    conversationKey,
    rootMessageId,
    threadId,
    replyInThread,
    conversationExistingOnly,
    larkClient,
    agentBoxManager,
    tlsOptions,
    frontendClient,
    locale,
    ticketIntakeEnabled: channelConfig?.ticket_intake_enabled === true,
  }));
  if (!queued.accepted) {
    await replyToLark(larkClient, messageId, QUEUE_FULL_NOTICE_BY_LOCALE[locale], replyInThread);
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
  /** Provider's own sender kind ("user" / "app" / …), verbatim; absent if the event had none. */
  senderType?: string;
  sessionKey: string;
  channelId: string;
  route: "group" | "personal";
  /** Group route only: "shared" drains the discussion buffer into the prompt
   *  and attributes the asker; absent/"per_user" behaves as an isolated chat. */
  contextMode?: GroupContextMode;
  /** Provider-native conversation scope. For Feishu topics this is rooted at
   *  the root message id and remains stable before/after thread_id exists. */
  conversationKey?: string;
  rootMessageId?: string;
  threadId?: string | null;
  replyInThread?: boolean;
  /** No-@ topic follow-ups may reuse an existing topic session, but must never
   *  create one for an unrelated Feishu topic. */
  conversationExistingOnly?: boolean;
  larkClient: any;
  agentBoxManager: AgentBoxManager;
  tlsOptions?: { cert: string; key: string; ca: string };
  frontendClient?: FrontendWsClient;
  locale: "zh-CN" | "en-US";
  ticketIntakeEnabled?: boolean;
}

async function processQueuedLarkMessage(ctx: QueuedLarkMessageContext): Promise<void> {
  const {
    text,
    imageRefs,
    messageId,
    chatId,
    senderOpenId,
    senderType,
    sessionKey,
    channelId,
    route,
    contextMode,
    conversationKey,
    rootMessageId,
    threadId,
    replyInThread = false,
    conversationExistingOnly = false,
    larkClient,
    agentBoxManager,
    tlsOptions,
    frontendClient,
    locale,
    ticketIntakeEnabled = false,
  } = ctx;

  if (/^\/new$/i.test(text)) {
    // A shared group has ONE group-level session, so a single member's /new
    // would clear everyone's context — reject it instead of resetting. (A
    // confirmation-gated "reset the whole room" is deferred.) per_user groups
    // and personal chats reset the caller's own session as before.
    if (contextMode === "shared" && !conversationKey) {
      await replyToLark(larkClient, messageId, SHARED_NEW_REJECTED_NOTICE_BY_LOCALE[locale], replyInThread);
      return;
    }
    await handleNewCommand(
      route,
      channelId,
      chatId,
      sessionKey,
      messageId,
      larkClient,
      agentBoxManager,
      tlsOptions,
      frontendClient,
      locale,
      replyInThread,
    );
    return;
  }

  // After the command branch (matched on the raw text): an image whose caption
  // is exactly a command word (e.g. "/new") is routed as that command and its
  // image dropped — an accepted edge, since commands are exact-match only.
  // An image-only message has empty text, so give it a placeholder. Replace
  // `text` uniformly here (not just in promptOpts) so the session title,
  // persisted user row, and logs all show "user sent image(s)".
  const effectiveText = text.length === 0 && imageRefs.length > 0 ? IMAGE_ONLY_PLACEHOLDER : text;

  const binding = await resolveQueuedBinding(
    route,
    channelId,
    chatId,
    senderOpenId,
    frontendClient!,
    sessionKey,
    conversationKey,
    conversationExistingOnly,
    senderType,
  );
  if (!binding) {
    console.log(`[lark] Binding disappeared before queued run channel=${channelId} chat=${chatId} route=${route}`);
    return;
  }
  if (!binding.createdBy) {
    await replyToLark(larkClient, messageId, MISSING_OWNER_NOTICE_BY_LOCALE[locale], replyInThread);
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
      metadata: {
        source: "lark",
        channelId,
        chatId,
        messageId,
        bindingId: binding.bindingId,
        senderOpenId,
        sessionKey,
        route,
        ...(conversationKey ? { conversationKey } : {}),
        ...(rootMessageId ? { rootMessageId } : {}),
        ...(threadId ? { threadId } : {}),
      },
    });
  } catch (err) {
    console.error(`[lark] Failed to persist channel user message session=${sessionId}:`, err);
    await replyToLark(
      larkClient,
      messageId,
      `❌ ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
      replyInThread,
    );
    return;
  }

  // The intake is opt-in: this query can only find a row created by the
  // requester's earlier card click. In a shared group it is scoped by both
  // session and open_id, so two members can collect independent drafts.
  let activeTicketIntake: TicketIntakeRecord | null = null;
  if (ticketIntakeEnabled && senderOpenId) {
    try {
      activeTicketIntake = await getActiveTicketIntake(sessionId, senderOpenId, frontendClient);
    } catch (err) {
      console.warn(`[lark] Failed to load active ticket intake session=${sessionId}:`, err);
    }
  }

  // Open the typing-indicator card FIRST so the user sees immediate feedback.
  // If the CardKit APIs fail we fall back to posting a plain text reply
  // once the agent is done (preserves the pre-card behaviour).
  const cardSession = await openTypingCard(
    larkClient,
    messageId,
    PLACEHOLDER_BY_LOCALE[locale],
    replyInThread,
  );
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
        const delivered = await deliverVisibleChannelText(
          larkClient,
          messageId,
          cardSession,
          md,
          true,
          replyInThread,
        );
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
      // contentOk, not ok: a failed streaming-mode flip still shows the answer,
      // so only a body that never landed justifies a second message.
      const { contentOk } = await finalizeCard(larkClient, cardSession, md);
      if (contentOk) {
        deliveredTextChars = md.length;
        return true;
      }
      console.warn(`[lark] Background card update failed for session=${sessionId}; posting a replacement card`);
    }
    await deliverAnswerOutsideCard(larkClient, messageId, md, replyInThread);
    deliveredTextChars = md.length;
    return true;
  });

  // One turn at a time for this session. The AgentBox's own 409 only sees its own
  // sessions, so once an agent runs more than one box two messages could be dispatched to
  // two boxes and both would run — two writers on one transcript. Released in the finally
  // that closes the agent-execution block below.
  let resultText = "";
  let replyImages: RenderedReplyImage[] = [];
  let assistantMessageId: string | null = null;
  let agentError: Error | null = null;
  let sessionBusy = false;
  // Acquired INSIDE the try so a busy session surfaces through the SAME path the
  // AgentBox's 409 already used — the friendly "still working" notice. Outside it the
  // rejection escaped every handler and the user got nothing at all.
  let releaseTurn: (() => void) | undefined;
  try {
    releaseTurn = await sessionTurnLocks.acquire(sessionId);
  // Get or create AgentBox for this agent (shared across all callers).
  const handle = await agentBoxManager.getOrCreate(agentId, undefined, sessionId);
  sessionTurnLocks.noteBox(sessionId, handle.boxId, handle.endpoint);
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
  const drained = contextMode === "shared" && !conversationKey
    ? drainDiscussion(channelId, chatId)
    : undefined;
  const sharedContext: SharedGroupContext | undefined = drained
    ? { discussion: drained.lines, truncated: drained.truncated, asker: senderLabel(senderOpenId) }
    : undefined;
  const agentPromptText = activeTicketIntake
    ? `${buildChannelTurnPrompt(promptText, sharedContext)}\n\n${buildTicketIntakeAgentContext(activeTicketIntake)}`
    : buildChannelTurnPrompt(promptText, sharedContext);
  const promptOpts: PromptOptions = {
    text: agentPromptText,
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
  try {
    // queue-until-idle: wait out a busy session instead of dumping a raw 409.
    const promptResult = await promptWithBusyRetry(client, promptOpts);
    void bindMessageTraceId(promptMessageId, promptResult.sessionId, promptResult.traceId).catch((bindErr) => {
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
    assistantMessageId = collected.assistantMessageId;
    if (activeTicketIntake && senderOpenId) {
      try {
        activeTicketIntake = await getActiveTicketIntake(sessionId, senderOpenId, frontendClient);
      } catch (err) {
        console.warn(`[lark] Failed to refresh ticket intake session=${sessionId}:`, err);
      }
    }
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
  } finally {
    releaseTurn?.();
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
  let finalCardBody = buildMilestoneCardMarkdown({ milestones: [], finalText: displayBody });
  if (!agentError && activeTicketIntake?.state === "review") {
    finalCardBody += `\n\n${buildTicketIntakeReviewMarkdown(activeTicketIntake, locale)}`;
  }

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
    const ticketIntakeCard: { ctx: TicketIntakeCardContext; locale: LarkLocale } | undefined =
      isAnswer && ticketIntakeEnabled && senderOpenId
        ? activeTicketIntake
          ? {
              ctx: {
                mode: "active", intakeId: activeTicketIntake.id, revision: activeTicketIntake.revision,
                requesterExternalId: senderOpenId, sourceMessageId: messageId,
                reviewable: activeTicketIntake.state === "review",
              },
              locale,
            }
          : {
              ctx: { mode: "start", sessionId, channelId, requesterExternalId: senderOpenId, sourceMessageId: messageId },
              locale,
            }
        : undefined;
    const { ok, contentOk } = await finalizeCard(larkClient, cardSession, finalCardBody,
      isAnswer && assistantMessageId
        ? { ctx: { sessionId, channelId, messageId: assistantMessageId }, locale }
        : undefined,
      ticketIntakeCard);
    deliveredTextChars = finalCardBody.length;
    if (!contentOk) {
      // The body never landed (rejected update / oversized answer), so the card
      // is frozen on its ⏳ placeholder and the answer would exist ONLY in the
      // DB — visible in Portal, invisible in the group. A text reply here is not
      // a duplicate: nothing else delivered this answer.
      console.error(`[lark] Card body not delivered for cardId=${cardSession.cardId}; posting a replacement card`);
      await deliverAnswerOutsideCard(
        larkClient,
        messageId,
        finalCardBody,
        replyInThread,
        isAnswer && assistantMessageId
          ? { ctx: { sessionId, channelId, messageId: assistantMessageId }, locale }
          : undefined,
        ticketIntakeCard,
      );
    } else if (!ok) {
      // Content landed, only the streaming-mode flip failed: the answer IS
      // visible, so a second message would duplicate it.
      console.warn(`[lark] Card finalize incomplete for cardId=${cardSession.cardId}; answer delivered but card stays in streaming state`);
    }
  } else if (resultText || agentError || sessionBusy) {
    // Card could not be opened; fall back to a plain text reply with whatever we have —
    // a real answer, an error notice, OR the session-busy notice (sessionBusy carries no
    // resultText/agentError, so it must be listed explicitly or the busy notice is dropped).
    await replyToLark(larkClient, messageId, finalCardBody, replyInThread);
    deliveredTextChars = finalCardBody.length;
  }

  await replyVisualImages(larkClient, messageId, replyImages, replyInThread);
}

async function resolveQueuedBinding(
  route: "group" | "personal",
  channelId: string,
  chatId: string,
  senderOpenId: string | null,
  frontendClient: FrontendWsClient,
  sessionKey: string,
  conversationKey?: string,
  conversationExistingOnly: boolean = false,
  senderType?: string,
): Promise<ResolvedChannelBinding | null> {
  if (route === "personal") {
    if (!senderOpenId) return null;
    // Re-resolved after dequeue purely to detect revocation; the refusal reason was already
    // delivered before enqueue, so only the binding matters here.
    return (await resolvePersonalBinding(channelId, senderOpenId, frontendClient, senderType)).binding;
  }
  const result = await resolveBinding(
    channelId,
    chatId,
    frontendClient,
    sessionKey,
    senderOpenId ?? undefined,
    conversationKey,
    conversationExistingOnly,
    senderType,
  );
  // If access was revoked between enqueue and run, treat as gone (the queued
  // task then skips). The pre-enqueue check already replied any access hint.
  return isChannelAccessDenied(result) ? null : result;
}

/**
 * Minutes left before `expiresAtMs`, or null when there is nothing trustworthy to show.
 *
 * Floored at 1 so a link that is still usable never reads "0 minutes". Rejects `<= 0` and
 * non-finite input, and — importantly — anything out of `Date` range: `Intl.DateTimeFormat`
 * THROWS past ±8.64e15 while `Number.isFinite` waves it through, and here that throw would
 * replace the user's only path forward with a generic error.
 */
/**
 * Generic gated-tier notice, used when the frontend gave no refusal reason.
 *
 * When a console URL is configured it is the sender's OWN self-service page, so the copy must tell
 * them to open it — the previous wording sent them to an admin while dangling that very link, and
 * an admin cannot link someone else's chat account for them. Only with no URL is "ask an admin"
 * the honest instruction.
 */
function formatPersonalGatedReply(authorizeUrl: string | undefined, locale: LarkLocale): string {
  const base = PERSONAL_ACCESS_GATED_NOTICE_BY_LOCALE[locale];
  if (!authorizeUrl) return `${base}\n${PERSONAL_ACCESS_ADMIN_HINT_BY_LOCALE[locale]}`;
  return `${base}\n${PERSONAL_ACCESS_SELF_SERVE_HINT_BY_LOCALE[locale]}\n${authorizeUrl}`;
}

function minutesUntil(expiresAtMs: number | undefined, now = Date.now()): number | null | "expired" {
  if (typeof expiresAtMs !== "number" || !Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return null;
  if (Number.isNaN(new Date(expiresAtMs).getTime())) return null;
  const remaining = expiresAtMs - now;
  // Distinguished from `null` on purpose: "already dead" and "no deadline given" must not render
  // the same way, or a lapsed link is presented as usable. Reachable through ordinary clock skew
  // between the issuing frontend and this pod plus event-delivery latency, not just a stale send.
  if (remaining <= 0) return "expired";
  // FLOOR, not round: rounding up overstates a single-use link's life by up to 30s, so a sender
  // who follows "within 2 minutes" at 1m50s finds it already gone. The 1-minute floor keeps a
  // still-valid link from reading "0 minutes".
  return Math.max(1, Math.floor(remaining / 60_000));
}

/**
 * Whether pointing a refused group sender at the private chat would actually get them anywhere.
 *
 * Requires a personal bot that is itself GATED: an `open` one binds the sender on first message and
 * offers no authorization step, so "DM me" would be a dead end — and the console URL the group
 * reply would otherwise carry was the only path they had.
 */
function dmCanResolveAccess(personalBot: LarkChannelConfig["personal_bot"]): boolean {
  return Boolean(personalBot) && !isOpenAccessTier(personalBot!.access_mode);
}

/** A link is only ever rendered when it is plain http(s). Everything else in `denied` is treated as
 *  untrusted, and this value reaches a Feishu `open_url` button, where other schemes resolve as
 *  deeplinks. An unusable value is withheld exactly like a missing one. */
function isRenderableActionUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const scheme = new URL(url).protocol;
    return scheme === "https:" || scheme === "http:";
  } catch {
    return false;
  }
}

/** True when this reason has a self-service step the sender can actually take (i.e. a button label
 *  exists for it). `access_denied` has none, so an actionUrl arriving on it must not be rendered as
 *  "click to continue" directly under "ask the owner". */
function offersSelfService(reason: string | undefined, locale: LarkLocale): boolean {
  return Boolean(reason && PERSONAL_DENIAL_BUTTON_BY_LOCALE[locale].has(reason));
}

/** True only for a reason this build knows to carry NO self-service step. An unknown reason is not
 *  in this set: we cannot claim it has no step, and withholding its link would strand the sender. */
function knownLinklessReason(reason: string | undefined, locale: LarkLocale): boolean {
  return Boolean(reason
    && PERSONAL_DENIAL_COPY_BY_LOCALE[locale].has(reason)
    && !PERSONAL_DENIAL_BUTTON_BY_LOCALE[locale].has(reason));
}

/** Neutral button label for a reason this build does not know. Used ONLY for an unknown reason: it
 *  keeps a structured one-time URL on a button instead of printing it as text, where a client
 *  unfurl could fetch and consume the token. A reason KNOWN to have no self-service step
 *  (`access_denied`) still gets no button at all — a verb describing nothing is worse than none. */
const PERSONAL_DENIAL_BUTTON_NEUTRAL_BY_LOCALE: Record<LarkLocale, string> = {
  "zh-CN": "继续",
  "en-US": "Continue",
};

/** The one predicate for "render a link for this refusal": the reason has a step the sender can
 *  take, AND the URL is something we are willing to put in front of them. Narrows `actionUrl` to
 *  defined so callers need no assertions. */
function rendersActionLink(
  denied: PersonalAccessDenied,
  locale: LarkLocale,
): denied is PersonalAccessDenied & { actionUrl: string } {
  // Deny-list, not allow-list: an UNKNOWN reason must still get its link (withholding it strands
  // the sender), so only a reason we KNOW carries no step is excluded. `offersSelfService` remains
  // the allow-list, but its job is choosing the button LABEL — using it here made the formatter
  // disagree with the dispatch and silently dropped unknown-reason links.
  return !knownLinklessReason(denied.reason, locale) && isRenderableActionUrl(denied.actionUrl);
}

/** Bound the frontend's free-form prose. Applied to prose ONLY — never to a URL or to our own
 *  lines, since a truncated link is a guaranteed dead one. */
function truncateDenialProse(prose: unknown): string | undefined {
  if (typeof prose !== "string" || !prose.trim()) return undefined;
  return prose.length > PERSONAL_DENIAL_MESSAGE_MAX_CHARS
    ? `${prose.slice(0, PERSONAL_DENIAL_MESSAGE_MAX_CHARS)}…`
    : prose;
}

/**
 * Deliver a single-use link as a CARD with an action button, falling back to plain text.
 *
 * Preferred over text because a bare URL gets unfurled by the client for a link preview, and an
 * automated fetch of a one-time token can burn the sender's only chance to use it. Returns whether
 * anything reached the sender at all, so a caller that has already committed a side effect (see
 * `/apikey`, which rotates before it can reply) can still escalate a total delivery failure.
 */
async function deliverSingleUseLink(
  larkClient: any,
  messageId: string,
  locale: LarkLocale,
  card: { body: string; buttonLabel: string; url: string; expiresAtMs?: number },
  textFallback: string,
): Promise<boolean> {
  const remaining = minutesUntil(card.expiresAtMs);
  // Re-checked HERE, not just when the reply was composed: a link can lapse between the two, and
  // the render decision earlier says nothing about the state at the send boundary. An expired link
  // must reach neither the button nor the text — hand over the resend instruction instead, which is
  // the only thing that actually helps (the frontend mints a fresh link on the next message).
  if (remaining === "expired") {
    // The body may itself embed the URL (an unknown reason renders the frontend's prose), so it
    // cannot be reused verbatim here — that put the dead link back in the text and made the
    // boundary invariant false for exactly the case it was added to cover. Swap in a URL-free
    // notice when the body carries the link.
    const urlFreeBody = card.body.includes(card.url)
      ? PERSONAL_ACCESS_GATED_NOTICE_BY_LOCALE[locale]
      : card.body;
    return replyToLark(larkClient, messageId, `${urlFreeBody}\n${PERSONAL_DENIAL_LINK_EXPIRED_BY_LOCALE[locale]}`);
  }
  const sent = await sendLinkActionCard(larkClient, messageId, {
    body: card.body,
    note: SINGLE_USE_LINK_NOTE_BY_LOCALE[locale](remaining),
    buttonLabel: card.buttonLabel,
    url: card.url,
  });
  if (sent) return true;
  // Card creation can fail (API error, missing scope). The link is the whole point of the message,
  // so degrade to the text form rather than dropping it.
  return replyToLark(larkClient, messageId, textFallback);
}

/**
 * Personal-chat refusal copy. Renders from the contract `reason` so both locales are served;
 * falls back to the frontend's non-localized `message` only when this build has no template for
 * the reason, and returns null when it has neither (caller then emits its generic notice).
 *
 * Sibling of {@link formatGroupAccessDeniedReply} — keep the two together. They are deliberately
 * NOT unified: this one may carry a SINGLE-USE `actionUrl`, and the group variant must never
 * carry one (any member could open it and bind the sender's chat identity to their own account).
 */
function formatPersonalDenialReply(denied: PersonalAccessDenied, locale: LarkLocale): string | null {
  const template = denied.reason ? PERSONAL_DENIAL_COPY_BY_LOCALE[locale].get(denied.reason) : undefined;
  // Only the frontend's free-form prose is capped. The URL and our own lines must stay intact:
  // truncating a link GUARANTEES a dead one, which is the very outcome the expired-link branch
  // exists to avoid, and the platform's text limit sits far above anything we render here.
  const offersLink = rendersActionLink(denied, locale);
  // Falling back to the GENERIC notice rather than null when a link must still be delivered:
  // returning null stranded a refusal that carried a usable `actionUrl` but no prose — the caller
  // dropped to its own generic text and the structured link was lost entirely.
  const body = template
    ?? truncateDenialProse(denied.message)?.trim()
    ?? (offersLink ? PERSONAL_ACCESS_GATED_NOTICE_BY_LOCALE[locale] : undefined);
  if (!body) return null;
  const lines = [body];
  // Link delivery is decided by whether we HAVE a usable link, never by whether prose was supplied
  // — coupling the two is what lost the link on the prose-less and card-failure paths. Duplication
  // is prevented by checking the prose we are about to send, not by skipping the append wholesale:
  // the frontend's message MAY embed its own copy of the URL, and only then must we not add a second.
  if (offersLink) {
    const remaining = minutesUntil(denied.expiresAtMs);
    if (remaining === "expired") {
      lines.push(PERSONAL_DENIAL_LINK_EXPIRED_BY_LOCALE[locale]);
    } else if (!body.includes(denied.actionUrl)) {
      lines.push(PERSONAL_DENIAL_LINK_HINT_BY_LOCALE[locale](remaining), denied.actionUrl);
    }
  }
  return lines.join("\n");
}

/**
 * Build the access-denied reply for a gated group, in the channel's
 * locale. Appends the authorize URL for the "unbound" case.
 *
 * `authorizeUrl` here is a shareable console address. NEVER let a single-use link reach this
 * path — see {@link formatPersonalDenialReply} and `PersonalAccessDenied`.
 */
function formatGroupAccessDeniedReply(
  denied: ChannelAccessDenied,
  locale: "zh-CN" | "en-US",
  hasPersonalBot = false,
): string {
  // Only the explicit not-linked reason claims "you haven't linked yet". Every other value —
  // including one this build has never seen — gets the generic line: it is never wrong, whereas
  // telling an already-linked sender to go link sends them round a loop with no exit.
  const notLinked = denied.reason === "unbound";
  const base = notLinked
    ? GROUP_ACCESS_UNBOUND_NOTICE_BY_LOCALE[locale]
    : GROUP_ACCESS_DENIED_NOTICE_BY_LOCALE[locale];

  // Prefer the private chat: the room sees this reply, and the DM resolves the sender's actual next
  // step per person. NOTE this is a UX judgement, not a leak fix — the single-use `actionUrl` lives
  // on `PersonalAccessDenied` and the type separation already keeps it out of this renderer, which
  // only ever carries the shareable console `authorizeUrl`.
  //
  // Gated on the personal bot being ABLE to resolve it: an `open` personal bot binds the sender
  // immediately and offers no authorization step at all, so "DM me" would be a dead end — and the
  // console URL we would otherwise have shown is the only path they had.
  if (hasPersonalBot) return `${base}\n${GROUP_ACCESS_DM_HINT_BY_LOCALE[locale]}`;

  // Group-only channel: no DM answers here, so the console URL is the only path left. Offer it as
  // an instruction ONLY for the not-linked case — that page is the linking step. For a sender who
  // is already linked but lacks access, telling them to "complete authorization" there points at
  // something they have already done, which is the same loop; name the admin route instead.
  return notLinked && denied.authorizeUrl
    ? `${base}\n${GROUP_ACCESS_SELF_SERVE_HINT_BY_LOCALE[locale]}\n${denied.authorizeUrl}`
    : `${base}\n${GROUP_ACCESS_ADMIN_HINT_BY_LOCALE[locale]}`;
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
  replyInThread: boolean = false,
): Promise<void> {
  const reset = route === "personal"
    ? await resetPersonalSession(channelId, sessionKey, frontendClient!)
    : await resetBindingSession(channelId, chatId, frontendClient!, sessionKey);
  if (!reset.success || !reset.sessionId || !reset.agentId) {
    await replyToLark(larkClient, messageId, `❌ ${reset.error ?? "Failed to reset session"}`, replyInThread);
    return;
  }

  if (reset.oldSessionId) {
    sessionRegistry.forget(reset.oldSessionId);
    try {
      // The OLD session id, not none: closeSession has to reach the box that actually
      // holds it. Without it a pooled agent closes on an arbitrary box, the real session
      // stays resident forever (pooled boxes never idle out), and that box never drains.
      const handle = await agentBoxManager.getOrCreate(reset.agentId, undefined, reset.oldSessionId);
      const client = new AgentBoxClient(handle.endpoint, 120_000, tlsOptions);
      await client.closeSession(reset.oldSessionId);
    } catch (err) {
      console.error(`[lark] Failed to close old session=${reset.oldSessionId} on /new:`, err);
    }
  }

  await replyToLark(larkClient, messageId, NEW_SESSION_NOTICE_BY_LOCALE[locale], replyInThread);
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

/**
 * The whole `/apikey …` namespace. Intentionally has NO trailing word boundary: `\b` lets
 * `/apikeys` slip through to the agent, which both breaks the documented "runtime claims the
 * whole namespace" contract and — in a group — routes credential-adjacent text to the model in
 * a room where this flow must stay invisible. Anything starting with `/apikey` is claimed and
 * answered deterministically instead.
 */
const API_KEY_COMMAND_RE = /^\/apikey/i;

/**
 * Parse a `/apikey …` message, or null when the text is outside the namespace. Shared by the
 * personal-chat handler and the group drop-gate so the two can never claim different sets — the
 * group side is the one whose failure mode is leaking a credential reply into a room.
 */
function parseApiKeyCommand(text: string): { subcommand: string } | null {
  const trimmed = text.trim();
  if (!API_KEY_COMMAND_RE.test(trimmed)) return null;
  return { subcommand: trimmed.slice("/apikey".length).trim().toLowerCase() };
}

/**
 * `/apikey` requests in flight, keyed by `${channelId}:${senderOpenId}`. Issuing rotates, and
 * this command deliberately bypasses the per-binding queue that serialises ordinary messages,
 * so without this a double-tap (or a Feishu at-least-once redelivery) mints two keys: the user
 * opens the first link they see and collects a key the second rotation already invalidated.
 */
const apiKeyRequestsInFlight = new Set<string>();

/** Display time zone per locale, so a rendered timestamp means what the reader expects. */
const API_KEY_TIME_ZONE_BY_LOCALE: Record<LarkLocale, string> = {
  "zh-CN": "Asia/Shanghai",
  "en-US": "UTC",
};

/**
 * Render an epoch-ms instant for `/apikey` copy. Uses the `sv-SE` locale purely for its
 * ISO-like `YYYY-MM-DD HH:mm` output — the format must not drift with the host's default
 * locale, or the copy stops being testable. Returns null for a missing/invalid value so
 * callers can just drop the line.
 */
function formatApiKeyTimestamp(
  epochMs: number | undefined,
  locale: LarkLocale,
  withTime: boolean,
): string | null {
  // `<= 0` covers a zero/negative timestamp (a NOT NULL column's zero value, or a Go zero
  // time) — rendering that as "1970-01-01" would tell the user their live key expired 55 years
  // ago. The Invalid-Date check is load-bearing, not paranoia: `Intl.format` THROWS RangeError
  // past ±8.64e15 (e.g. a frontend that sends nanoseconds), `Number.isFinite` happily passes
  // such a value, and the throw would surface as "service unavailable" AFTER the key was
  // already rotated — leaving the user permanently unable to see any pickup link.
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || epochMs <= 0) return null;
  if (Number.isNaN(new Date(epochMs).getTime())) return null;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: API_KEY_TIME_ZONE_BY_LOCALE[locale],
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(new Date(epochMs));
}

/**
 * `/apikey` reply. On success this carries the single-use pickup link — never the key
 * itself (plaintext must not enter a searchable, exportable chat log).
 *
 * `rotated` MUST be called out: the requester's old key dies instantly, and an unexplained
 * break gets reported as a bug by whoever had it configured in an MCP client. On failure the
 * frontend's `error` is already user-facing wording, so it is surfaced verbatim.
 */
function formatApiKeyIssueReply(result: PersonalApiKeyIssueResult, locale: LarkLocale): string {
  if (!result.success || !result.pickupUrl) {
    // An authorization refusal carries `denied`, rendered with copy about the action the sender
    // attempted — a single ❌ line, then how to resume. Other failure exits have no `denied` and
    // fall through to `error` (a non-localized English fallback) unchanged.
    const localized = result.denied ? formatApiKeyDenialReply(result.denied, locale) : null;
    if (localized) return localized;
    // `denied.message` before `error`: it is defined as the fallback for a reason this build has no
    // template for, so discarding it in favour of a generic "unknown error" throws away the only
    // explanation the sender was given. Bounded on the way through, like every other prose field.
    const reason = truncateDenialProse(result.denied?.message)
      ?? result.error
      ?? (locale === "en-US" ? "unknown error" : "未知错误");
    return locale === "en-US"
      ? `❌ Could not issue an API key: ${reason}`
      : `❌ 领取 API Key 失败: ${reason}`;
  }
  const linkExpiry = formatApiKeyTimestamp(result.expiresAt, locale, true);
  const lines =
    locale === "en-US"
      ? [
          result.rotated
            ? "✅ New API key generated — your PREVIOUS key is now invalid. Update anything configured with it."
            : "✅ Your API key is ready.",
          "Open it now — the link works only ONCE and expires shortly:",
          result.pickupUrl,
          linkExpiry ? `Link expires at: ${linkExpiry}` : "",
          "Send /apikey status any time to check the key's own expiry.",
        ]
      : [
          result.rotated
            ? "✅ 已为你生成新的 API Key（旧 Key 已失效，如有配置请更新）"
            : "✅ 你的 API Key 已就绪",
          "请立即点击查看：仅可打开一次，且很快过期：",
          result.pickupUrl,
          linkExpiry ? `链接过期时间：${linkExpiry}` : "",
          "随时发送 /apikey status 查看 Key 本身的失效时间",
        ];
  return lines.filter(Boolean).join("\n");
}

const API_KEY_PICKUP_BUTTON_BY_LOCALE: Record<LarkLocale, string> = {
  "zh-CN": "查看 API Key",
  "en-US": "View API key",
};

/**
 * `/apikey` refusal copy, per reason — phrased around the ACTION the sender attempted.
 *
 * Reusing the generic admission copy here stacked TWO ❌ lines for one refusal ("issuing failed",
 * then "using this assistant requires…") and talked about *using the assistant* when the sender
 * had asked for a key. One line, about the thing they tried to do.
 *
 * `resume` is not decoration: after linking or approval nothing happens on its own, so without
 * "come back and send /apikey again" the sender finishes the web step and assumes the flow broke.
 */
const API_KEY_DENIAL_COPY_BY_LOCALE: Record<LarkLocale, Map<string, { lead: string; resume?: string }>> = {
  "zh-CN": new Map([
    ["binding_required", { lead: "❌ 领取 API Key 需要先关联账号。", resume: "关联完成后回来重发 /apikey" }],
    ["access_request_required", { lead: "❌ 领取 API Key 需要该 Agent 的使用授权。", resume: "审批通过后回来重发 /apikey" }],
    ["access_denied", { lead: "❌ 你没有该 Agent 的使用权限，且未开放自助申请，请联系负责人。" }],
  ]),
  "en-US": new Map([
    ["binding_required", { lead: "❌ Getting an API key requires linking your account first.", resume: "Once linked, send /apikey again." }],
    ["access_request_required", { lead: "❌ Getting an API key requires access to this agent.", resume: "Once approved, send /apikey again." }],
    ["access_denied", { lead: "❌ You don't have access to this agent and self-service requests are closed — ask its owner." }],
  ]),
};

/**
 * Card form of an `/apikey` refusal, or null when there is no live link to sit on a button
 * (`access_denied` offers none, and an expired one must never be handed over).
 */
function buildApiKeyDenialCard(
  denied: PersonalAccessDenied | undefined,
  locale: LarkLocale,
): { body: string; buttonLabel: string; url: string; expiresAtMs?: number } | null {
  if (!denied || minutesUntil(denied.expiresAtMs) === "expired") return null;
  // No self-service step (or an unusable URL) ⇒ no button. `access_denied` says "ask the owner";
  // a generic button under that sentence points nowhere the sender can act on.
  if (!rendersActionLink(denied, locale)) return null;
  const copy = apiKeyDenialCopy(denied, locale);
  if (!copy) return null;
  return {
    // The resume line belongs in the BODY, not the footnote: it is what stops the sender from
    // thinking the flow ended once the web step finishes.
    body: copy.resume ? `${copy.lead}\n${copy.resume}` : copy.lead,
    buttonLabel: PERSONAL_DENIAL_BUTTON_BY_LOCALE[locale].get(denied.reason ?? "")
      ?? PERSONAL_DENIAL_BUTTON_NEUTRAL_BY_LOCALE[locale],
    url: denied.actionUrl,
    expiresAtMs: denied.expiresAtMs,
  };
}

/** Fallback `/apikey` copy for a reason this build does not know. Without it the copy lookup vetoed
 *  a refusal `rendersActionLink` had already accepted, and a future reason's structured link was
 *  dropped on the very version-skew path the contract must keep usable. */
const API_KEY_DENIAL_GENERIC_BY_LOCALE: Record<LarkLocale, { lead: string; resume: string }> = {
  "zh-CN": { lead: "❌ 领取 API Key 需要先获得授权。", resume: "完成后回来重发 /apikey" },
  "en-US": { lead: "❌ Getting an API key requires authorization first.", resume: "Once done, send /apikey again." },
};

/**
 * Copy for an `/apikey` refusal: the reason's own wording when known, else the generic pair — but
 * only when there is actually a link to offer. A reason with neither known copy nor an actionable
 * link has nothing `/apikey`-specific to say and falls through to the frontend's `error`.
 */
function apiKeyDenialCopy(
  denied: PersonalAccessDenied,
  locale: LarkLocale,
): { lead: string; resume?: string } | undefined {
  const known = denied.reason ? API_KEY_DENIAL_COPY_BY_LOCALE[locale].get(denied.reason) : undefined;
  if (known) return known;
  return rendersActionLink(denied, locale) ? API_KEY_DENIAL_GENERIC_BY_LOCALE[locale] : undefined;
}

/** `/apikey` refusal in text form: one ❌ line, the link, then how to resume. */
function formatApiKeyDenialReply(denied: PersonalAccessDenied, locale: LarkLocale): string | null {
  const copy = apiKeyDenialCopy(denied, locale);
  if (!copy) return null;
  const lines = [copy.lead];
  // Nested, not chained: a reason with no self-service step must say NOTHING about links. Chaining
  // the expired notice onto `actionUrl` alone told `access_denied` senders their live link had
  // expired and to resend — and the resend refuses identically.
  if (rendersActionLink(denied, locale)) {
    const remaining = minutesUntil(denied.expiresAtMs);
    if (remaining === "expired") {
      lines.push(PERSONAL_DENIAL_LINK_EXPIRED_BY_LOCALE[locale]);
    } else {
      lines.push(PERSONAL_DENIAL_LINK_HINT_BY_LOCALE[locale](remaining), denied.actionUrl);
    }
  }
  if (copy.resume) lines.push(copy.resume);
  return lines.join("\n");
}

/**
 * Card body for a successful `/apikey` issue. Shorter than the text form on purpose: the
 * "opens once / valid for N minutes" part becomes the card's footnote and the URL lives on the
 * button, so repeating either here is noise.
 *
 * `rotated` still MUST be stated — the requester's old key died instantly, and an unexplained
 * break gets reported as a bug by whoever had it configured in an MCP client.
 */
function formatApiKeyIssueCardBody(result: PersonalApiKeyIssueResult, locale: LarkLocale): string {
  // The `status` hint is kept: unlike the URL and the validity window (which become the button and
  // the footnote), it has nowhere else to live, and the card is now the primary delivery path — so
  // dropping it here would quietly remove the affordance for checking the key's own expiry.
  if (locale === "en-US") {
    return [
      result.rotated
        ? "✅ New API key generated — your PREVIOUS key is now invalid. Update anything configured with it."
        : "✅ Your API key is ready.",
      "Send /apikey status any time to check the key's own expiry.",
    ].join("\n");
  }
  return [
    result.rotated
      ? "✅ 已为你生成新的 API Key（旧 Key 已失效，如有配置请更新）"
      : "✅ 你的 API Key 已就绪",
    "随时发送 /apikey status 查看 Key 本身的失效时间",
  ].join("\n");
}

/** `/apikey status` reply — read-only, so it must never imply anything was rotated. */
function formatApiKeyStatusReply(result: PersonalApiKeyStatusResult, locale: LarkLocale): string {
  if (!result.success) {
    const reason = result.error ?? (locale === "en-US" ? "unknown error" : "未知错误");
    return locale === "en-US"
      ? `❌ Could not read your API key status: ${reason}`
      : `❌ 查询 API Key 状态失败: ${reason}`;
  }
  // Only claim "no key" when the frontend actually says so. `exists` is optional on the wire, and
  // the advice attached to this branch ("send /apikey") ROTATES — so inferring absence from a
  // merely-missing field would destroy the very key the user asked us to inspect. A present
  // prefix is sufficient evidence that a key exists.
  const hasKey = result.exists === true || Boolean(result.keyPrefix);
  if (!hasKey) {
    return locale === "en-US"
      ? "You don't have an API key for this agent yet — send /apikey to get one."
      : "你还没有这个 Agent 的 API Key，发送 /apikey 领取。";
  }
  const lastUsed = formatApiKeyTimestamp(result.lastUsedAt, locale, true);
  const expiry = formatApiKeyTimestamp(result.expiresAt, locale, false);
  const lines =
    locale === "en-US"
      ? [
          `Current key: ${result.keyPrefix ?? "(unknown prefix)"}…`,
          lastUsed ? `Last used: ${lastUsed}` : "Last used: never",
          expiry ? `Expires: ${expiry} (using the key pushes this out)` : "",
        ]
      : [
          `当前 Key：${result.keyPrefix ?? "(前缀未知)"}…`,
          lastUsed ? `最后使用：${lastUsed}` : "最后使用：从未使用",
          expiry ? `失效时间：${expiry}（继续使用会自动延后）` : "",
        ];
  return lines.filter(Boolean).join("\n");
}

/**
 * Reply for an unrecognised `/apikey` subcommand. Reached INSTEAD of issuing, because
 * `/apikey` rotates: letting a typo like `/apikey statu` fall through to issuing would
 * silently kill the very key the user was trying to inspect.
 */
function formatApiKeyUsageReply(locale: LarkLocale): string {
  return locale === "en-US"
    ? [
        "Unrecognised /apikey subcommand.",
        "/apikey — issue or rotate your key (invalidates the old one)",
        "/apikey status — show your current key (read-only)",
      ].join("\n")
    : [
        "无法识别的 /apikey 子命令。",
        "/apikey —— 领取或轮换 Key（会使旧 Key 失效）",
        "/apikey status —— 查看当前 Key（只读）",
      ].join("\n");
}

/**
 * Send a plain-text reply. Never throws — callers that only need best-effort delivery can keep
 * ignoring the result. It RETURNS whether the message actually landed, because a caller that has
 * already committed a side effect (see `/apikey`, which rotates before it can reply) must be able
 * to tell delivery failure from success instead of inferring it from a log line.
 */
async function replyToLark(
  larkClient: any,
  messageId: string,
  text: string,
  replyInThread: boolean = false,
): Promise<boolean> {
  try {
    // Feishu's SDK does NOT throw on a non-zero API code (e.g. missing
    // im:message send scope) — it returns {code,msg} in the body. Surface it,
    // otherwise a permission failure looks like a silent no-op.
    const resp = await larkClient.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text }),
        msg_type: "text",
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    if (resp && typeof resp.code === "number" && resp.code !== 0) {
      console.error(`[lark] reply API returned non-zero code for messageId=${messageId}: code=${resp.code} msg=${resp.msg}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[lark] Failed to reply to messageId=${messageId}:`, err);
    return false;
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

/**
 * Deliver an answer the live card could not carry.
 *
 * A NEW static card first, plain text only if even that fails. Text is the last
 * resort rather than the fallback because Feishu does not render markdown in a
 * text message: the answer arrives as literal `##` headings and `|---|` table
 * rows, which on a long structured report is barely readable. A fresh card also
 * still admits the 👍/👎 row.
 */
async function deliverAnswerOutsideCard(
  larkClient: any,
  messageId: string,
  body: string,
  replyInThread: boolean,
  feedback?: { ctx: FeedbackContext; locale: LarkLocale },
  ticketIntake?: { ctx: TicketIntakeCardContext; locale: LarkLocale },
): Promise<void> {
  if (await postFinalCard(larkClient, messageId, body, feedback, replyInThread, ticketIntake)) return;
  console.warn(`[lark] Replacement card failed for messageId=${messageId}; replying as plain text (markdown will not render)`);
  await replyToLark(larkClient, messageId, body, replyInThread);
}

async function deliverVisibleChannelText(
  larkClient: any,
  messageId: string,
  cardSession: Awaited<ReturnType<typeof openTypingCard>>,
  text: string,
  terminal: boolean,
  replyInThread: boolean = false,
): Promise<boolean> {
  if (cardSession) {
    // Terminal: judge by contentOk — a failed streaming-mode flip still leaves
    // the text on the card, so it must not trigger a duplicate reply.
    const delivered = terminal
      ? (await finalizeCard(larkClient, cardSession, text)).contentOk
      : await updateCardContent(larkClient, cardSession, text);
    if (delivered) return true;
    console.warn(`[lark] Channel-visible card update failed for messageId=${messageId}; posting a replacement card`);
  }
  await deliverAnswerOutsideCard(larkClient, messageId, text, replyInThread);
  return true;
}

async function replyVisualImages(
  larkClient: any,
  messageId: string,
  images: RenderedReplyImage[],
  replyInThread: boolean = false,
): Promise<void> {
  for (const { kind, image } of images) {
    const ok = await replyImageToLark(larkClient, messageId, image, replyInThread);
    if (!ok) {
      console.warn(`[lark] ${kind} image reply failed for messageId=${messageId}; markdown card remains primary`);
    }
  }
}

// ── SSE response collector ─────────────────────────────────────

export interface CollectedChannelResponse {
  text: string;
  images: RenderedReplyImage[];
  /** Persisted id of the final assistant turn, or null when audit persistence failed/was disabled. */
  assistantMessageId: string | null;
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
  let lastAssistantMessageId: string | null = null;

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
  const persistRow = async (msg: Parameters<typeof appendMessage>[0]): Promise<string | null> => {
    try { return await appendMessage({ ...msg, traceId: persist?.traceId ?? msg.traceId }); }
    catch (err) {
      console.warn(`[${logPrefix}] audit persist failed session=${sessionId}:`, err);
      return null;
    }
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
          // Non-group progress (single-agent step activity).
          const blocks = Array.isArray(ev.partialResult?.content) ? ev.partialResult.content : [];
          const activity = blocks
            .filter((b: any) => b?.type === "text")
            .map((b: any) => (b.text ?? "") as string)
            .join(" ")
            .trim();
          milestone = channelActivityMilestone(activity, options.locale);
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
          // Replace the id even when this write fails: retaining an earlier
          // narration id would link the final card to the wrong assistant turn.
          lastAssistantMessageId = persist
            ? await persistRow({ sessionId, role: "assistant", content: redact(turnText) })
            : null;
        }
      }
    }
  } catch (err) {
    console.error(`[${logPrefix}] SSE collect error for session=${sessionId}:`, err);
  }
  // Prefer the last full assistant turn; fall back to streamed deltas if the
  // brain only emits content_block_delta events.
  const text = lastAssistantText || parts.join("");
  // A delta-only stream has no assistant message_end, so persist the exact
  // synthesized reply once the stream finishes. This gives feedback cards the
  // same precise message linkage as the normal message_end path without
  // duplicating assistant rows when a full turn was already persisted.
  if (!lastAssistantText && text.trim() && persist) {
    lastAssistantMessageId = await persistRow({
      sessionId,
      role: "assistant",
      content: redact(text),
    });
  }
  return { text, images, assistantMessageId: lastAssistantMessageId };
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

/**
 * What a single-agent step activity should say ON A CHAT CARD — or nothing.
 *
 * The producer's activity text is developer-facing: `Ran <tool>` is exactly what
 * Portal's work card wants (a tool log is the point there). A group chat is not
 * that audience — a bare tool name tells the asker nothing, and because the card
 * shows only the CURRENT step it also pushes the agent's real narration off the
 * card. So keep the agent's own words, drop the machine echo. The card still
 * advances while a long tool runs: the sub-agent's own narration keeps arriving.
 *
 * Filtered here, at the channel boundary, rather than at the producer: the
 * gateway and agentbox ship as separate images, so a gateway-side filter holds
 * whatever agentbox version it is paired with (and Portal keeps its tool log).
 */
function channelActivityMilestone(activity: string, locale?: LarkLocale): string {
  const clean = activity.trim();
  if (!clean) return "";
  // `Ran <tool>` — a tool name, not a milestone.
  if (/^Ran\s+\S+$/.test(clean)) return "";
  // Sub-agent slot wait: real information, but hard-coded English at the source.
  if (/^Waiting for a free slot/i.test(clean)) {
    return locale === "en-US" ? "Waiting for a free sub-agent slot…" : "排队等待子任务空位…";
  }
  return condenseMilestone(clean) || clean;
}

function contentBlocksToMarkdown(blocks: unknown[]): string {
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return "";
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") return rec.text;
    return "";
  }).join("");
}
