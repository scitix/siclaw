/**
 * Internal API handlers for AgentBox consumption (Port 3002 mTLS).
 *
 * Runtime no longer accesses the database directly. All data queries
 * are proxied through Portal via FrontendWsClient RPC.
 *
 * Endpoints:
 *   GET    /api/internal/settings          — model providers + entries
 *   GET    /api/internal/mcp-servers       — MCP config for the agent
 *   GET    /api/internal/skills/bundle     — skill bundle for the agent
 *   GET    /api/internal/agent-tasks       — scheduled tasks for the agent
 *   POST   /api/internal/agent-tasks       — create a task
 *   PUT    /api/internal/agent-tasks/:id   — update a task
 *   DELETE /api/internal/agent-tasks/:id   — delete a task
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { CertificateIdentity } from "./security/cert-manager.js";
import type { ChatMessageMetadata } from "../shared/message-kinds.js";
import { sessionRegistry, type SessionRecord } from "./session-registry.js";
import {
  deliverBackgroundChannelMessage,
  deliverChannelVisibleMessage,
  hasBackgroundChannelDelivery,
} from "./channels/background-delivery.js";
import { validateSchedule } from "../cron/cron-limits.js";
import { parseToolCapabilitiesAtBoundary, resolveCapabilities } from "../core/tool-capabilities.js";
import {
  projectTierMenuFromConfig,
  sanitizeWireItemStatuses,
  sanitizeWireTierOutcome,
} from "../core/subagent-models.js";
import { sha256Hex } from "../portal/model-routing-config.js";
import { requireAgentType, effectiveCapabilityKeys } from "../core/agent-types.js";
import type {
  DelegationAppendMessagePayload,
  DelegationEventPayload,
  DelegationPersistenceEvent,
  DelegationPersistenceResponse,
  DelegationToolUpdatePayload,
  DelegationUpdateMessagePayload,
} from "../shared/delegation-persistence.js";
import type { MetricsFlushPayload, PromSampleGroup } from "../shared/metrics-types.js";

/** Read + JSON-parse an HTTP request body. */
async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/** Send JSON response helper */
function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Does `sessionId` belong to the calling certificate's agent? Unknown sessions
 * degrade to `true` (the caller cannot be shown to be lying); a known session
 * passes when the caller either OWNS it or is the peer it was DELEGATED TO.
 *
 * The delegation arm exists because a delegated leg is the one session whose
 * owner is deliberately not its executor: the coordinator that created the leg
 * stays the owner (so it keeps the conversation), while the turn runs in the
 * delegated peer's AgentBox, whose certificate names the peer. Everything that
 * box persists FOR that leg — a spawned sub-agent's session and transcript,
 * task-ledger events — therefore arrived with an identity that could not match
 * the row's owner and was refused, while the pointers to those rows, written by
 * the coordinator-side stream, went through. The result was a leg advertising
 * sub-agent sessions that had never been created.
 *
 * Accepting the target does not widen attribution: `target_agent_id` is the box
 * the leg was handed to, so a box still cannot claim a session delegated to
 * anyone else, and a top-level session has no target to fall back on.
 */
async function sessionBelongsToIdentity(sessionId: string | null | undefined, identity: CertificateIdentity): Promise<boolean> {
  if (!sessionId) return true;
  const owner = await sessionRegistry.get(sessionId);
  if (!owner) return true;
  if (owner.agentId === identity.agentId) return true;
  if (owner.targetAgentId) return owner.targetAgentId === identity.agentId;
  // No target on the record — authoritative only if the record came from the row
  // itself. The 3-arg `rememberSession` callers know nothing about delegation
  // fields, so whichever of them runs first after a restart or an eviction caches
  // the leg owner-only, and a cache hit never re-reads: refusing on the strength
  // of such an entry would silently reinstate the data loss this arm exists to
  // fix, for as long as the entry survived. Production runs more than one
  // Runtime, so the first caller is not reliably the one that knows the target.
  //
  // Re-read once, on the about-to-refuse path only. The refreshed record is
  // marked as row-sourced, so a repeat attempt costs nothing.
  if (owner.authoritative) return false;
  // The re-read must not be able to make things worse than the refusal it is
  // trying to avoid. This is the only I/O on the about-to-refuse path, and an
  // exception here would reach the handler's outer catch as a 500 — telling a box
  // that swallows persistence failures nothing it can act on, and hiding "not
  // your session" behind "the platform is broken". Nothing is written either way,
  // so a failed re-read simply leaves the refusal standing.
  let refreshed: SessionRecord | undefined;
  try {
    refreshed = await sessionRegistry.refresh(sessionId);
  } catch (err) {
    console.warn(`[internal-api] could not re-read session ${sessionId} before refusing: ${String(err)}`);
    return false;
  }
  return Boolean(refreshed?.targetAgentId) && refreshed?.targetAgentId === identity.agentId;
}

/**
 * Strict owner-only variant, for a session a request claims to CREATE, REWRITE
 * or SPEAK AS rather than merely write into. Unlike the arm above, the delegation
 * target buys nothing here: appending is additive, whereas these three verbs act
 * on rows and channels the coordinator owns.
 *
 * The owner is taken from the ROW, never from a cached record of unknown
 * provenance. A leg relayed to another Runtime is dispatched there by
 * `chat.send`, which caches it under the PEER's agent — so a cache-only owner
 * check would hand the peer exactly the rewrite access this gate withholds, and
 * would do so only in the multi-Runtime deployment where it matters least to
 * notice. One extra read per session per cache lifetime; nothing once the record
 * is authoritative.
 *
 * Note the re-read is NOT confined to the about-to-refuse path, unlike
 * `sessionBelongsToIdentity`. There, a stale record can only wrongly refuse; here
 * it can wrongly ACCEPT, so provenance has to be settled before the comparison
 * rather than after it fails.
 *
 * An UNREACHABLE row is a REFUSAL, not a fallback to the cached owner. Falling
 * back reads like the available-first choice, and it is wrong here for a specific
 * reason: on a leg relayed to this Runtime, `chat.send` wrote the PEER into that
 * cache entry, so the fallback would trust the one value this gate exists to
 * distrust — and would do it precisely while the source of truth is unavailable to
 * contradict it. The asymmetry settles it: a refused `channel.deliver_message`
 * drops a progress card during an outage in which nothing else is persisting
 * either, while a wrongly-admitted `update_message` forges conversation content
 * and cannot be undone.
 *
 * Every `true` this returns is therefore either "no such session" or a comparison
 * against a row-sourced record. There is no third source.
 */
async function sessionOwnedByIdentity(sessionId: string | null | undefined, identity: CertificateIdentity): Promise<boolean> {
  if (!sessionId) return true;
  const cached = await sessionRegistry.get(sessionId);
  if (!cached) return true;
  if (cached.authoritative) return cached.agentId === identity.agentId;

  let fromRow: SessionRecord | undefined;
  try {
    fromRow = await sessionRegistry.refresh(sessionId);
  } catch (err) {
    // Nothing is written either way, so this must not reach the handler's outer
    // catch as a 500: that would tell a box reading its own logs that the platform
    // is broken when the answer is simply unavailable.
    console.warn(`[internal-api] could not re-read session ${sessionId} for an owner-only check: ${String(err)}`);
  }
  if (fromRow?.authoritative) return fromRow.agentId === identity.agentId;
  // Distinct from "not your session": an operator reading these needs to tell a
  // real attribution mismatch from a window where the row simply could not be
  // reached, because the second one clears up on its own and the first does not.
  console.warn(`[internal-api] refusing an owner-only write on session ${sessionId}: ownership could not be established from the row`);
  return false;
}

/**
 * Resolve sessionId → userId, **enforcing that the session belongs to the
 * calling cert's agent**. Cross-agent attribution is rejected (`ok: false`)
 * — without this check, AgentBox A could pass a session_id owned by
 * AgentBox B and have its task / credential request audited under B's user.
 *
 * Unknown sessions degrade gracefully (`ok: true`, `userId: ""`); only an
 * explicit ownership mismatch trips the gate.
 *
 * Deliberately NARROWER than `sessionBelongsToIdentity`: it does not accept a
 * session's delegation target. These routes mutate cron schedules, so allowing
 * them from inside a delegated leg would let a peer bind a long-lived schedule
 * to itself off the back of one delegated turn — a product question about who
 * may own a schedule, not the attribution gap the other helper closes.
 *
 * That narrowness is NOT a routing-independent guarantee: a leg relayed to
 * another Runtime is dispatched there by `chat.send`, which caches the leg under
 * the PEER's agent, so the owner check already passes for it. Only a leg run by
 * the Runtime that created it is refused here.
 */
async function resolveUserForIdentity(
  sessionId: string | null | undefined,
  identity: CertificateIdentity,
): Promise<{ userId: string; ok: boolean }> {
  if (!sessionId) return { userId: "", ok: true };
  const owner = await sessionRegistry.get(sessionId);
  if (!owner) return { userId: "", ok: true };
  if (owner.agentId !== identity.agentId) return { userId: "", ok: false };
  return { userId: owner.userId, ok: true };
}

function agentMatchesIdentity(agentId: string | null | undefined, identity: CertificateIdentity): boolean {
  return !agentId || agentId === identity.agentId;
}

/**
 * The sessions a refusal was about, for the log line. Which field carries them
 * differs per event type, and a refusal can be about the PARENT rather than the
 * subject — the error string says which check failed, this says on what.
 */
function delegationEventSessions(event: DelegationPersistenceEvent): string {
  const parts: string[] = [];
  const push = (label: string, id?: string | null): void => {
    if (id) parts.push(`${label}=${id}`);
  };
  switch (event.type) {
    case "delegation.ensure_session":
      push("session", event.sessionId);
      push("parent", event.lineage?.parentSessionId);
      break;
    case "delegation.append_message":
      push("session", event.message.sessionId);
      push("parent", event.message.parentSessionId);
      break;
    case "delegation.update_message":
    case "delegation.update_tool_message":
    case "channel.deliver_message":
      push("session", event.message.sessionId);
      break;
    case "delegation.append_event":
      push("parent", event.event.parentSessionId);
      break;
    case "delegation.emit_chat_event":
      push("session", event.sessionId);
      break;
  }
  return parts.join(" ");
}

async function validateDelegationEventActor(
  event: DelegationPersistenceEvent,
  identity: CertificateIdentity,
): Promise<{ status: number; error: string } | null> {
  switch (event.type) {
    case "delegation.ensure_session": {
      if (!event.userId) return { status: 400, error: "delegation.ensure_session requires userId" };
      if (!agentMatchesIdentity(event.agentId, identity)) return { status: 403, error: "delegation agent mismatch" };
      if (!agentMatchesIdentity(event.lineage?.parentAgentId, identity)) return { status: 403, error: "delegation parent agent mismatch" };
      if (!agentMatchesIdentity(event.lineage?.targetAgentId, identity)) return { status: 403, error: "delegation target agent mismatch" };
      // Two ownership checks; each can be a Portal RPC on cache miss. Run
      // them in parallel — the unhappy path wastes one extra RPC but the
      // happy path's latency is halved.
      const [own, parentOwn] = await Promise.all([
        // Subject: owner-only (this call upserts the row) — see sessionOwnedByIdentity.
        sessionOwnedByIdentity(event.sessionId, identity),
        // Parent: a delegated leg's peer legitimately writes beneath it.
        sessionBelongsToIdentity(event.lineage?.parentSessionId, identity),
      ]);
      if (!own) return { status: 403, error: "delegation session mismatch" };
      if (!parentOwn) return { status: 403, error: "delegation parent session mismatch" };
      return null;
    }
    case "delegation.append_message": {
      if (!agentMatchesIdentity(event.message.fromAgentId, identity)) return { status: 403, error: "delegation source agent mismatch" };
      if (!agentMatchesIdentity(event.message.targetAgentId, identity)) return { status: 403, error: "delegation target agent mismatch" };
      const [own, parentOwn] = await Promise.all([
        sessionBelongsToIdentity(event.message.sessionId, identity),
        sessionBelongsToIdentity(event.message.parentSessionId, identity),
      ]);
      if (!own) return { status: 403, error: "delegation session mismatch" };
      if (!parentOwn) return { status: 403, error: "delegation parent session mismatch" };
      return null;
    }
    case "delegation.update_message":
    case "delegation.update_tool_message": {
      // Owner-only, NOT the delegation arm. These take a message id and rewrite
      // that row, and nothing in the payload scopes the rewrite to rows the
      // caller wrote — so the arm that lets a peer's box APPEND its sub-agent
      // transcript would also let it rewrite what the coordinator said. Appending
      // at worst adds rows attributed to the peer; rewriting forges the
      // conversation. No caller reaches this today (row updates run on the
      // coordinator side), which is exactly why it costs nothing to hold shut.
      if (!(await sessionOwnedByIdentity(event.message.sessionId, identity))) return { status: 403, error: "delegation session mismatch" };
      return null;
    }
    case "delegation.append_event": {
      if (!event.event.userId) return { status: 400, error: "delegation.append_event requires userId" };
      if (!(await sessionBelongsToIdentity(event.event.parentSessionId, identity))) return { status: 403, error: "delegation parent session mismatch" };
      if (!agentMatchesIdentity(event.event.parentAgentId, identity)) return { status: 403, error: "delegation parent agent mismatch" };
      if (!agentMatchesIdentity(event.event.targetAgentId, identity)) return { status: 403, error: "delegation target agent mismatch" };
      return null;
    }
    case "delegation.emit_chat_event": {
      if (!(await sessionBelongsToIdentity(event.sessionId, identity))) return { status: 403, error: "delegation session mismatch" };
      return null;
    }
    case "channel.deliver_message": {
      if (!agentMatchesIdentity(event.message.fromAgentId, identity)) return { status: 403, error: "channel source agent mismatch" };
      // Owner-only, unlike the delegation persistence events above. This carries
      // no delegated state: the `channel_update` tool behind it is suppressed on a
      // delegated turn by design (a delegated worker's output flows back through
      // the coordinator, which owns the single visible identity), so a leg has no
      // legitimate route here. The arm that lets a peer's box persist a sub-agent
      // transcript should not double as a key to the conversation's channel.
      if (!(await sessionOwnedByIdentity(event.message.sessionId, identity))) return { status: 403, error: "channel session mismatch" };
      return null;
    }
    default:
      return null;
  }
}

/**
 * Fetch agent resource bindings from Portal via RPC.
 * Returns skill_ids and mcp_server_ids bound to the agent.
 */
/**
 * Fetch the agent's bound skill/mcp ids from Upstream.
 *
 * Errors are propagated intentionally. An earlier version swallowed every
 * error and returned `{ skillIds: [] }`, which was ambiguous with "agent
 * truly has no skills bound" — any transient RPC failure (WSClient
 * mid-reconnect, Upstream restart, etc.) then caused `handleSkillsBundle` to
 * return an empty bundle, AgentBox wiped `resolved/`, and the pod lost its
 * entire skill set until a manual restart.
 *
 * With the current behaviour, upstream handlers return HTTP 500; AgentBox's
 * reload handler treats that as "leave current state, retry next time" and
 * the materialized `resolved/` is preserved.
 */
async function fetchAgentResources(
  frontendClient: FrontendWsClient,
  orgId: string,
  agentId: string,
): Promise<{ skillIds: string[]; mcpServerIds: string[]; isProduction: boolean }> {
  const data = await frontendClient.request("config.getResources", {
    agentId,
    orgId,
  });
  return {
    skillIds: data.skill_ids ?? [],
    mcpServerIds: data.mcp_server_ids ?? [],
    isProduction: data.is_production ?? true,
  };
}

/**
 * GET /api/internal/settings
 *
 * Proxies to Portal via RPC to get the agent's bound provider + models.
 */
export async function handleSettings(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const data = await frontendClient.request("config.getSettings", {
      agentId: identity.agentId,
      orgId: identity.orgId,
    });
    sendJson(res, 200, data);
  } catch (err) {
    console.error("[internal-api] settings error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/tracing-config
 *
 * Proxies to Portal's config.getTracingConfig RPC — the GLOBAL tracing config
 * (TracingConfig). No agentId is passed: tracing is a single fan-out set shared
 * by every agent, so it must not be resolved through the agent-scoped
 * config.getSettings (which drops tracing for agents without a bound provider).
 * Used by the AgentBox hot-reload path (POST /api/reload-tracing).
 *
 * TRUST-DOMAIN ASSUMPTION (deliberate, not a leak): the payload carries the
 * fully-assembled exporter auth in PLAINTEXT (unlike the admin REST list/get
 * routes, which maskExporterAuth for the browser). This is required — the box
 * exports spans DIRECTLY to the OTLP endpoint, so it must hold the real headers,
 * exactly like it already holds providers.apiKey. Tracing is global (no
 * per-tenant exporter concept), so every AgentBox that phones home gets the same
 * set. The security boundary is the caller cert (Gateway/Runtime-OU + mTLS), not
 * per-box scoping: any box inside the trust domain can read the exporter creds.
 * If exporters ever become tenant-scoped, scope this fetch to the caller's tenant.
 */
export async function handleTracingConfig(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  _identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const data = await frontendClient.request("config.getTracingConfig", {});
    sendJson(res, 200, data);
  } catch (err) {
    console.error("[internal-api] tracing-config error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/mcp-servers
 *
 * Returns MCP server configs bound to the agent.
 * Fetches binding via RPC, then queries MCP details via RPC.
 */
export async function handleMcpServers(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const { mcpServerIds } = await fetchAgentResources(frontendClient, identity.orgId, identity.agentId);

    if (mcpServerIds.length === 0) {
      sendJson(res, 200, { mcpServers: {} });
      return;
    }

    const data = await frontendClient.request("config.getMcpServers", {
      // Upstream uses agentId to resolve the caller's org and reject
      // cross-org id requests. Without it, the management server falls back to the WS
      // runtime_id and the org lookup fails ("agent <runtime_id> not found").
      agentId: identity.agentId,
      ids: mcpServerIds,
    });
    sendJson(res, 200, { mcpServers: data.mcpServers });
  } catch (err) {
    console.error("[internal-api] mcp-servers error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/tool-capabilities
 *
 * Returns the agent's resolved tool whitelist (the concrete allowedTools list).
 * The Gateway resolves capability group keys → tool names at this boundary so
 * the AgentBox stays oblivious to capability groups (mirrors ssh jump_host_id→
 * name and MCP boundary resolution).
 *
 * `{ allowedTools: null }` means explicit legacy unrestricted Custom. Built-in
 * types are expanded to their locked concrete tool lists. The agentId
 * comes from the mTLS cert identity (never the request body) so a box cannot
 * read another agent's whitelist.
 */
export async function handleToolCapabilities(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const agent = await frontendClient.request("config.getAgent", {
      agentId: identity.agentId,
    });
    // Built-in types LOCK the capability set; custom uses the
    // agent's own tool_capabilities. resolveCapabilities(null/[]) === null keeps
    // the backward-compatible "unrestricted" default for custom with no selection.
    const agentType = requireAgentType(agent?.agent_type);
    const capsKeys = effectiveCapabilityKeys(
      agentType,
      parseToolCapabilitiesAtBoundary(agent?.tool_capabilities),
    );
    const allowedTools = resolveCapabilities(capsKeys);
    // The sub-agent tier MENU rides this channel rather than the prompt binding,
    // because a session's tool description is built at creation and a per-prompt
    // field would arrive too late to appear in it. Credential-free by contract:
    // only {tier, whenToUse}. `null` clears whatever the box held.
    const subagentTierMenu = projectTierMenuFromConfig(agent?.subagent_model_tiers, sha256Hex);
    // agentType rides along for capabilities and legacy-row prompt fallback.
    sendJson(res, 200, { allowedTools, agentType, subagentTierMenu });
  } catch (err) {
    console.error("[internal-api] tool-capabilities error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/skills/bundle
 *
 * Returns a skill bundle for the agent via RPC.
 */
export async function handleSkillsBundle(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const { skillIds, isProduction } = await fetchAgentResources(frontendClient, identity.orgId, identity.agentId);

    const data = await frontendClient.request("config.getSkillBundle", {
      // Upstream uses agentId to resolve the caller's org and reject
      // cross-org skill_id requests. Without it, the management server falls back to the
      // WS runtime_id and the org lookup fails ("agent <runtime_id> not
      // found"), which manifests as repeated `skills/bundle error` in
      // Runtime logs and a fresh AgentBox with no skills materialised.
      agentId: identity.agentId,
      skill_ids: skillIds,
      is_production: isProduction,
    });
    sendJson(res, 200, data);
  } catch (err) {
    console.error("[internal-api] skills/bundle error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/knowledge/bundle
 *
 * Returns the active LLM wiki packages bound to this agent via RPC.
 */
export async function handleKnowledgeBundle(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const data = await frontendClient.request("config.getKnowledgeBundle", {
      agentId: identity.agentId,
    });
    sendJson(res, 200, data);
  } catch (err) {
    console.error("[internal-api] knowledge/bundle error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * GET /api/internal/agent-tasks
 *
 * Returns the scheduled tasks for the agent identified by the mTLS certificate.
 */
export async function handleAgentTasksList(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    // Session may be threaded via query param for GET; resolve → userId for audit.
    const sessionId = new URL(req.url || "/", "http://_").searchParams.get("session_id") ?? "";
    const { userId, ok } = await resolveUserForIdentity(sessionId, identity);
    if (!ok) { sendJson(res, 403, { error: "session ownership mismatch" }); return; }
    const data = await frontendClient.request("task.list", {
      agent_id: identity.agentId,
      user_id: userId,
    });

    const tasks = (data.tasks as any[]).map((row: any) => ({
      id: row.id,
      name: row.name,
      schedule: row.schedule,
      status: row.status,
      description: row.description,
      prompt: row.prompt,
      lastRunAt: row.last_run_at,
      lastResult: row.last_result,
      agentId: identity.agentId,
    }));

    sendJson(res, 200, { tasks });
  } catch (err) {
    console.error("[internal-api] agent-tasks list error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * POST /api/internal/agent-tasks
 *
 * Body: { name, description?, schedule, prompt, status? }
 * Creates a task bound to the agent identified by the mTLS certificate.
 */
export async function handleAgentTasksCreate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const body = await readJsonBody(req) as {
      name?: string;
      description?: string;
      schedule?: string;
      prompt?: string;
      status?: "active" | "paused";
      session_id?: string;
    };
    if (!body.name || !body.schedule || !body.prompt) {
      sendJson(res, 400, { error: "name, schedule, prompt are required" });
      return;
    }
    const invalid = validateSchedule(body.schedule);
    if (invalid) { sendJson(res, 400, { error: invalid }); return; }

    const { userId, ok } = await resolveUserForIdentity(body.session_id, identity);
    if (!ok) { sendJson(res, 403, { error: "session ownership mismatch" }); return; }
    const data = await frontendClient.request("task.create", {
      id: randomUUID(),
      agent_id: identity.agentId,
      user_id: userId,
      name: body.name,
      description: body.description ?? null,
      schedule: body.schedule,
      prompt: body.prompt,
      status: body.status ?? "active",
    });
    sendJson(res, 201, data);
  } catch (err) {
    console.error("[internal-api] agent-tasks create error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * PUT /api/internal/agent-tasks/:id
 *
 * Body: any of { name, description, schedule, prompt, status }
 * Only tasks owned by the agent (mTLS identity) can be updated.
 */
export async function handleAgentTasksUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  taskId: string,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const body = await readJsonBody(req) as Record<string, unknown>;
    if (typeof body.schedule === "string" && body.schedule.length > 0) {
      const invalid = validateSchedule(body.schedule);
      if (invalid) { sendJson(res, 400, { error: invalid }); return; }
    }

    const sessionId = typeof body.session_id === "string" ? body.session_id : undefined;
    const { userId, ok } = await resolveUserForIdentity(sessionId, identity);
    if (!ok) { sendJson(res, 403, { error: "session ownership mismatch" }); return; }
    const data = await frontendClient.request("task.update", {
      task_id: taskId,
      agent_id: identity.agentId,
      user_id: userId,
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
      schedule: typeof body.schedule === "string" ? body.schedule : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      status: typeof body.status === "string" ? body.status : undefined,
    });
    sendJson(res, data.error ? 404 : 200, data);
  } catch (err) {
    console.error("[internal-api] agent-tasks update error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/**
 * DELETE /api/internal/agent-tasks/:id
 */
export async function handleAgentTasksDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  taskId: string,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const sessionId = new URL(req.url || "/", "http://_").searchParams.get("session_id") ?? "";
    const { userId, ok } = await resolveUserForIdentity(sessionId, identity);
    if (!ok) { sendJson(res, 403, { error: "session ownership mismatch" }); return; }
    const data = await frontendClient.request("task.delete", {
      task_id: taskId,
      agent_id: identity.agentId,
      user_id: userId,
    });
    sendJson(res, data.error ? 404 : 200, data);
  } catch (err) {
    console.error("[internal-api] agent-tasks delete error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

function maybeJson(metadata: Record<string, unknown> | null | undefined): string | null {
  return metadata != null ? JSON.stringify(metadata) : null;
}

async function appendDelegationMessage(
  frontendClient: FrontendWsClient,
  msg: DelegationAppendMessagePayload,
): Promise<string> {
  const result = await frontendClient.request("chat.appendMessage", {
    session_id: msg.sessionId,
    role: msg.role,
    content: msg.content,
    tool_name: msg.toolName ?? null,
    toolset: msg.toolset ?? null,
    tool_input: msg.toolInput ?? null,
    metadata: maybeJson(msg.metadata),
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
    from_agent_id: msg.fromAgentId ?? null,
    parent_session_id: msg.parentSessionId ?? null,
    delegation_id: msg.delegationId ?? null,
    target_agent_id: msg.targetAgentId ?? null,
    trace_id: msg.traceId ?? null,
  });
  return result.id as string;
}

async function updateDelegationMessage(
  frontendClient: FrontendWsClient,
  msg: DelegationUpdateMessagePayload,
): Promise<void> {
  await frontendClient.request("chat.updateMessage", {
    id: msg.messageId,
    session_id: msg.sessionId,
    content: msg.content,
    tool_name: msg.toolName ?? null,
    toolset: msg.toolset ?? null,
    tool_input: msg.toolInput ?? null,
    metadata: maybeJson(msg.metadata),
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
    delegation_id: msg.delegationId ?? null,
  });
}

async function updateDelegationToolMessage(
  frontendClient: FrontendWsClient,
  msg: DelegationToolUpdatePayload,
): Promise<void> {
  await frontendClient.request("chat.updateDelegationToolMessage", {
    session_id: msg.sessionId,
    tool_name: msg.toolName,
    delegation_id: msg.delegationId,
    content: msg.content,
    metadata: maybeJson(msg.metadata),
    outcome: msg.outcome ?? null,
    duration_ms: msg.durationMs ?? null,
  });
}

async function appendDelegationEvent(
  frontendClient: FrontendWsClient,
  evt: DelegationEventPayload,
): Promise<string> {
  const metadata: ChatMessageMetadata = {
    kind: "delegation_event",
    source: "system_notification",
    event_type: `delegation.${evt.status}`,
    delegation_id: evt.delegationId,
    child_session_id: evt.childSessionId,
    target_agent_id: evt.targetAgentId,
    parent_agent_id: evt.parentAgentId,
    status: evt.status,
    capsule: evt.capsule,
    ...(evt.fullSummary ? { full_summary: evt.fullSummary } : {}),
    ...(evt.summaryTruncated != null ? { summary_truncated: evt.summaryTruncated } : {}),
    ...(evt.scope ? { scope: evt.scope } : {}),
    ...(evt.taskIndex != null ? { task_index: evt.taskIndex } : {}),
    ...(evt.totalTasks != null ? { total_tasks: evt.totalTasks } : {}),
    ...(evt.toolCalls != null ? { tool_calls: evt.toolCalls } : {}),
    ...(evt.durationMs != null ? { duration_ms: evt.durationMs } : {}),
    ...(evt.partialSource ? { partial_source: evt.partialSource } : {}),
    ...(evt.interruptedTool ? { interrupted_tool: evt.interruptedTool } : {}),
    // ⚠️ Both of these are SANITIZED, not copied. This runs on an HTTP boundary
    // whose body is typed by assertion, which strips nothing — a payload carrying
    // `modelConfig`, `apiKey` or an internal `detail` would otherwise be written
    // to a durable record verbatim. The allow-list lives in one place so this path
    // and the direct-DB one cannot diverge.
    //
    // A group's tier outcome rides inside `item_statuses`; a single child's is its
    // own field, and for a DETACHED spawn that event is the only surviving record.
    ...(() => {
      const items = sanitizeWireItemStatuses(evt.itemStatuses);
      return items ? { item_statuses: items } : {};
    })(),
    ...(() => {
      const tier = sanitizeWireTierOutcome(evt.tier);
      return tier ? { tier } : {};
    })(),
  };

  return appendDelegationMessage(frontendClient, {
    sessionId: evt.parentSessionId,
    role: "user",
    content: evt.capsule,
    metadata,
    fromAgentId: evt.targetAgentId,
    delegationId: evt.delegationId,
    targetAgentId: evt.targetAgentId,
    traceId: evt.traceId,
  });
}

/**
 * POST /api/internal/delegation-events
 *
 * AgentBox-side background delegation runs persist through this Runtime-owned
 * callback. AgentBox must not import Gateway chat repositories directly: in
 * K8s it is a separate pod/process and Runtime owns the Portal RPC connection.
 */
export async function handleDelegationEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  frontendClient: FrontendWsClient,
): Promise<void> {
  try {
    const event = await readJsonBody(req) as DelegationPersistenceEvent;
    const actorError = await validateDelegationEventActor(event, identity);
    if (actorError) {
      const where = delegationEventSessions(event);
      const suffix = where ? ` (${where})` : "";
      if (actorError.status === 403) {
        // Log it: an AgentBox treats persistence as best-effort and swallows the
        // failure, so a refusal here is otherwise invisible — and the rows it drops
        // are the ones a delegated leg's sub-agent transcript is made of. A Portal
        // that does not report a session's delegation target shows up as a steady
        // stream of these rather than as silently missing history. The session ids
        // are what tie such a stream to the conversations that lost content.
        console.warn(
          `[internal-api] refused ${event.type} for agent ${identity.agentId}: ${actorError.error}${suffix}`,
        );
      } else {
        // A malformed payload is the caller's own bug, not a missing delegation
        // target. Kept off the wording above so a stream of real refusals stays
        // legible.
        console.warn(
          `[internal-api] rejected malformed ${event.type} from agent ${identity.agentId}: ${actorError.error}${suffix}`,
        );
      }
      sendJson(res, actorError.status, { error: actorError.error });
      return;
    }
    let response: DelegationPersistenceResponse = { ok: true };

    switch (event.type) {
      case "delegation.ensure_session": {
        await frontendClient.request("chat.ensureSession", {
          session_id: event.sessionId,
          agent_id: event.agentId,
          user_id: event.userId,
          title: event.title,
          preview: event.preview,
          origin: event.origin,
          parent_session_id: event.lineage?.parentSessionId ?? null,
          parent_agent_id: event.lineage?.parentAgentId ?? identity.agentId,
          delegation_id: event.lineage?.delegationId ?? null,
          target_agent_id: event.lineage?.targetAgentId ?? null,
        });
        break;
      }
      case "delegation.append_message": {
        const deliveredToChannel = await deliverBackgroundChannelMessage(event.message);
        const channelRegistered = hasBackgroundChannelDelivery(event.message.sessionId);
        try {
          response = { ok: true, id: await appendDelegationMessage(frontendClient, event.message) };
        } catch (err) {
          if (!deliveredToChannel && !channelRegistered) throw err;
          console.warn(
            `[internal-api] Portal append failed for channel background session=${event.message.sessionId} delivered=${deliveredToChannel}:`,
            err,
          );
          response = { ok: true };
        }
        break;
      }
      case "delegation.update_message": {
        await updateDelegationMessage(frontendClient, event.message);
        break;
      }
      case "delegation.update_tool_message": {
        await updateDelegationToolMessage(frontendClient, event.message);
        break;
      }
      case "delegation.append_event": {
        response = { ok: true, id: await appendDelegationEvent(frontendClient, event.event) };
        break;
      }
      case "delegation.emit_chat_event": {
        frontendClient.emitEvent("chat.event", { sessionId: event.sessionId, event: event.event });
        break;
      }
      case "channel.deliver_message": {
        response = { ok: await deliverChannelVisibleMessage(event.message) };
        break;
      }
      default: {
        sendJson(res, 400, { error: "Unknown delegation event type" });
        return;
      }
    }

    sendJson(res, 200, response);
  } catch (err) {
    console.error("[internal-api] delegation-events error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

/** What the flush handler needs from the federation aggregator (decouples internal-api). */
export interface MetricsFlushSink {
  ingest(boxId: string, incarnation: string, groups: PromSampleGroup[]): void;
}

/** Flush self-monitoring counters (module 4); optional so callers can omit in tests. */
export interface MetricsFlushCounters {
  flushReceivedTotal: { inc(): void };
  flushErrorsTotal: { inc(): void };
}

/**
 * Resolve which box a flush should be attributed to.
 *
 * 🔴 The body's `boxId` is a CLAIM. Agent A must never be able to poison agent B's
 * federated series, so a claim is accepted only when it is the certificate's own boxId
 * (the agent's base pod name) or one of that base's instance suffixes — the only two
 * shapes `K8sSpawner.podName` can produce for the authenticated agent.
 *
 * Anything else falls back to the certificate value rather than rejecting the flush:
 * metrics must never become an availability risk, and the fallback is exactly what
 * every box reported before replicas existed.
 *
 * ⚠️ RESIDUAL, stated plainly rather than papered over. Pod names are not a collision-free
 * encoding of (agent, instance): agent `foo` instance 1 and agent `foo-1` instance 0 both
 * name `agentbox-foo-1`, so a COMPROMISED box for `foo` can claim — and corrupt — the
 * federated series of `foo-1`. Two things bound it. The spawner refuses to reuse or replace
 * a pod whose `agent` label disagrees, so only one of the two agents can really own that
 * name in a healthy cluster; and a box that is compromised enough to lie about its identity
 * can already lie about the metric VALUES it reports, which is the larger problem and not
 * one this check can solve. Closing it properly needs the claim verified against the pod
 * list, which lives in the metrics aggregator, not here.
 */
export function resolveFlushBoxId(certBoxId: string, claimed: unknown): string {
  if (typeof claimed !== "string" || claimed === "" || claimed === certBoxId) return certBoxId;
  const suffix = claimed.startsWith(`${certBoxId}-`) ? claimed.slice(certBoxId.length + 1) : null;
  // Every instance carries its index, `-0` included, and the certificate names the AGENT
  // rather than any one pod — so a claim is exactly the cert's subject plus this box's
  // index. Anything else is a box claiming to be another agent's.
  if (suffix !== null && /^(0|[1-9]\d*)$/.test(suffix)) return claimed;
  console.warn(
    `[internal-api] metrics-flush claimed boxId="${claimed}" outside cert identity "${certBoxId}"; attributing to the cert`,
  );
  return certBoxId;
}

/**
 * POST /api/internal/metrics-flush — SIGTERM final-flush from an AgentBox (module 5).
 *
 * The body carries the per-process incarnation, the cumulative prom snapshot, and the
 * box's claim about which pod it is; the claim is authorized against the mTLS identity
 * by {@link resolveFlushBoxId}. Everything is fed through the SAME idempotent `ingest()`
 * entry point as the pull loop.
 */
export async function handleMetricsFlush(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  identity: CertificateIdentity,
  sink: MetricsFlushSink,
  counters?: MetricsFlushCounters,
): Promise<void> {
  try {
    counters?.flushReceivedTotal.inc();
    const body = (await readJsonBody(req)) as MetricsFlushPayload;
    if (!body || typeof body.incarnation !== "string" || !Array.isArray(body.prom)) {
      counters?.flushErrorsTotal.inc();
      sendJson(res, 400, { error: "metrics-flush requires { incarnation, prom }" });
      return;
    }
    sink.ingest(resolveFlushBoxId(identity.boxId, body.boxId), body.incarnation, body.prom);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    counters?.flushErrorsTotal.inc();
    console.error("[internal-api] metrics-flush error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
}
