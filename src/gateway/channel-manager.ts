/**
 * Channel Manager — boots and manages active channel connections.
 *
 * Loads channels from Portal via FrontendWsClient RPC and starts one handler
 * per channel. Messages are routed to agents dynamically via channel_bindings
 * lookup through RPC.
 *
 * Runtime no longer accesses the database directly.
 */

import type { AgentBoxManager } from "./agentbox/manager.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import { createLarkHandler } from "./channels/lark.js";
import { createDingTalkHandler } from "./channels/dingtalk.js";
import type { TicketIntakeDraft, TicketIntakeRecord, TicketIntakeSubmissionPayload } from "../shared/ticket-intake.js";

export interface ChannelHandler {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface RunningChannel {
  handler: ChannelHandler;
  fingerprint: string;
}

export interface ChannelReloadResult {
  started: number;
  restarted: number;
  stopped: number;
  unchanged: number;
}

export interface ResolvedChannelBinding {
  agentId: string;
  bindingId: string;
  sessionId: string;
  sessionKey?: string | null;
  createdBy: string | null;
  routeType: "group" | "user";
  /** Cached chat title from the platform; null/absent until backfilled. */
  displayName?: string | null;
  /**
   * Group context sharing mode, chosen server-side from the binding row.
   * `"shared"` → the whole group shares one session and non-@ chatter is
   * buffered into it. `"per_user"` → each sender gets an isolated session and
   * non-@ chatter is dropped. A NEW group defaults to `"shared"` (written at
   * pair/auto-bind time), but the server resolves NULL/legacy rows to
   * `"per_user"` (grandfathering — never merges an existing group's contexts),
   * so an ABSENT field here is treated as `"per_user"` by the runtime: never
   * buffer chatter for a group we can't confirm is shared. The runtime treats
   * `sessionKey` as opaque; this field is the explicit signal for the non-@
   * ingestion gate — never infer the mode from the key shape.
   */
  contextMode?: "shared" | "per_user";
}

/**
 * Non-binding result from `channel.resolveBinding`: the Portal recognised the
 * channel but turned the sender away (sicore_authorized group, sender unbound or
 * without read access to the agent). The Runtime should reply a short hint
 * rather than silently ignore. Distinct from `null` (ignore: no binding at all).
 */
export interface ChannelAccessDenied {
  walled: true;
  reason?: string;
  authorizeUrl?: string;
}

export function isChannelAccessDenied(
  value: ResolvedChannelBinding | ChannelAccessDenied | null,
): value is ChannelAccessDenied {
  return value !== null && (value as ChannelAccessDenied).walled === true;
}

/**
 * True for the admission tiers that admit anyone: `public`, and its legacy spelling `open`.
 *
 * Lives here because BOTH layers must agree on it — the gateway picks refusal copy from it and the
 * Portal adapter decides whether to auto-bind. Two copies drifting apart produces the exact failure
 * this contract exists to prevent: the runtime treats a tier as open while the Portal refuses to
 * bind, and the sender is answered with silence.
 *
 * Anything else — including a tier this build has never seen — is gated. The direction is
 * deliberate: a frontend can introduce a tier before the runtime learns about it, and the safe
 * failure is "you need authorization", never silence and never admission.
 */
export function isOpenAccessTier(accessMode: unknown): boolean {
  const mode = typeof accessMode === "string" ? accessMode.trim().toLowerCase() : "";
  return mode === "public" || mode === "open";
}

/**
 * Why a PERSONAL-chat sender was turned away, plus the self-service next step.
 *
 * Deliberately NOT merged with {@link ChannelAccessDenied}, despite the overlap: that type's
 * `authorizeUrl` is a shareable console address, while `actionUrl` here is a SINGLE-USE personal
 * credential. A one-time link must never reach a group — anyone in the room could open it and
 * bind the sender's chat identity to their own account, after which the victim's messages execute
 * as the attacker. Keeping the types apart encodes "group fields must not carry a one-time token"
 * in the signature instead of relying on everyone remembering it. Render both next to each other
 * (see the personal/group reply builders) so the copy cannot drift.
 */
export interface PersonalAccessDenied {
  /** Contract field — drives which localized template renders. */
  reason?: string;
  /** Single-use next step (link/apply). Absent when the tier accepts no self-service. */
  actionUrl?: string;
  /** Epoch ms the `actionUrl` dies. Render durations FROM this, never hard-code the TTL. */
  expiresAtMs?: number;
  /** Non-localized English fallback, used only when `reason` has no template. May embed the URL. */
  message?: string;
}

/** Resolved personal-chat access: a binding to proceed with, or the reason it was refused. */
export interface PersonalBindingResult {
  binding: ResolvedChannelBinding | null;
  denied?: PersonalAccessDenied;
}

/**
 * Resolve agent_id for a (channel_id, route_key) pair via RPC.
 *
 * `senderOpenId` is threaded so the Portal can resolve a per-sender identity
 * for authorized group bots and choose the effective session key server-side
 * (open groups → shared chat session; authorized → per-user). It is separate
 * from `sessionKey` because the server may override the session key it returns.
 * `conversationKey` is an optional provider conversation scope (for example a
 * Feishu topic root). The Portal combines it with the binding's context mode
 * and actor identity; the runtime must treat the returned `sessionKey` as
 * authoritative.
 */
export async function resolveBinding(
  channelId: string,
  routeKey: string,
  frontendClient: FrontendWsClient,
  sessionKey?: string,
  senderOpenId?: string,
  conversationKey?: string,
  conversationExistingOnly: boolean = false,
  senderType?: string,
): Promise<ResolvedChannelBinding | ChannelAccessDenied | null> {
  const data = await frontendClient.request("channel.resolveBinding", {
    channel_id: channelId,
    route_key: routeKey,
    ...(sessionKey ? { session_key: sessionKey } : {}),
    ...(senderOpenId ? { sender_open_id: senderOpenId } : {}),
    // The provider's own word ("user" / "app" / …), passed through verbatim.
    // Absent when the event did not carry one — the Portal must treat missing
    // and "user" as different things, so do not default it here.
    ...(senderType ? { sender_type: senderType } : {}),
    ...(conversationKey ? { conversation_key: conversationKey } : {}),
    ...(conversationExistingOnly ? { conversation_existing_only: true } : {}),
  });
  return data.binding ?? null;
}

/**
 * Set a group binding's context mode (shared|per_user) via the generic
 * `channel.setContextMode` RPC. Backs the in-group /mode switch card; the
 * console selector calls the same RPC. Best-effort — returns the portal's
 * `{success}` shape, or a failure object if there is no frontend client.
 */
export async function setChannelContextMode(
  channelId: string,
  routeKey: string,
  mode: "shared" | "per_user",
  frontendClient?: FrontendWsClient,
): Promise<{ success: boolean; mode?: string; error?: string }> {
  if (!frontendClient) return { success: false, error: "No frontend client for setContextMode" };
  return frontendClient.request("channel.setContextMode", {
    channel_id: channelId,
    route_key: routeKey,
    mode,
  });
}

export async function beginTicketIntake(
  input: { sessionId: string; channelId: string; requesterExternalId: string; sourceMessageId: string },
  frontendClient?: FrontendWsClient,
): Promise<{ success: boolean; intake?: TicketIntakeRecord; error?: string }> {
  if (!frontendClient) return { success: false, error: "Ticket intake storage is unavailable" };
  return frontendClient.request("channel.beginTicketIntake", {
    session_id: input.sessionId,
    channel_id: input.channelId,
    requester_external_id: input.requesterExternalId,
    source_message_id: input.sourceMessageId,
  });
}

export async function getActiveTicketIntake(
  sessionId: string,
  requesterExternalId: string,
  frontendClient?: FrontendWsClient,
): Promise<TicketIntakeRecord | null> {
  if (!frontendClient) return null;
  const result = await frontendClient.request("channel.getActiveTicketIntake", {
    session_id: sessionId,
    requester_external_id: requesterExternalId,
  });
  return result?.intake ?? null;
}

export async function transitionTicketIntake(
  input: { intakeId: string; requesterExternalId: string; revision: number; action: "confirm" | "continue" | "cancel" },
  frontendClient?: FrontendWsClient,
): Promise<{ success: boolean; intake?: TicketIntakeRecord; payload?: TicketIntakeSubmissionPayload; error?: string }> {
  if (!frontendClient) return { success: false, error: "Ticket intake storage is unavailable" };
  return frontendClient.request("channel.transitionTicketIntake", {
    intake_id: input.intakeId,
    requester_external_id: input.requesterExternalId,
    expected_revision: input.revision,
    action: input.action,
  });
}

/** Handle a PAIR code — validates and creates binding via RPC. */
export async function handlePairingCode(
  code: string,
  channelId: string,
  routeKey: string,
  routeType: "group" | "user",
  frontendClient: FrontendWsClient,
  routeDisplayName?: string,
): Promise<{ success: boolean; agentName?: string; error?: string }> {
  return frontendClient.request("channel.pair", {
    code,
    channel_id: channelId,
    route_key: routeKey,
    route_type: routeType,
    ...(routeDisplayName ? { route_display_name: routeDisplayName } : {}),
  });
}

/**
 * Push a freshly observed chat title onto the binding (display-only cache).
 * Best-effort: callers fire-and-forget; a failure just leaves the old name.
 */
export async function updateBindingMeta(
  channelId: string,
  routeKey: string,
  displayName: string,
  frontendClient: FrontendWsClient,
): Promise<{ success: boolean; error?: string }> {
  return frontendClient.request("channel.updateBindingMeta", {
    channel_id: channelId,
    route_key: routeKey,
    display_name: displayName,
  });
}

/**
 * Persist a channel's display name (used to store a Feishu bot's real
 * `app_name` so the Portal shows the actual bot name, not a placeholder).
 */
export async function updateChannelName(
  channelId: string,
  name: string,
  frontendClient: FrontendWsClient,
): Promise<{ success: boolean; error?: string }> {
  return frontendClient.request("channel.updateName", {
    channel_id: channelId,
    name,
  });
}

/** Reset the durable session attached to a channel binding. */
export async function resetBindingSession(
  channelId: string,
  routeKey: string,
  frontendClient: FrontendWsClient,
  sessionKey?: string,
): Promise<{ success: boolean; agentId?: string; oldSessionId?: string | null; sessionId?: string; error?: string }> {
  return frontendClient.request("channel.resetSession", {
    channel_id: channelId,
    route_key: routeKey,
    ...(sessionKey ? { session_key: sessionKey } : {}),
  });
}

/**
 * Resolve a personal-chat sender's binding, or why they were refused.
 *
 * Returns the refusal alongside the binding rather than just `binding ?? null`: without the
 * reason the runtime can only emit one generic "no access" line, which leaves a user on a
 * gated tier with no idea what to do next — the tier is then effectively unusable. A frontend
 * that does not populate `denied` simply yields `{ binding: null }` and the caller falls back
 * to its generic refusal, so this stays backward compatible.
 */
export async function resolvePersonalBinding(
  channelId: string,
  senderOpenId: string,
  frontendClient: FrontendWsClient,
  senderType?: string,
): Promise<PersonalBindingResult> {
  const data = await frontendClient.request("channel.resolvePersonalBinding", {
    channel_id: channelId,
    sender_open_id: senderOpenId,
    // Same contract as the group lookup: verbatim, and absent stays absent.
    ...(senderType ? { sender_type: senderType } : {}),
  });
  return {
    binding: data?.binding ?? null,
    ...(normalizeDenied(data?.denied) ?? {}),
  };
}

/**
 * Narrow `denied` at the RPC boundary so no downstream renderer has to defend itself.
 *
 * Every field is frontend-supplied, and "present" does not imply "the type we expect": a
 * `message` that arrives as an object made `message.trim()` throw, the event wrapper only logged
 * it, and the sender got NO reply — the exact silent failure this contract exists to remove.
 * Wrong-typed fields are dropped rather than coerced: a refusal with a missing field degrades to
 * a generic notice, whereas a stringified object would be shown to the user as copy.
 */
export function normalizeDenied(raw: unknown): { denied: PersonalAccessDenied } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  const denied: PersonalAccessDenied = {
    ...(str(src.reason) ? { reason: str(src.reason) } : {}),
    ...(str(src.actionUrl) ? { actionUrl: str(src.actionUrl) } : {}),
    ...(str(src.message) ? { message: str(src.message) } : {}),
    ...(typeof src.expiresAtMs === "number" && Number.isFinite(src.expiresAtMs)
      ? { expiresAtMs: src.expiresAtMs }
      : {}),
  };
  return { denied };
}

export async function handlePersonalPairingCode(
  code: string,
  channelId: string,
  senderOpenId: string,
  frontendClient: FrontendWsClient,
): Promise<{ success: boolean; agentName?: string; error?: string }> {
  return frontendClient.request("channel.pairPersonal", {
    code,
    channel_id: channelId,
    sender_open_id: senderOpenId,
  });
}

export async function resetPersonalSession(
  channelId: string,
  sessionKey: string,
  frontendClient: FrontendWsClient,
): Promise<{ success: boolean; agentId?: string; oldSessionId?: string | null; sessionId?: string; error?: string }> {
  return frontendClient.request("channel.resetPersonalSession", {
    channel_id: channelId,
    session_key: sessionKey,
  });
}

/**
 * Result of `/apikey` — self-service API key issuing from a personal-bot chat.
 * `pickupUrl` is a short-lived, single-use link; the plaintext key NEVER travels
 * over this RPC (see docs/design/2026-07-28-feishu-apikey-command.md).
 */
export interface PersonalApiKeyIssueResult {
  success: boolean;
  agentId?: string;
  pickupUrl?: string;
  /** Epoch ms after which the pickup link is dead. */
  expiresAt?: number;
  /** True ⇒ the requester's previous key was just invalidated. */
  rotated?: boolean;
  /** Non-localized English fallback. Surfaced verbatim only when `denied` yields no template. */
  error?: string;
  /**
   * Present only on the AUTHORIZATION refusal (the other failure exits carry `error` alone).
   * Preferred over `error` when this build has a template for the reason, so a gated user gets
   * localized copy plus a self-service link instead of an English sentence.
   */
  denied?: PersonalAccessDenied;
}

/** Result of `/apikey status` — read-only, never rotates. */
export interface PersonalApiKeyStatusResult {
  success: boolean;
  agentId?: string;
  exists?: boolean;
  keyPrefix?: string;
  lastUsedAt?: number;
  /** SLIDING deadline (last use + 30d), not a fixed issue term. */
  expiresAt?: number;
  error?: string;
}

/**
 * Issue (or rotate) the sender's API key for the personal bot's agent.
 *
 * Upstream-mode-only RPC: the Portal adapter answers with a `success:false` stub (see
 * `channel.issueApiKey` in src/portal/adapter.ts), so the runtime stays frontend-agnostic
 * instead of hard-depending on a control plane that may not be there. Admission is decided
 * entirely by the frontend — the runtime only forwards the sender's identity.
 */
export async function issuePersonalApiKey(
  channelId: string,
  senderOpenId: string,
  frontendClient: FrontendWsClient,
  requestId?: string,
): Promise<PersonalApiKeyIssueResult> {
  const result = await frontendClient.request("channel.issueApiKey", {
    channel_id: channelId,
    sender_open_id: senderOpenId,
    // Stable per-inbound-message id (the Feishu message_id). Issuing is destructive — it rotates
    // — so it needs idempotency, not just the runtime's in-process single-flight guard, which
    // cannot span a sequential redelivery or a second gateway replica. Forwarding the id is the
    // runtime half of that contract; DEDUPLICATION MUST BE DURABLE ON THE FRONTEND (replay the
    // same pending result rather than rotating again). A frontend that ignores this field simply
    // keeps today's behaviour.
    ...(requestId ? { request_id: requestId } : {}),
  });
  // Same untrusted shape as the binding path — narrow it here so the renderers cannot be handed
  // a non-string where they expect one.
  return { ...result, ...(normalizeDenied(result?.denied) ?? { denied: undefined }) };
}

/** Read-only key status for the sender. Same Upstream-mode contract as {@link issuePersonalApiKey}. */
export async function getPersonalApiKeyStatus(
  channelId: string,
  senderOpenId: string,
  frontendClient: FrontendWsClient,
): Promise<PersonalApiKeyStatusResult> {
  return frontendClient.request("channel.apiKeyStatus", {
    channel_id: channelId,
    sender_open_id: senderOpenId,
  });
}

export interface ChannelManagerOptions {
  /** Max retry attempts for bootFromDb when channel.list races with WS connect. */
  bootRetryAttempts?: number;
  /** Base backoff ms between bootFromDb retries (doubles each attempt up to 8s). */
  bootRetryBaseMs?: number;
}

export class ChannelManager {
  private handlers = new Map<string, RunningChannel>();
  private readonly bootRetryAttempts: number;
  private readonly bootRetryBaseMs: number;

  constructor(
    private agentBoxManager: AgentBoxManager,
    private agentBoxTlsOptions?: { cert: string; key: string; ca: string },
    private frontendClient?: FrontendWsClient,
    options: ChannelManagerOptions = {},
  ) {
    this.bootRetryAttempts = options.bootRetryAttempts ?? 5;
    this.bootRetryBaseMs = options.bootRetryBaseMs ?? 1000;
  }

  /**
   * Load active channels from Portal via RPC and start handlers.
   */
  /**
   * Fetch active channels via RPC and start a handler per channel.
   *
   * Retries with backoff if the RPC fails — this happens on startup when
   * the Runtime's `FrontendWsClient` races with the WS server (brief
   * reconnect during handshake leaves the initial `channel.list` stranded).
   * Without retry, that race is non-recoverable and the channel stays
   * silent until the pod is manually restarted.
   */
  async bootFromDb(): Promise<void> {
    const maxAttempts = this.bootRetryAttempts;
    const base = this.bootRetryBaseMs;
    // Backoff schedule caps at 8*base, which comfortably covers the
    // observed ~1-3s WS reconnect gap on pod start (default base=1000ms).
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!this.frontendClient?.connected) {
        if (attempt === maxAttempts) {
          console.warn("[channel-manager] FrontendWsClient never connected — giving up channel boot");
          return;
        }
        const wait = Math.min(base * 2 ** (attempt - 1), base * 8);
        console.log(`[channel-manager] FrontendWsClient not connected; retrying channel boot in ${wait}ms (attempt ${attempt}/${maxAttempts})`);
        await new Promise<void>((r) => setTimeout(r, wait));
        continue;
      }

      try {
        const channels = await this.fetchChannels();
        console.log(`[channel-manager] Found ${channels.length} active channel(s)`);
        await this.reconcileChannels(channels);
        return;
      } catch (err) {
        if (attempt === maxAttempts) {
          console.error(`[channel-manager] Failed to boot channels after ${maxAttempts} attempts:`, err);
          return;
        }
        const wait = Math.min(base * 2 ** (attempt - 1), base * 8);
        console.warn(`[channel-manager] channel.list failed (attempt ${attempt}/${maxAttempts}), retrying in ${wait}ms:`, err instanceof Error ? err.message : err);
        await new Promise<void>((r) => setTimeout(r, wait));
      }
    }
  }

  async reloadFromDb(): Promise<ChannelReloadResult> {
    if (!this.frontendClient?.connected) {
      throw new Error("FrontendWsClient is not connected");
    }
    const channels = await this.fetchChannels();
    const result = await this.reconcileChannels(channels);
    console.log(
      `[channel-manager] Reloaded channels started=${result.started} restarted=${result.restarted} stopped=${result.stopped} unchanged=${result.unchanged}`,
    );
    return result;
  }

  private async fetchChannels(): Promise<Record<string, any>[]> {
    const result = await this.frontendClient!.request("channel.list") as { data?: Record<string, any>[] };
    return Array.isArray(result.data) ? result.data : [];
  }

  private async reconcileChannels(channels: Record<string, any>[]): Promise<ChannelReloadResult> {
    const result: ChannelReloadResult = { started: 0, restarted: 0, stopped: 0, unchanged: 0 };
    const desired = new Map<string, { channel: Record<string, any>; fingerprint: string }>();
    for (const channel of channels) {
      if (typeof channel.id !== "string" || channel.id.length === 0) {
        console.warn("[channel-manager] Skipping channel without id");
        continue;
      }
      desired.set(channel.id, { channel, fingerprint: channelFingerprint(channel) });
    }

    for (const [id, running] of [...this.handlers.entries()]) {
      const next = desired.get(id);
      if (!next) {
        await this.stopChannel(id);
        result.stopped += 1;
        continue;
      }
      if (next.fingerprint === running.fingerprint) {
        result.unchanged += 1;
        desired.delete(id);
        continue;
      }
      await this.stopChannel(id);
      result.stopped += 1;
      try {
        await this.startChannel(next.channel, next.fingerprint);
        result.restarted += 1;
      } catch (err) {
        console.error(`[channel-manager] Failed to restart channel id=${next.channel.id} type=${next.channel.type}:`, err);
      }
      desired.delete(id);
    }

    for (const { channel, fingerprint } of desired.values()) {
      try {
        const started = await this.startChannel(channel, fingerprint);
        if (started) result.started += 1;
      } catch (err) {
        console.error(`[channel-manager] Failed to start channel id=${channel.id} type=${channel.type}:`, err);
      }
    }
    return result;
  }

  async startChannel(channel: Record<string, any>, fingerprint = channelFingerprint(channel)): Promise<boolean> {
    if (this.handlers.has(channel.id)) {
      console.warn(`[channel-manager] Channel id=${channel.id} already running — skipping`);
      return false;
    }

    let handler: ChannelHandler;

    switch (channel.type) {
      case "lark":
        handler = createLarkHandler(
          channel,
          this.agentBoxManager,
          this.agentBoxTlsOptions,
          this.frontendClient,
        );
        break;
      case "dingtalk":
        handler = createDingTalkHandler(
          channel,
          this.agentBoxManager,
          this.agentBoxTlsOptions,
          this.frontendClient,
        );
        break;
      default:
        console.warn(`[channel-manager] Unsupported channel type="${channel.type}" — skipping id=${channel.id}`);
        return false;
    }

    await handler.start();
    this.handlers.set(channel.id, { handler, fingerprint });
    return true;
  }

  async stopChannel(channelId: string): Promise<void> {
    const running = this.handlers.get(channelId);
    if (!running) return;
    try { await running.handler.stop(); } catch (err) {
      console.error(`[channel-manager] Error stopping channel id=${channelId}:`, err);
    }
    this.handlers.delete(channelId);
  }

  async stopAll(): Promise<void> {
    const ids = [...this.handlers.keys()];
    for (const id of ids) { await this.stopChannel(id); }
    console.log(`[channel-manager] All channels stopped (${ids.length})`);
  }

  get size(): number { return this.handlers.size; }
}

function channelFingerprint(channel: Record<string, any>): string {
  return stableStringify({
    id: channel.id,
    type: channel.type,
    config: typeof channel.config === "string" ? safeParseJson(channel.config) ?? channel.config : channel.config,
  });
}

function safeParseJson(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
