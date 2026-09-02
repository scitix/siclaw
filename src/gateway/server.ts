/**
 * Siclaw Agent Runtime — stateless execution engine (DB-free).
 *
 * All data access goes through Portal/Upstream adapter API.
 *
 * Port 3001 (HTTP):
 *   GET  /api/health              — K8s liveness/readiness
 *   GET  /metrics                 — Prometheus
 *   /api/v1/siclaw/metrics/*      — Metrics (proxied to adapter for summary/audit)
 *   /api/v1/siclaw/system/*       — System config (proxied to adapter)
 *
 * Port 3002 (HTTPS mTLS):
 *   POST /api/internal/credential-request  — proxy to adapter
 *   GET  /api/internal/settings            — proxy to adapter
 *   GET  /api/internal/mcp-servers         — proxy to adapter
 *   GET  /api/internal/skills/bundle       — proxy to adapter
 *   *    /api/internal/agent-tasks[/:id]   — proxy to adapter
 *   POST /api/internal/feedback            — AgentBox feedback
 */

import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type tls from "node:tls";
import type { RuntimeConfig } from "./config.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type PromptOptions } from "./agentbox/client.js";
import { getBoxProfile } from "./agentbox/box-profile.js";
import { buildSpawnEnv } from "./agentbox/spawn-env.js";
import { CapabilityRunManager } from "./capability/run-manager.js";
import { driveCapabilitySession } from "./capability/session-driver.js";
import { asFailureToken } from "./capability/failure.js";
import { driveTestSession, shouldRelayTestSession } from "./capability/test-relay.js";
import { CAPABILITY_GET_RUN, isTerminalCapabilityStatus } from "./capability/contract.js";
import type {
  CapabilityCancelRequest,
  CapabilityCancelResponse,
  CapabilityCommandRequest,
  CapabilityMessageRequest,
  CapabilityStartRequest,
  CapabilityStartResponse,
  CapabilityTestCloseRequest,
  CapabilityTestCloseResponse,
  CapabilityTestRecommendRequest,
  CapabilityTestRecommendResponse,
  CapabilityTestReferenceAssistRequest,
  CapabilityTestReferenceAssistResponse,
  CapabilityTestMessageRequest,
  CapabilityTestSessionsRequest,
  CapabilityTestSessionsResponse,
  CapabilityTestSessionSummary,
  CapabilityTestStartRequest,
  CapabilityTestStartResponse,
} from "./capability/contract.js";
import { CapabilityMaterializationError, materializeCapabilityInputs } from "./capability/materialize.js";
import { resolveCapabilitySessionLlm } from "./capability/session-config.js";
import {
  capabilityActiveRuns,
  capabilityMaterializationFailuresTotal,
  capabilityRelayFailuresTotal,
  capabilityStartDurationMs,
  capabilityStartsTotal,
} from "./capability/capability-metrics.js";
import {
  type RpcHandler,
  type RpcContext,
} from "./ws-protocol.js";
import { ErrorCodes, RpcResponseError, wrapError } from "../lib/error-envelope.js";
import { handleCredentialRequest, handleCredentialList } from "./credential-proxy.js";
import { type CredentialService } from "./credential-service.js";
import { CertificateManager, type CertificateIdentity } from "./security/cert-manager.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import { createMtlsMiddleware } from "./security/mtls-middleware.js";
import type { BoxSpawner } from "./agentbox/spawner.js";
import { checkMetricsAuth } from "../shared/metrics.js";
import {
  AGENT_SYNC_STATUS_SCHEMA_VERSION,
  normalizeBoxSyncStatus,
  type BoxSyncObservation,
  type BoxSyncStatus,
} from "../shared/agentbox-sync-status.js";
import { clearAgentMemory } from "./memory-cleanup.js";
import {
  handleSettings,
  handleTracingConfig,
  handleMcpServers,
  handleToolCapabilities,
  handleSkillsBundle,
  handleKnowledgeBundle,
  handleAgentTasksList,
  handleAgentTasksCreate,
  handleAgentTasksUpdate,
  handleAgentTasksDelete,
  handleDelegationEvents,
  handleMetricsFlush,
} from "./internal-api.js";
import { handleDelegate, handleDelegates, isDelegationSettled, salvageDelegationTraceBind } from "./delegate-api.js";
// siclaw-api.ts routes moved to Portal — Runtime no longer registers CRUD routes.
import { appendMessage, bindMessageTraceId, incrementMessageCount, ensureChatSession, updateMessage, sequenceMessage, warnTraceBindFailure, validTraceId } from "./chat-repo.js";
import { consumeAgentSse } from "./sse-consumer.js";
import { buildRedactionConfigForModelConfig } from "./output-redactor.js";
import { MetricsAggregator } from "./metrics-aggregator.js";
import { PromFederationAggregator } from "./prom-federation-aggregator.js";
import { LocalSpawner } from "./agentbox/local-spawner.js";
import { sessionRegistry } from "./session-registry.js";
import { sessionTurnLocks } from "./session-turn-lock.js";
import { pendingUserRows } from "./pending-user-rows.js";
import { resolveAgentModelBinding, resolveAgentSystemPrompt } from "./agent-model-binding.js";
import { summarizeDispatchError } from "./dispatch-observability.js";

function stablePayloadDigest(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, canonicalize(child)]),
      );
    }
    return input;
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

/** Why a turn was cut short by the Runtime rather than by the model or the user. */
export type InterruptionReason = "runtime_restart" | "box_rolled";

export interface RuntimeServer {
  httpServer: http.Server;
  httpsServer: https.Server | null;
  certManager: CertificateManager;
  rpcMethods: Map<string, RpcHandler>;
  agentBoxTlsOptions?: { cert: string; key: string; ca: string };
  credentialService: CredentialService;
  close(): Promise<void>;
}

export interface StartRuntimeOptions {
  config: RuntimeConfig;
  agentBoxManager: AgentBoxManager;
  spawner?: BoxSpawner;
  /** FrontendWsClient for Portal RPC communication. */
  frontendClient: FrontendWsClient;
  /** Optional pre-constructed credential service. When omitted, builds from config. */
  credentialService?: CredentialService;
  /** Optional pre-constructed CertificateManager. When omitted, creates a new one. */
  certManager?: CertificateManager;
}

/**
 * How long a steer waits for its target box to finish creating the session.
 *
 * /api/prompt returns when the turn STARTS, so there is a short window in which the box
 * has accepted the prompt but not yet registered the session — a cold spawn widens it to
 * seconds. Long enough to cover that; short enough that a genuinely missing session fails
 * while the user is still looking at the screen.
 */
// warnTraceBindFailure moved to chat-repo.ts, next to bindMessageTraceId: the
// delegation transport (delegate-api.ts) now binds opening rows too, and the
// once-per-process dedup only works if every bind caller shares one reporter.

const STEER_SESSION_WAIT_MS = 3_000;

/**
 * How long a steer waits for the box to accept the prompt it is steering into.
 *
 * This is a handoff, not a poll: the wait ends the moment /api/prompt returns. The bound
 * only matters when that never happens (a box that died between placement and dispatch),
 * and there the caller is better off trying and being told than waiting out the turn.
 */
const STEER_PROMPT_WAIT_MS = 10_000;

export async function startRuntime(opts: StartRuntimeOptions): Promise<RuntimeServer> {
  const { config, agentBoxManager, spawner, frontendClient } = opts;

  // ── Credential Service ───────────────────────────────────
  if (!opts.credentialService) throw new Error("credentialService is required in StartRuntimeOptions");
  const credentialService = opts.credentialService;

  // ── Session Registry resolver ────────────────────────────
  // Cache misses (e.g. async AgentBox callbacks arriving after a Runtime
  // restart, before the next chat.send refills the LRU) fall back to Portal,
  // where chat_sessions.user_id is the source of truth.
  //
  // Wrapped in a 5s timeout so a slow / unresponsive Portal can't stall every
  // internal-api callback for the full FrontendWsClient default (30s). On
  // timeout we degrade to "" userId, which matches the pre-fallback behaviour.
  const RESOLVE_SESSION_TIMEOUT_MS = 5000;
  sessionRegistry.setResolver(async (sessionId) => {
    // Hold the timer handle outside Promise.race so we can cancel it once
    // the rpc wins — otherwise every successful resolve leaks a pending 5s
    // timer, and the post-restart callback burst this PR targets is exactly
    // the case that piles up the most.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const rpc = frontendClient.request("chat.resolveSession", { session_id: sessionId });
      const data = await Promise.race([
        rpc,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`chat.resolveSession timed out after ${RESOLVE_SESSION_TIMEOUT_MS}ms`)),
            RESOLVE_SESSION_TIMEOUT_MS,
          );
        }),
      ]) as
        | { found: false }
        | { found: true; user_id: string; agent_id: string };
      if (!data.found) return null;
      return { userId: data.user_id, agentId: data.agent_id };
    } catch (err) {
      console.error("[session-registry] resolveSession RPC failed:", err);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  // ── Certificate Manager ──────────────────────────────────
  const certManager = opts.certManager ?? await CertificateManager.create();
  agentBoxManager.setCertManager(certManager);
  const gatewayHostname = process.env.SICLAW_GATEWAY_HOSTNAME || "siclaw-runtime.siclaw.svc.cluster.local";
  const serverCert = certManager.issueServerCertificate(gatewayHostname);

  const agentBoxTlsOptions = {
    cert: serverCert.cert,
    key: serverCert.key,
    ca: certManager.getCACertificate(),
  };

  // ── RPC Methods (chat only) ──────────────────────────────
  const rpcMethods = new Map<string, RpcHandler>();

  // Resolve the per-agent spawn env. Two sources fold together in buildSpawnEnv:
  // the idle self-destruct window (agents.idle_timeout_sec →
  // SICLAW_AGENTBOX_IDLE_TIMEOUT, read at AgentBox startup), and a generic,
  // Portal-owned `spawn_env` map of extra per-agent env vars forwarded verbatim.
  // The Runtime is DB-free, so both come from Portal via the `config.getAgent`
  // RPC (the same channel other agent config flows through) — NOT a direct DB
  // read. Best-effort: any RPC failure falls back to the AgentBox's own defaults
  // rather than failing the spawn. The env only takes effect on a cold spawn —
  // K8sSpawner ignores it when a pod is already running, so changes apply on the
  // agent's next restart.
  //
  // Registered on the AgentBoxManager (not wired per-call) so EVERY cold-spawn
  // entry point — chat RPCs here, plus channel webhooks and cron tasks that
  // share this manager — honours the per-agent env. The manager invokes it
  // lazily, only on an actual spawn, so warm-pod reuse pays no RPC.
  const resolveAgentSpawnEnv = async (agentId: string): Promise<Record<string, string> | undefined> => {
    try {
      const agent = await frontendClient.request("config.getAgent", { agentId }) as
        | { idle_timeout_sec?: number | null; spawn_env?: Record<string, unknown> | null }
        | null;
      const env = buildSpawnEnv(agent);
      return Object.keys(env).length > 0 ? env : undefined;
    } catch (err) {
      console.warn(`[gateway] Failed to resolve spawn env for agent ${agentId}:`, err);
    }
    return undefined;
  };
  agentBoxManager.setSpawnEnvResolver(resolveAgentSpawnEnv);

  // Per-agent PVC persistence is an AGENT property, not a per-request flag:
  // resolve it server-side by agentId so every cold-spawn entry point (chat,
  // channel webhooks, cron, abort/steer) lands the same mode for the same agent
  // — not whichever caller happens to spawn the pod first. Registered on the
  // shared manager and consulted only on a cold spawn. siclaw core leaves
  // binding.persistence undefined → global fallback (behaviour identical to
  // upstream); a product portal fills it in its config.getModelBinding handler.
  agentBoxManager.setPersistenceResolver(async (agentId) => {
    const binding = await resolveAgentModelBinding(agentId, frontendClient);
    return binding?.persistence;
  });

  // How many boxes an agent runs. Unlike persistence (fixed at pod creation by the volume
  // mount), the pool size is something a running agent can change, so this is consulted on
  // every acquisition. Absent ⇒ 1 ⇒ the original single-box path, unchanged.
  //
  // Optional-call for the same reason as startOrphanSweep: startRuntime tests inject minimal
  // manager fakes, and pooling is an ops capability, never a boot requirement.
  agentBoxManager.setReplicasResolver?.(async (agentId) => {
    const agent = await frontendClient.request("config.getAgent", { agentId }) as
      | { replicas?: number | null }
      | null;
    return agent?.replicas ?? undefined;
  });

  // How to ask a box what it holds — placement scores on it, and the drain reaper needs the
  // box's own `drained` answer because a background sub-agent under an idle session is
  // invisible from out here.
  // The box's internal port is mTLS: without the client cert every probe fails the
  // handshake, placement scores every box as unreachable, and the drain reaper can never
  // observe `drained` — so a drain would only ever end at its force-kill deadline.
  agentBoxManager.setBoxStatusProbe?.(async (endpoint) =>
    new AgentBoxClient(endpoint, 10000, agentBoxTlsOptions).getJson("/api/internal/box-status"));

  // Boxes from before box-status existed still answer the older session list. During the
  // rollout that introduces this, EVERY running box is one of those — and knowing which
  // sessions they hold is what stops one being handed to a second box mid-conversation.
  agentBoxManager.setLegacySessionLister?.(async (endpoint) => {
    const { sessions } = await new AgentBoxClient(endpoint, 10000, agentBoxTlsOptions).listSessions();
    return sessions.map((s) => s.id);
  });

  // Per-session AbortController for the in-flight chat.send SSE consumer, keyed
  // by sessionId. chat.abort looks this up to break the gateway's consumeAgentSse
  // loop so its abort-finalization runs (in-flight tool rows → "stopped", partial
  // text persisted). Without this the consumer ends only when the agentbox closes
  // the stream NATURALLY (signal never aborted), the finalization is skipped, and
  // the tool row stays persisted as "running" — so a page refresh re-paints the
  // turn as still reasoning. Registered in chat.send, cleared on its settle.
  const activeStreamAborts = new Map<string, AbortController>();

  // A chat.send RPC acknowledges before its background task finishes cold-starting
  // an AgentBox. Keep those not-yet-dispatched turns abortable too: otherwise Stop
  // can observe "session not found", return success, and the background task can
  // still call prompt() afterwards. A set is required because a second send may be
  // waiting on the same session lock while the current turn is active.
  const pendingStartAborts = new Map<string, Set<AbortController>>();
  /**
   * Every turn this Runtime currently has in flight for a session, so an abort can
   * name the one it means.
   *
   * A session id names a CONVERSATION, and a delegated peer session is reused across
   * turns, so "abort session S" turns ambiguous the moment a turn ends: an abort
   * delayed past that point would land on its successor. Every abort this Runtime
   * sends therefore carries a turn, and the box answers a mismatch as already
   * stopped.
   *
   * A SET, not one id: a second send arrives while the first still holds the session
   * lock, so at that moment two turns are live — one running on the box, one queued
   * behind it. Remembering only the newest would make a Stop name the queued turn,
   * the box would reject the mismatch, and the running turn would continue headless.
   */
  const liveTurnIds = new Map<string, Set<string>>();
  /**
   * Which live turns are delegated, so a terminal produced by the SUPERVISOR — a
   * shutdown, or a box removed under a turn — can be reported with the same
   * acknowledgement as one produced by the turn itself. Those paths bypass the
   * turn's own reporting (see supervisorEndedTurns), which is exactly why they
   * needed their own route to it.
   */
  // traceId is the delegated turn's own root trace id, recorded the moment the box's
  // prompt ack names it. It lives HERE — on the turn's ledger entry — rather than in
  // the chat.send closure, so both terminal producers (the consumer paths in the
  // handler and the shutdown/box-roll supervisor above) report the same trace and an
  // interrupted leg keeps its cross-trace link. (A delegated send that degrades into
  // a steer of an already-running turn produces no terminal at all — a pre-existing
  // gap that ends in the source's relay idle-timeout, not a divergent trace.)
  const delegatedTurns = new Map<string, { delegationId: string; sessionId: string; traceId?: string }>();
  /**
   * Work that outlives the turn it belongs to and that shutdown must still flush.
   *
   * Two kinds end up here. An acknowledged terminal delivery may retry for as long as
   * a reconnect takes, which is far too long to hold a turn open for: the session
   * lock, the streaming registration and the supervisor's view of the turn would all
   * stay occupied, blocking the next turn on that session and letting a SIGTERM
   * re-report an already-finished turn as interrupted. And the box abort a supervisor
   * issues must land even though the turn it names may leave `liveTurnIds` the moment
   * its consumer settles — the box outlives a Runtime roll, and the process exits as
   * soon as close() returns.
   *
   * The turn settles at once either way; what it started continues here, centrally,
   * because the box-removal caller discards whatever endTurns() returns.
   */
  /**
   * Set before shutdown takes stock, and never cleared.
   *
   * Producers outlive the drain: the reverse command lane stays open so terminals can
   * still be delivered, the HTTP servers are still listening, and the manager's loops
   * run until later. Without a fence, a turn admitted during the wait registers after
   * the drain has looked, and the process exits with it running on a box that K8s
   * deliberately keeps.
   */
  let shuttingDown = false;

  /**
   * Turns whose box is being, or has been, successfully asked to stop them — so a box
   * roll followed by a shutdown does not ask twice.
   *
   * Each attempt RETRIES itself rather than relying on someone asking again. A later
   * caller cannot be that someone: it finds this mark set while the first attempt is
   * still outstanding, and by the time that attempt fails the turn may have left the
   * bookkeeping entirely. So the retry lives with the attempt, inside the promise
   * shutdown is already waiting on, and the mark is cleared only when every attempt has
   * been refused.
   */
  const boxAbortAsked = new Set<string>();
  const BOX_ABORT_ATTEMPTS = 3;

  /**
   * Ask a box to stop one turn, retrying a refusal. `isSessionNotFound` is success: the
   * box does not have the turn, which is the outcome that was wanted.
   */
  async function stopTurnOnBox(
    client: AgentBoxClient,
    sessionId: string,
    turnId: string,
    boxId: string,
    reason: InterruptionReason,
  ): Promise<void> {
    for (let attempt = 1; attempt <= BOX_ABORT_ATTEMPTS; attempt += 1) {
      try {
        await client.abortSession(sessionId, turnId);
        return;
      } catch (err) {
        if (isSessionNotFound(err)) return;
        const detail = err instanceof Error ? err.message : String(err);
        if (attempt === BOX_ABORT_ATTEMPTS) {
          // Out of attempts: let anything that looks again see it as unasked.
          boxAbortAsked.delete(turnId);
          const message = `[runtime] could not stop turn=${turnId} session=${sessionId} on ${boxId} after ${attempt} attempt(s): ${detail}`;
          if (reason === "box_rolled") console.log(`${message} (box may already be gone)`);
          else console.warn(message);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
  }

  /**
   * Wind-down hooks for work that starts turns outside chat.send — today the delegation
   * endpoint. Registered while that work is under way, so shutdown reaches a delegation
   * it can no longer refuse, and unregistered when it settles.
   */
  const shutdownCancels = new Set<() => Promise<void> | void>();
  const shutdownGate = {
    isShuttingDown: () => shuttingDown,
    register(cancel: () => Promise<void> | void): () => void {
      shutdownCancels.add(cancel);
      return () => shutdownCancels.delete(cancel);
    },
  };

  const pendingShutdownWork = new Set<Promise<void>>();
  const trackForShutdown = (work: Promise<void>): Promise<void> => {
    pendingShutdownWork.add(work);
    void work.finally(() => pendingShutdownWork.delete(work));
    return work;
  };

  /**
   * Hand a delegated turn's terminal to the control plane with an acknowledgement.
   *
   * The chat.event lane is fire-and-forget, which a human-facing turn survives: the
   * frontend refetches. A delegated turn has a machine waiting on it and nobody to
   * retry, so a terminal lost here strands the caller until its idle window elapses
   * and it then reports a failure for a turn that in fact finished.
   *
   * The budget has to outlast a WS reconnect, which cannot complete faster than its
   * own backoff. A control plane that does not implement the method (standalone, or
   * older) is not retried at all.
   */
  const deliverDelegationTerminal = async (
    delegationId: string,
    sessionId: string,
    turnId: string,
    event: Record<string, unknown>,
  ): Promise<void> => {
    // A single reconnect can take the client's whole backoff cap plus jitter (30s +
    // 2s), so a shorter budget gives up while the only route back is still being
    // re-established.
    const backoffMs = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000];
    for (let attempt = 0; attempt <= backoffMs.length; attempt += 1) {
      try {
        await frontendClient.request("delegation.terminal", { delegationId, sessionId, turnId, event }, 10_000);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/unknown method/i.test(message)) return;
        if (attempt === backoffMs.length) {
          console.error(`[runtime] could not confirm delivery of the terminal for delegation=${delegationId} session=${sessionId}:`, message);
          return;
        }
        await new Promise((r) => setTimeout(r, backoffMs[attempt]));
      }
    }
  };
  /**
   * Each live turn's cancellation, addressable on its own.
   *
   * Session-keyed controllers cannot express "cancel B": aborting the session's
   * controllers would break the consumer of the turn that is actually RUNNING while
   * the box is only told about B, leaving A running with nobody reading it.
   */
  const turnAborts = new Map<string, AbortController>();
  const addLiveTurn = (sessionId: string, id: string, ctrl: AbortController) => {
    const ids = liveTurnIds.get(sessionId) ?? new Set<string>();
    ids.add(id);
    liveTurnIds.set(sessionId, ids);
    turnAborts.set(id, ctrl);
  };
  const dropLiveTurn = (sessionId: string, id: string) => {
    turnAborts.delete(id);
    const ids = liveTurnIds.get(sessionId);
    if (!ids) return;
    ids.delete(id);
    if (ids.size === 0) liveTurnIds.delete(sessionId);
  };
  const registerPendingStart = (sessionId: string, ctrl: AbortController) => {
    const controllers = pendingStartAborts.get(sessionId) ?? new Set<AbortController>();
    controllers.add(ctrl);
    pendingStartAborts.set(sessionId, controllers);
  };
  const unregisterPendingStart = (sessionId: string, ctrl: AbortController) => {
    const controllers = pendingStartAborts.get(sessionId);
    if (!controllers) return;
    controllers.delete(ctrl);
    if (controllers.size === 0) pendingStartAborts.delete(sessionId);
  };

  /**
   * Sessions whose terminal this Runtime already sent — on shutdown, or because the box
   * running them was removed under them.
   *
   * Ending a turn also aborts its consumer, which makes that consumer take its own
   * terminal path, so each id is consumed exactly once to drop the duplicate. Per-turn on
   * purpose: a "we are shutting down" flag would also swallow the terminal of a turn that
   * started too late to be reported here, which is the hang this whole path exists to fix.
   */
  const supervisorEndedTurns = new Set<string>();


  const INTERRUPTION_MESSAGE: Record<InterruptionReason, string> = {
    runtime_restart: "Runtime restarted; this turn was interrupted",
    box_rolled: "The agentbox running this turn was replaced; the turn was interrupted",
  };

  /**
   * End the named turns, while the WS to the consumer is still up.
   *
   * Termination is `prompt_done` (docs/design/2026-08-02-error-surfacing-contract.md):
   * a consumer renders an error but keeps the turn open until that arrives. A turn whose
   * stream simply stops therefore hangs forever — the process that owned it is gone and
   * its replacement does not adopt turns it did not start, so no later event can come.
   */
  /**
   * Returns the work it started, so a caller about to take the transport down can
   * wait for it. Everything returned is ALSO tracked centrally: a box removal
   * ignores the return value, and its terminal would otherwise be invisible to a
   * shutdown that follows while it is still retrying.
   */
  function endTurns(sessionIds: Iterable<string>, reason: InterruptionReason): Array<Promise<void>> {
    const started: Array<Promise<void>> = [];
    const detail = wrapError(new Error(INTERRUPTION_MESSAGE[reason]), {
      code: ErrorCodes.STREAM_INTERRUPTED,
      retriable: true,
    });
    for (const sessionId of sessionIds) {
      const ctrl = activeStreamAborts.get(sessionId);
      const sessionTurnsForCheck = liveTurnIds.get(sessionId);
      // A turn still cold-starting has no consumer yet, but it is ours and it is
      // about to be abandoned: skipping it would leave its caller waiting out an idle
      // window while the box may still start the turn.
      if (!ctrl && !sessionTurnsForCheck?.size) continue;
      // Per TURN, not per session: with two turns live, one session-wide flag would
      // let the other still emit its own terminal — and a plain prompt_done arriving
      // after this interruption would read as a turn that succeeded.
      const sessionTurns = [...(liveTurnIds.get(sessionId) ?? [])];
      // CLAIM before reporting. A turn stays live until its consumer settles, and a
      // real consumer settles only when its next event arrives — so a box removal
      // followed by a shutdown can reach the same turn twice. Reporting twice would
      // put two authoritative terminals with DIFFERENT reasons in flight, and
      // whichever won the retry race would name the cause. The first pass owns the
      // report; a later one still cancels, and the delivery it needs is already
      // tracked.
      const unreported = sessionTurns.filter((id) => !supervisorEndedTurns.has(id));
      for (const id of sessionTurns) supervisorEndedTurns.add(id);
      // A known turn gets its own terminal envelope so strict consumers can
      // correlate the interruption. Keep the session-only fallback for the
      // cold-start window where no turn id has been allocated yet.
      const turnsToReport: Array<string | undefined> = sessionTurns.length === 0
        ? [undefined]
        : unreported;
      for (const turnId of turnsToReport) {
        const envelope = (event: Record<string, unknown>) => ({
          sessionId,
          ...(turnId ? { turnId } : {}),
          event,
        });
        try {
          frontendClient.emitEvent("chat.event", envelope({ type: "stream_error", error: detail }));
          // `aborted`/`reason` are additive: a consumer that does not read them sees the
          // plain terminal it already handles, one that does can name the cause instead of
          // rendering a generic connection failure.
          frontendClient.emitEvent("chat.event", envelope({ type: "prompt_done", aborted: true, reason }));
        } catch (err) {
          // Best effort: a consumer that already went away must not stop what caused this.
          console.warn(`[runtime] could not report interrupted turn session=${sessionId} turn=${turnId ?? "pending"}:`, err);
        }
      }
      // A delegated turn's caller is a machine that will otherwise wait out its idle
      // window and report a failure. Same terminal, but acknowledged — detached,
      // because this runs on the shutdown path and must not hold it open.
      for (const turnId of unreported) {
        const delegated = delegatedTurns.get(turnId);
        if (!delegated) continue;
        const delivery = deliverDelegationTerminal(delegated.delegationId, sessionId, turnId, {
          type: "prompt_done",
          aborted: true,
          reason,
          // The interrupted leg's rows were already persisted under this trace by the
          // consume that just got cut short — an aborted terminal without it would
          // leave exactly the legs a review drills into unlinked.
          ...(delegated.traceId ? { traceId: delegated.traceId } : {}),
        });
        started.push(trackForShutdown(delivery));
      }
      // Abort AFTER reporting: it makes the consumer run its own finalization (partial
      // text persisted, running tool rows closed) so a reload agrees with the screen.
      // EVERY live turn, not only the streaming one: a turn queued behind the session
      // lock was just reported as interrupted, so it must not go on to start.
      for (const id of sessionTurns) turnAborts.get(id)?.abort();
      ctrl?.abort();
      activeStreamAborts.delete(sessionId);

      // Cancelling on this side does not stop the BOX. The consumer only notices its
      // signal when the next event arrives, and a dropped SSE subscription just
      // unsubscribes — neither ends the prompt. In K8s the boxes deliberately outlive
      // a Runtime roll, so a turn already reported as interrupted would keep running
      // there with nobody left to read it. Only a dispatched turn has a box to ask,
      // and `busyOn` is the record of that placement.
      // Including on a box roll. The box is NOT reliably gone by then: the manager
      // reports the interruption before it asks the spawner to stop the box, and a
      // failed stop is left for a later retry — so in that window the prompt keeps
      // running, and producing tool side effects, with the consumer already dropped.
      // A box that has in fact gone is simply the outcome we wanted, so failures here
      // are ignored; only a shutdown, where the box is expected to answer, says so
      // loudly.
      const placement = sessionTurnLocks.busyOn(sessionId);
      if (placement) {
        const client = new AgentBoxClient(placement.endpoint, 10000, agentBoxTlsOptions);
        for (const id of sessionTurns) {
          if (boxAbortAsked.has(id)) continue;
          boxAbortAsked.add(id);
          started.push(trackForShutdown(stopTurnOnBox(client, sessionId, id, placement.boxId, reason)));
        }
      }
    }
    return started;
  }

  /**
   * Shutdown ends every turn this Runtime is streaming. Delegated ones are reported
   * with an acknowledgement, which needs the transport that shutdown is about to
   * close — so wait for those, but briefly: a live connection settles the first
   * attempt in milliseconds, and a dead one must not hold the process open for the
   * full retry budget.
   */
  const SHUTDOWN_TERMINAL_GRACE_MS = 3_000;

  async function endInFlightTurns(): Promise<void> {
    // Fence first: from here no new turn is admitted, so the passes below converge.
    // Fence FIRST, then take stock once.
    //
    // The fence is what makes one snapshot sufficient FOR THE TURNS THIS DRAIN COVERS —
    // the chat.send and delegation ingresses, which are the only ones ever registered in
    // liveTurnIds. After it, none of their producers can add work this snapshot would
    // miss: no new turn is admitted; a turn that finishes now finds itself already
    // reported and does not report again; and a box removal finds every live turn
    // claimed and already asked to stop. Re-scanning was tried and removed for exactly
    // that reason — nothing reachable turned up in a second pass, and unexercised
    // machinery on the shutdown path is its own hazard.
    //
    // Other producers of AgentBox work — the task coordinator's cron/fire-now jobs and
    // capability runs — keep their own clients and were never registered here, so they
    // are neither fenced nor drained. That predates this drain and is not narrowed by
    // it; closing it means giving those paths the same admission gate and registration,
    // which is its own change.
    shuttingDown = true;

    // Wind down work that is past refusing. Done BEFORE the snapshot below so whatever
    // these start — a remote delegation.abort, a peer box abort — is waited on too.
    for (const cancel of [...shutdownCancels]) {
      trackForShutdown(Promise.resolve().then(cancel).catch((err) => {
        console.warn("[runtime] shutdown wind-down hook failed:", err);
      }));
    }

    // Streaming turns AND cold-starting ones: both are ours, and both leave a caller
    // waiting if they simply vanish.
    const sessionIds = [...new Set([...activeStreamAborts.keys(), ...liveTurnIds.keys()])];
    // Work a turn started before the fence and has not finished: its delivery is exactly
    // the report its caller needs.
    const alreadyPending = [...pendingShutdownWork];
    if (sessionIds.length === 0 && alreadyPending.length === 0) return;
    // Say it happened. Reporting used to be silent on success, so the only way to tell
    // whether a restart had ended its turns was to go ask the consumer — during an
    // incident, from the outside. The failure path already logs; this is its other half.
    if (sessionIds.length > 0) {
      console.log(`[runtime] shutdown interrupting ${sessionIds.length} in-flight turn(s): ${sessionIds.join(", ")}`);
    }
    const work = [...endTurns(sessionIds, "runtime_restart"), ...alreadyPending];
    if (work.length === 0) return;
    await Promise.race([
      Promise.allSettled(work),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TERMINAL_GRACE_MS)),
    ]);
  }

  // A box removed while it still holds turns breaks their SSE streams, which does end
  // them — but as an anonymous transport failure. Reporting here instead names the cause.
  agentBoxManager.setTurnTerminator?.(endTurns);

  // Reported on every (re)connect so a consumer can settle the turns this Runtime is NOT
  // streaming. After a restart the list is empty, which is the honest answer: the boxes
  // still hold those sessions, but nothing is reading them any more.
  frontendClient.setActiveSessionsProvider?.(() => [...activeStreamAborts.keys()]);

  // Accepted dispatches by `${sessionId}:${dispatchId}`, so a management-plane
  // retry of a dispatch whose ack was lost is idempotent (see chat.send below).
  // Process-local on purpose: a turn cannot outlive this process, so a fresh
  // process re-running the dispatch is a correct retry, not a duplicate.
  const recentDispatches = new Map<string, { turnId: string; at: number }>();
  const DISPATCH_DEDUPE_TTL_MS = 6 * 60 * 60 * 1000;
  const DISPATCH_DEDUPE_MAX = 2000;
  const rememberDispatch = (key: string, turnId: string): void => {
    const now = Date.now();
    if (recentDispatches.size >= DISPATCH_DEDUPE_MAX) {
      for (const [k, v] of recentDispatches) {
        if (now - v.at > DISPATCH_DEDUPE_TTL_MS) recentDispatches.delete(k);
      }
      // Still full after pruning by age: drop the oldest entries (Map preserves
      // insertion order) rather than grow without bound.
      while (recentDispatches.size >= DISPATCH_DEDUPE_MAX) {
        const oldest = recentDispatches.keys().next().value;
        if (oldest === undefined) break;
        recentDispatches.delete(oldest);
      }
    }
    recentDispatches.set(key, { turnId, at: now });
  };

  rpcMethods.set("chat.send", async (params, context: RpcContext) => {
    const agentId = params.agentId as string;
    const userId = params.userId as string;
    const orgId = params.orgId as string | undefined;
    const text = params.text as string;
    const incomingSessionId = params.sessionId as string | undefined;
    // Session entry-form for audit categorization (Web / API / A2A). null =
    // web (default). Portal call sites stamp "api" (/api/v1/run) and "a2a";
    // channels stamp "channel" via their own ensureChatSession. Only consumed
    // when THIS handler creates the session row.
    const origin = params.origin as string | undefined;
    // Delegation marker: present when a coordinator agent (e.g. the incident
    // concierge) delegated this turn over the mesh. Forwarded to the agentbox so
    // the worker gates its toolset read-only and stamps the result artifact.
    const delegation = params.delegation as PromptOptions["delegation"];
    const allowInputRequest = params.allowInputRequest === true;
    const requireExistingSession = params.requireExistingSession === true;
    // Signed authority envelope (trusted-execution contract): forwarded opaque;
    // the AgentBox verifies it locally and enforces it at the tool layer.
    const authorityEnvelope = typeof params.authorityEnvelope === "string" && params.authorityEnvelope
      ? params.authorityEnvelope
      : undefined;
    // A cross-Runtime delegation session is created by the coordinator Runtime
    // before ControlPlane routes this chat.send to the target Runtime. Re-inserting the
    // session/user row here would overwrite ownership/lineage and duplicate the
    // delegated task. Only honor the flag on an authenticated delegation turn.
    // promptMessageId intentionally stays undefined on this path: the source
    // Runtime already persisted and sequenced the user row, so the target must
    // not bind or update a second local copy of it.
    const skipInitialPersistence = params.skipInitialPersistence === true && Boolean(delegation?.delegationId);
    // Machine-facing strict callers cannot safely publish a reusable sessionId
    // until its session and first user message are durable. Interactive chat
    // keeps the legacy best-effort behavior; strict /run opts into this ACK.
    const requireSessionPersistence = params.requireSessionPersistence === true;
    const requiredResultToolName = typeof params.requiredResultToolName === "string"
      ? params.requiredResultToolName.trim() || undefined
      : undefined;
    // Portal stamps turnStartMs at POST receipt — closer to user click than
    // the runtime's loop start. Use it as the canonical turn anchor when
    // present; fall back gracefully so direct callers (tests, /run path)
    // still work without it.
    const turnStartMs = typeof params.turnStartMs === "number" ? params.turnStartMs : undefined;

    if (!agentId || !userId || !text) {
      throw new Error("agentId, userId, and text are required");
    }
    // Refuse rather than accept a turn this process will not be around to finish. The
    // caller can place it on a Runtime that will.
    if (shuttingDown) {
      const err = new Error("Runtime is shutting down; this turn was not started");
      err.name = "RuntimeShuttingDown";
      throw err;
    }

    // Pre-generate a UUID so AgentBox doesn't fall back to the literal
    // "default" session id (LocalSpawner behaviour), which would merge
    // every caller's trace into one chat_sessions row.
    const sessionId = incomingSessionId ?? crypto.randomUUID();
    sessionRegistry.remember(sessionId, userId, agentId);

    const modelConfig = params.modelConfig as PromptOptions["modelConfig"];
    const modelRouting = params.modelRouting as PromptOptions["modelRouting"];
    // Sub-agent tier CANDIDATES, relayed like every other binding field on this
    // path. Omitting it was a hard blocker rather than a degradation: the menu
    // travels on the tools channel and arrives, so the lead sees `model_tier`,
    // picks a tier, and every child falls back — the one-sided state the runtime
    // reports as candidate_missing. `chat.send` is THE entry path under a control
    // plane, so the whole feature was inert there while every unit test passed.
    const subagentTiers = params.subagentTiers;
    const images = params.images as PromptOptions["images"];
    const files = params.files as PromptOptions["files"];
    // One id for this turn, held from before the async ack until the turn settles.
    // A supervisor that will need to abort this turn later supplies it BEFORE the
    // dispatch, so a lost acknowledgement still leaves it able to name the turn;
    // ordinary callers let us mint one.
    const turnId = typeof params.turnId === "string" && params.turnId ? params.turnId : crypto.randomUUID();

    // Dispatch idempotency. A caller that lost this RPC's ack cannot know
    // whether the turn started; retrying with the same dispatchId answers that
    // question without side effects — the retry NEVER starts a second turn and
    // NEVER falls into the busy-session steer path (which would inject the same
    // input into the running turn twice). Reserved before the first await so a
    // concurrent retry cannot slip in mid-persistence.
    const dispatchId = typeof params.dispatchId === "string" && params.dispatchId ? params.dispatchId : undefined;
    const dispatchKey = dispatchId ? `${sessionId}:${dispatchId}` : undefined;
    if (dispatchKey) {
      const seen = recentDispatches.get(dispatchKey);
      if (seen) {
        return { ok: true, sessionId, turnId: seen.turnId, duplicate: true };
      }
      rememberDispatch(dispatchKey, turnId);
    }

    /**
     * Report this turn's own terminal — only a delegated turn has a caller for it.
     *
     * Detached on purpose: the delivery may retry for as long as a reconnect takes,
     * and the turn must not stay open for that. Deregistering the turn here is what
     * makes it safe: the supervisor will not also report it, so a shutdown during
     * the retries cannot turn a finished turn into an interrupted one.
     */
    // Riding the trace id on the terminal event is what hands it to the SOURCE
    // Runtime: chat.send acks in milliseconds (before the trace exists) and
    // chat.getMessages does not project trace_id, so the terminal is the one channel
    // the coordinator side can learn which trace this leg's rows were persisted
    // under — the value it stores as the tool row's `child_trace_id` link. The id is
    // read from the delegatedTurns ledger entry (recorded at prompt ack), the same
    // place the supervisor path reads it, so the two producers cannot disagree.
    const reportTerminal = (event: Record<string, unknown>): void => {
      const delegationId = delegation?.delegationId;
      if (!delegationId) return;
      const traceId = delegatedTurns.get(turnId)?.traceId;
      delegatedTurns.delete(turnId);
      const terminal = traceId ? { ...event, traceId } : event;
      void trackForShutdown(deliverDelegationTerminal(delegationId, sessionId, turnId, terminal));
    };
    const promptOpts: PromptOptions = {
      sessionId,
      turnId,
      requiredResultToolName,
      userId,
      text,
      agentId,
      modelProvider: params.modelProvider as string | undefined,
      modelId: params.modelId as string | undefined,
      releaseId: params.releaseId as string | undefined,
      modelFingerprint: params.modelFingerprint as string | undefined,
      systemPromptTemplate: params.systemPrompt as string | undefined,
      mode: params.mode as string | undefined,
      origin: origin as PromptOptions["origin"],
      delegation,
      allowInputRequest,
      requireExistingSession,
      authorityEnvelope,
      modelConfig,
      modelRouting,
      subagentTiers,
      images,
      files,
    };

    // Async-ack protocol: return { ok, sessionId } within milliseconds; do
    // every slow step (agentbox spawn, prompt() roundtrip, SSE consume) in
    // the background and stream events back to Portal via the chat.event
    // WS channel.
    //
    // Why: the management server's WS RPC carries a fixed 30s timeout. Coupling the ack
    // to "agentbox is ready and prompt() returned" forced that timeout to
    // cover worst-case cold-start (image pull, container start, ready
    // probe), which routinely exceeds 30s and produced spurious
    // CONNECTION_TIMEOUT bubbles even when the runtime was healthy. Once
    // the bubble fires, the management server tears down the SSE response and the
    // delayed reply (which still arrives later) is dropped — leaving a
    // ghost session in DB and a confused user.
    //
    // After the ack, the existing chat.event stream (agent_start /
    // agent_end / agent_message / stream_error / prompt_done) carries
    // every observable progress signal the frontend needs.
    // Persist the user's message BEFORE answering the RPC, and before the turn starts.
    //
    // Two reasons, and the second is the one that bites. consumeAgentSse writes rows that
    // reference chat_sessions, so the session row has to exist first. And a write that
    // happened after this RPC returned was a write nobody was waiting on: if it failed —
    // or the process died — the message vanished while the turn ran anyway, so "your
    // message was recorded" was not actually true when we said it.
    //
    // Interactive callers retain the legacy best-effort behavior: they lose the
    // row id and fall back to matching by content. A strict machine caller opts
    // into failing this ACK because it will expose sessionId as a durable handle.
    // Registered before the async ack below, and before the persistence awaits: this
    // closes the cold-start window in which chat.abort had no local cancellation state
    // to update, and it is what makes the shutdown fence airtight — a handler that got
    // past the check above is already visible to the drain, instead of appearing after
    // it while it was still in the database.
    const turnAbort = new AbortController();
    registerPendingStart(sessionId, turnAbort);
    addLiveTurn(sessionId, turnId, turnAbort);
    if (delegation?.delegationId) delegatedTurns.set(turnId, { delegationId: delegation.delegationId, sessionId });

    let promptMessageId: string | undefined;
    if (!skipInitialPersistence) {
      try {
        await ensureChatSession(sessionId, agentId, userId, text, undefined, origin);
        promptMessageId = await appendMessage({ sessionId, role: "user", content: text, deferSequence: true });
        await incrementMessageCount(sessionId);
      } catch (persistErr) {
        if (requireSessionPersistence) {
          unregisterPendingStart(sessionId, turnAbort);
          dropLiveTurn(sessionId, turnId);
          delegatedTurns.delete(turnId);
          sessionRegistry.forget(sessionId);
          const err = new Error("chat.send could not durably persist the session before acknowledgement", {
            cause: persistErr,
          });
          err.name = "SessionPersistenceError";
          throw err;
        }
        console.warn(`[runtime] failed to persist the user message session=${sessionId}; continuing without a row id:`, persistErr);
      }
    }
    const throwIfStoppedBeforePrompt = () => {
      if (!turnAbort.signal.aborted) return;
      const err = new Error("chat.send stopped before prompt dispatch");
      err.name = "AbortError";
      throw err;
    };

    (async () => {
      // One turn at a time for this session, across every box. The AgentBox's own 409
      // only sees its own sessions, so with more than one box two sends could be
      // dispatched to two boxes and both would run — two writers on one transcript.
      // Released in the finally below so a throw cannot wedge the session.
      let releaseTurn: (() => void) | undefined;
      try {
        // One turn at a time for this session, across every box (see session-turn-lock.ts).
        // If the session is already running, fall back to the SAME steer the AgentBox's own
        // 409 used to trigger — the message rides the in-flight turn's stream. Emitting a
        // stream_error/prompt_done here instead would tell the frontend the RUNNING turn
        // had ended: it stops rendering and hides Stop while the turn is still going.
        try {
          releaseTurn = await sessionTurnLocks.acquire(sessionId);
        } catch (busyErr) {
          throwIfStoppedBeforePrompt();
          // A strict machine request is one distinct turn with one distinct
          // result. Folding it into the running turn as a steer would lose its
          // required-result contract, so surface busy and let the caller retry.
          if (requiredResultToolName) throw busyErr;
          const running = sessionTurnLocks.busyOn(sessionId);
          const steered = running ? await new AgentBoxClient(running.endpoint, 10000, agentBoxTlsOptions)
            .steerSession(sessionId, text, { images, files })
            .catch((e) => { console.warn(`[runtime] steer into ${running.boxId} failed session=${sessionId}:`, e); return undefined; })
            : undefined;
          if (steered) {
            console.log(`[runtime] session=${sessionId} busy; steered into the turn on ${running!.boxId}`);
            if (promptMessageId) pendingUserRows.push(sessionId, promptMessageId, text);
            if (promptMessageId) await updateMessage({ messageId: promptMessageId, sessionId, content: text, metadata: { kind: "steer" } })
              .catch((e) => console.warn(`[runtime] failed to mark steer message session=${sessionId}:`, e));
            if (promptMessageId) void bindMessageTraceId(promptMessageId, sessionId, steered.traceId).catch((bindErr) => {
              warnTraceBindFailure("busy-degrade steer", sessionId, promptMessageId!, bindErr);
            });
            return; // the running turn owns the stream and will emit its own prompt_done
          }
          // No steer target, or the turn ended between the rejection and the steer. Ask
          // for the lock once more; if it is genuinely still busy this throws and the
          // caller gets the ordinary busy error.
          releaseTurn = await sessionTurnLocks.acquire(sessionId);
        }
        throwIfStoppedBeforePrompt();

        // Agent-Addendum precedence for the box session. An explicit
        // params.systemPrompt (the portal-standalone path stamps it from the
        // agent's model binding) wins as-is. When the caller does NOT forward one
        // — e.g. control-plane's web-chat proxy, which never sends systemPrompt — fall
        // back to the Agent's persisted Addendum (agents.system_prompt via
        // config.getAgent). The AgentBox separately compiles immutable type policy.
        //
        // Best-effort: resolveAgentSystemPrompt swallows RPC errors and returns
        // undefined (no Addendum / lookup failed) → type contract only, so a lookup
        // failure never turns into a chat failure. Prompt publication invalidates
        // warm sessions, so the next turn rebuilds with the latest value.
        if (promptOpts.systemPromptTemplate === undefined) {
          promptOpts.systemPromptTemplate = await resolveAgentSystemPrompt(agentId, frontendClient);
        }
        throwIfStoppedBeforePrompt();

        // Persistence is resolved by agentId in the manager's persistenceResolver
        // (registered in startRuntime), not from per-request params — so every
        // entry point lands the same mode for the same agent.
        const handle = await agentBoxManager.getOrCreate(agentId, undefined, sessionId);
        const selectedBoxId = handle.boxId ?? "unknown";
        console.log(`[runtime] chat.send selected agentId=${agentId} sessionId=${sessionId} turnId=${turnId} boxId=${selectedBoxId}`);
        // Which box this turn went to. Placement reads it back as a hint while the turn
        // runs; it is dropped on release, so it can never become a stale binding.
        sessionTurnLocks.noteBox(sessionId, handle.boxId, handle.endpoint);
        const client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);
        throwIfStoppedBeforePrompt();

        let promptResult: Awaited<ReturnType<typeof client.prompt>>;
        let ackTraceId: string | undefined;
        const promptStartedAt = Date.now();
        try {
          promptResult = await client.prompt(promptOpts);
          console.log(`[runtime] AgentBox prompt result agentId=${agentId} sessionId=${sessionId} turnId=${turnId} boxId=${selectedBoxId} status=200 ok=true durationMs=${Date.now() - promptStartedAt} traceIdPresent=${Boolean(promptResult.traceId)}`);
          // The ack's trace id is gated ONCE and every consumer of it below — the
          // delegated-turn ledger, the prompt-row bind, the consume's row stamp —
          // uses the gated value: stamping rows with a malformed id one boundary
          // accepts and another rejects is how a turn ends up persisted under an id
          // no link references.
          ackTraceId = validTraceId(promptResult.traceId);
          // Record the delegated turn's trace id on its ledger entry IMMEDIATELY —
          // before any Stop/abort handling below — so a turn interrupted between the
          // ack and the consume still reports the trace its rows were persisted under.
          const delegated = delegatedTurns.get(turnId);
          if (delegated) delegated.traceId = ackTraceId;
          // The box now has the session: a steer racing this call can stop waiting, and
          // this row is in line to be processed (see pending-user-rows.ts).
          sessionTurnLocks.markPromptAccepted(sessionId);
          // Stop may have arrived while prompt() was in flight, before the box had a
          // session for chat.abort to find. Abort again now that acceptance is known;
          // never attach a consumer to a turn whose Stop was already acknowledged.
          if (turnAbort.signal.aborted) {
            // We are about to abandon this turn's stream, so a failed abort here
            // leaves the box running with no consumer. The box demonstrably HAS the
            // session (it just accepted the prompt), so retrying is safe and cannot
            // plant a pre-spawn latch — keep trying briefly before giving up.
            let stopped = false;
            for (let attempt = 1; attempt <= 3 && !stopped; attempt += 1) {
              try {
                await client.abortSession(promptResult.sessionId, turnId);
                stopped = true;
              } catch (abortErr) {
                if (isSessionNotFound(abortErr)) {
                  stopped = true;
                  break;
                }
                console.warn(`[runtime] attempt ${attempt} to stop newly accepted session=${promptResult.sessionId} failed:`, abortErr);
                if (attempt < 3) await new Promise((r) => setTimeout(r, 200 * attempt));
              }
            }
            if (!stopped) {
              console.error(`[runtime] gave up stopping session=${promptResult.sessionId}; its turn may run without a consumer`);
            }
            throwIfStoppedBeforePrompt();
          }
          if (promptMessageId) pendingUserRows.push(sessionId, promptMessageId, text);
        } catch (err) {
          const summary = summarizeDispatchError(err);
          const resultLog = summary.status === 409 || summary.message.includes("Session is already running")
            ? console.warn
            : console.error;
          resultLog(`[runtime] AgentBox prompt result agentId=${agentId} sessionId=${sessionId} turnId=${turnId} boxId=${selectedBoxId} status=${summary.status ?? 0} ok=false code=${summary.code} retriable=${summary.retriable} durationMs=${Date.now() - promptStartedAt} error=${JSON.stringify(summary.message)}`);
          // Concurrent send: agentbox returns 409 "Session is already
          // running. Use the steer endpoint to add input to the active
          // prompt." when the user double-taps send before the previous
          // prompt's pi-agent retries settle. Per agentbox's own hint,
          // inject as steer — the message rides on the still-running
          // prompt's stream. Don't emit prompt_done here: the running
          // prompt will fire its own when it actually finishes, and an
          // extra one would close the frontend stream prematurely.
          if (err instanceof Error && err.message.includes("Session is already running")) {
            if (requiredResultToolName) throw err;
            const steerResult = await client.steerSession(sessionId, text, { images, files });
            if (promptMessageId) pendingUserRows.push(sessionId, promptMessageId, text);
            // chat.send persisted this row before it knew the active session would
            // reject a fresh prompt. Once the fallback steer is accepted, label the
            // existing row so transcript/trace readers do not mistake it for the
            // prompt that started the active trace.
            if (promptMessageId) await updateMessage({
              messageId: promptMessageId,
              sessionId,
              content: text,
              metadata: { kind: "steer" },
            }).catch((updateErr) => {
              console.warn(`[runtime] failed to mark automatic steer message session=${sessionId} message=${promptMessageId}:`, updateErr);
            });
            if (promptMessageId) void bindMessageTraceId(promptMessageId, sessionId, steerResult.traceId).catch((bindErr) => {
              warnTraceBindFailure("automatic steer", sessionId, promptMessageId!, bindErr);
            });
            return;
          }
          // Most dispatch failures have an UNKNOWN outcome, not "did not happen":
          // AgentBox starts the run before it acknowledges /api/prompt, so a lost
          // or timed-out ack can leave a real turn running with nobody consuming it.
          // Compensate those failures even when Stop was never requested.
          //
          // Addressed BY TURN, which is what makes it unconditionally safe: if the box
          // never started this turn the abort is a no-op it cannot confuse with a later
          // one, and if it did start it, this is the only thing that stops it. The
          // ORIGINAL failure is what the caller must see, so a compensation that
          // cannot complete is logged loudly rather than substituted for it.
          // A 412 continuation rejection is different: AgentBox checked the
          // durable context before creating the session or starting a prompt,
          // so an abort would only plant a stale pre-spawn latch for a turn that
          // can never run.
          if (summary.code !== ErrorCodes.SESSION_CONTEXT_UNAVAILABLE) {
            try {
              await client.abortSession(sessionId, turnId);
            } catch (compensateErr) {
              console.error(`[runtime] could not stop turn=${turnId} session=${sessionId} after a failed prompt; it may run without a consumer:`, compensateErr);
            }
          }
          throw err;
        }

        if (promptMessageId) void bindMessageTraceId(promptMessageId, promptResult.sessionId, ackTraceId).catch((bindErr) => {
          warnTraceBindFailure("prompt", promptResult.sessionId, promptMessageId!, bindErr);
        });

        const redactionConfig = buildRedactionConfigForModelConfig(modelConfig);
        const abortCtrl = turnAbort;
        const promptDoneEvent = () => ({
          type: "prompt_done",
          ...(typeof promptResult.resumed === "boolean" ? { resumed: promptResult.resumed } : {}),
        });
        // Register this turn's abort signal so chat.abort can break the consumer
        // (see activeStreamAborts declaration). Placed AFTER prompt() succeeds, on
        // the path that actually consumes: the concurrent-send "already running"
        // branch early-returns above (steer) before this line, so it never clobbers
        // the in-flight prompt's controller in the map. Keyed on the agentbox-echoed
        // promptResult.sessionId — the same id chat.abort looks up.
        activeStreamAborts.set(promptResult.sessionId, abortCtrl);
        unregisterPendingStart(sessionId, turnAbort);

        /**
         * Whether this turn's terminal was already sent by the supervisor (shutdown, or a
         * box removed under it). One-shot: the id is consumed, so a later turn on the same
         * session reports normally.
         */
        // Non-consuming for this turn: it reaches this question on more than one path
        // and the answer must not change between them.
        const alreadyReported = () =>
          supervisorEndedTurns.has(turnId) || supervisorEndedTurns.delete(promptResult.sessionId);

        try {
          await consumeAgentSse({
            client,
            sessionId: promptResult.sessionId,
            userId,
            traceId: ackTraceId,
            persistMessages: true,
            // The box has started consuming a user message: give that row its place in
            // the conversation now, which is the only moment processing order is visible.
            onUserMessageStarted: async (echoedText) => {
              const messageId = pendingUserRows.claim(promptResult.sessionId, echoedText);
              if (!messageId) return; // an echo for a turn this Runtime did not start
              await sequenceMessage(messageId, promptResult.sessionId).catch((err) => {
                warnTraceBindFailure("sequence", promptResult.sessionId, messageId, err);
              });
            },
            redactionConfig,
            signal: abortCtrl.signal,
            turnStartTime: turnStartMs,
            onEvent: (evt, _eventType, extras) => {
              context.sendEvent("chat.event", {
                sessionId: promptResult.sessionId,
                turnId,
                event: extras.dbMessageId ? { ...evt, dbMessageId: extras.dbMessageId } : evt,
              });
            },
          });
          if (!alreadyReported()) {
            const event = promptDoneEvent();
            context.sendEvent("chat.event", { sessionId: promptResult.sessionId, turnId, event });
            reportTerminal(event);
          }
        } catch (err) {
          if (!abortCtrl.signal.aborted) {
            console.error(`[runtime] SSE stream error for session=${promptResult.sessionId}:`, err);
            const detail = wrapError(err, {
              code: ErrorCodes.STREAM_INTERRUPTED,
              retriable: true,
            });
            context.sendEvent("chat.event", {
              sessionId: promptResult.sessionId,
              turnId,
              event: { type: "stream_error", error: detail },
            });
          }
          // Shutdown, or a box removal, already reported this turn before aborting it.
          if (!alreadyReported()) {
            const event = promptDoneEvent();
            context.sendEvent("chat.event", { sessionId: promptResult.sessionId, turnId, event });
            reportTerminal(event);
          }
        } finally {
          // Only clear if still ours — a fast re-send for the same session would
          // have replaced the entry with a newer controller.
          if (activeStreamAborts.get(promptResult.sessionId) === abortCtrl) {
            activeStreamAborts.delete(promptResult.sessionId);
          }
        }
      } catch (err) {
        // Failure before/during agentbox spawn or prompt() — surface as a
        // stream_error so the frontend renders an inline bubble instead of
        // hanging on the spawning state forever.
        if (!turnAbort.signal.aborted) {
          const detail = summarizeDispatchError(err);
          console.error(`[runtime] chat.send background failure agentId=${agentId} sessionId=${sessionId} turnId=${turnId} status=${detail.status ?? 0} code=${detail.code} retriable=${detail.retriable} error=${JSON.stringify(detail.message)}`);
          context.sendEvent("chat.event", {
            sessionId,
            turnId,
            event: { type: "stream_error", error: detail },
          });
        }
        // The supervisor may have reported this turn already — a queued turn cancelled
        // by a shutdown or a box removal reaches this catch through its pre-prompt
        // check. A second, PLAIN terminal would contradict that one: without
        // `aborted` it reads as a turn that completed.
        if (!supervisorEndedTurns.has(turnId)) {
          context.sendEvent("chat.event", { sessionId, turnId, event: { type: "prompt_done" } });
          reportTerminal({ type: "prompt_done" });
        }
      } finally {
        // Anything still queued was never consumed — a steer the user sent into a turn
        // that finished first. It must not be claimed by the next turn's first echo.
        pendingUserRows.clear(sessionId);
        unregisterPendingStart(sessionId, turnAbort);
        dropLiveTurn(sessionId, turnId);
        delegatedTurns.delete(turnId);
        supervisorEndedTurns.delete(turnId);
        boxAbortAsked.delete(turnId);
        releaseTurn?.();
      }
    })();

    // The row id, so a caller can reconcile its optimistic bubble by identity instead of
    // by content — two messages with the same text are two messages. Absent when the
    // write above failed.
    // turnId travels back so a supervisor can later abort THIS turn specifically
    // rather than "whatever is running on this session".
    return {
      ok: true,
      sessionId,
      turnId,
      ...(promptMessageId ? { messageId: promptMessageId } : {}),
      // Version 1 promises all strict semantics as one capability: durable ACK,
      // required structured-result repair, and a correlated failure terminal
      // instead of degrading a concurrent request into the active turn.
      ...(requireSessionPersistence && requiredResultToolName
        ? { strictResultProtocolVersion: 1 }
        : {}),
    };
  });

  // ── Shared capability box client ───────────────────────────────────────────
  // Local development escape hatch: point SICLAW_COMPILE_BOX_ENDPOINT at a
  // manually started kbc box (usually http://127.0.0.1:3000) to reuse a local
  // Claude Code/OAuth session while testing the consumer↔runtime protocol.
  const localCapabilityBoxEndpoint = process.env.SICLAW_COMPILE_BOX_ENDPOINT?.trim();
  const capabilityBoxClient = async (
    runId: string,
    profile: string,
    orgId?: string,
  ): Promise<{ client: AgentBoxClient; created: boolean }> => {
    if (localCapabilityBoxEndpoint) {
      return {
        client: new AgentBoxClient(localCapabilityBoxEndpoint, 30000, agentBoxTlsOptions),
        created: false,
      };
    }
    // Compatibility for embedded managers/test doubles built before acquisition
    // disposition existed. The concrete manager always reports it; an older
    // implementation is conservatively treated as the creator so failed setup
    // retains the historical cleanup behavior.
    const manager = agentBoxManager as AgentBoxManager & {
      getOrCreateWithDisposition?: AgentBoxManager["getOrCreateWithDisposition"];
    };
    const acquired = typeof manager.getOrCreateWithDisposition === "function"
      ? await manager.getOrCreateWithDisposition(runId, { profile, orgId })
      : { handle: await manager.getOrCreate(runId, { profile, orgId }), created: true };
    return {
      client: new AgentBoxClient(acquired.handle.endpoint, 30000, agentBoxTlsOptions),
      created: acquired.created,
    };
  };

  // ── Capability protocol (option B): siclaw owns the run lifecycle ──────────
  // siclaw MINTS the runId and persists execution state to the consumer's opaque
  // store (capability.persistRunState); the box is driven over the GENERIC
  // capability wire (capability.event / persistArtifact / fetchInput) with the
  // manager owning lifecycle. This is the ONLY KB box control plane — the legacy
  // compile.* path was deleted in B4; authoring-chat runs entirely on capability.*.
  const capabilityRunManager = new CapabilityRunManager(frontendClient, {
    // A reaped run must not leave its box behind: stop the pod before the run's
    // terminal mark, so the store and the cluster agree. Local escape-hatch boxes
    // aren't managed by the spawner — stop() is a no-op/404 there, hence catch.
    onReap: async (rec) => {
      // Pass the run's profile so the manager targets the right pod name — a
      // compile box is "kbc-box-<id>", not "agentbox-<id>"; a mismatched name
      // would 404 and leak the pod instead of reaping it.
      await agentBoxManager.stop(rec.runId, rec.profile).catch((err) => {
        console.warn(`[capability] reap: stopping box ${rec.runId} failed:`, err instanceof Error ? err.message : String(err));
      });
    },
    // A recovered/adopted run whose box is STILL ALIVE gets its relay re-attached
    // immediately: the box's queued events replay (late-persisting turns and
    // artifacts we missed during the restart), touch resumes, and the watchdog
    // stops seeing a deaf-but-healthy run as stale. Dead boxes stay lazy — the
    // next message respawns them (with workspace rehydration); we don't
    // resurrect pods for possibly-abandoned runs.
    onAdopt: (rec) => {
      void (async () => {
        try {
          const alive = await agentBoxManager.getAsync(rec.runId, rec.profile);
          if (!alive) return;
          await ensureCapabilitySession(
            rec.runId,
            rec.profile,
            rec.orgId || undefined,
            undefined,
            { replayWorkspace: true },
          );
          console.log(`[capability] re-attached relay to live box for recovered run ${rec.runId}`);
        } catch (err) {
          console.warn(`[capability] relay re-attach for ${rec.runId} skipped:`, err instanceof Error ? err.message : String(err));
        }
      })();
    },
  });

  // One persistent capability session (box + relay loop) per run; a later message
  // reattaches instead of spawning a second relay. The profile comes from the
  // run record minted at capability.start — the box shape + tool/trust envelope
  // is fixed for the run's lifetime, never re-negotiated per message.
  const capabilitySessions = new Map<string, Promise<{ client: AgentBoxClient }>>();
  const ensureCapabilitySession = (
    runId: string,
    profile: string,
    orgId: string | undefined,
    instruction: string | undefined,
    opts: { replayWorkspace?: boolean } = {},
  ) => {
    // An empty profile would silently resolve to the all-tools default agent
    // profile (getBoxProfile("") → AGENT) — the wrong shape AND a trust
    // escalation. Runs minted via capability.start always carry one; refuse
    // anything else (e.g. a corrupt adopted row) instead of guessing.
    if (!profile) throw new Error(`capability run ${runId} has no profile`);
    let pending = capabilitySessions.get(runId);
    if (!pending) {
      pending = (async () => {
        const { client, created } = await capabilityBoxClient(runId, profile, orgId);
        let replayWorkspace = opts.replayWorkspace === true;
        try {
          // Raw sources + (fresh box only) the durable authoring workspace, both
          // from the consumer's store. Best-effort — see materializeCapabilityInputs.
          // The consumer also declares the run's LOCALE through the same channel;
          // the box selects its prompt pack with it (absent ⇒ English default).
          const materialized = await materializeCapabilityInputs({
            client,
            backend: frontendClient,
            runId,
            inputRevision: capabilityRunManager.get(runId)?.inputRevision,
          });
          replayWorkspace = replayWorkspace || materialized.reattached === true;
          if (materialized.inputRevision) {
            await capabilityRunManager.setInputRevision(runId, materialized.inputRevision);
          }
          const allowedTools = getBoxProfile(profile).allowedTools ?? null;
          await client.postJson(`/session/${runId}`, {
            instruction: instruction ?? "",
            allowed_tools: allowedTools,
            locale: materialized.locale,
            // Enables KBC's per-batch durability barrier. Mixed-version safe:
            // an older box ignores the field, while a newer box only waits for
            // ACKs when a runtime explicitly advertises this support.
            artifact_ack: true,
            // Whole-block authority: consumer LLM config wins as-is; only an
            // absent block uses Runtime's Helm env. The box applies it before
            // its SDK connects. Never logged here; token stays out of PodSpec.
            llm: resolveCapabilitySessionLlm(materialized.llm),
            settings: materialized.settings,
          });
        } catch (err) {
          if (err instanceof CapabilityMaterializationError) {
            capabilityMaterializationFailuresTotal.inc({ stage: err.stage });
          }
          // Only a box created by THIS setup attempt is disposable. A Runtime
          // replacement can be reattaching to an adopted live box; deleting it
          // because the consumer had a transient fetch failure would destroy the
          // in-flight turn that shutdown()/adopt are specifically preserving.
          if (created) {
            void agentBoxManager.stop(runId, profile).catch((stopErr) =>
              console.error(
                `[capability] stop new box after setup failure run=${runId}:`,
                stopErr instanceof Error ? stopErr.message : String(stopErr),
              ),
            );
          } else {
            console.warn(
              `[capability] setup failed while reattaching existing box run=${runId}; preserving it for retry`,
            );
          }
          throw err;
        }
        driveCapabilitySession({ client, runId, frontendClient, manager: capabilityRunManager, replayWorkspace })
          .catch(async (err) => {
            capabilityRelayFailuresTotal.inc();
            console.error(`[capability] session relay failed run=${runId}:`, err);
            const exceptionClass = err instanceof Error
              ? (asFailureToken(err.name) ?? "Error")
              : "NonErrorThrown";
            await capabilityRunManager
              .endRun(runId, "failed", {
                code: "relay_failed",
                stage: "session_relay",
                message: `relay_failed:${exceptionClass}`,
                exception_class: exceptionClass,
              })
              .catch(() => {});
          })
          .finally(() => {
            capabilitySessions.delete(runId);
            // The relay ending — cleanly (`end`: the box's session coroutine
            // exited and can never take another turn) or by crash (the catch
            // above) — means this one-run pod is unreachable garbage either
            // way. Stop it here, or every NORMALLY-completed run leaks a
            // running pod + cert Secret forever (audit finding; the crash
            // path was covered piecemeal before, this owns both). stop() is
            // 404-tolerant, so the idle-reap double-stop stays quiet.
            void agentBoxManager.stop(runId, profile).catch((stopErr) =>
              console.error(
                `[capability] stop box after relay close run=${runId}:`,
                stopErr instanceof Error ? stopErr.message : String(stopErr),
              ),
            );
          });
        return { client };
      })();
      capabilitySessions.set(runId, pending);
      pending.catch(() => capabilitySessions.delete(runId));
    }
    return pending;
  };

  // Recover AFTER ensureCapabilitySession exists — onAdopt re-attaches through it.
  const unsubscribeCapabilityReconnect = frontendClient.onConnected?.(() => capabilityRunManager.reconcile());
  void capabilityRunManager.recover();
  capabilityRunManager.startWatchdog();
  // Capability-box orphan GC: a box is live iff its run is tracked and
  // non-terminal. The sweep resolves the RAW run id from the pod's `agent`
  // label (stamped at spawn), so the oracle keys correctly for ANY id shape.
  // Optional-call: startRuntime tests inject minimal manager fakes that predate
  // this method — the sweep is an ops concern, never a boot requirement.
  agentBoxManager.startOrphanSweep?.(async (runRef) => {
    // Fallback only (label-less debris hands us a pod name): strip the pod
    // prefix. That inversion is exact only for minted lowercase-UUID run ids —
    // which is why the label, not this strip, is the primary channel (review).
    // A compile box carries the "kbc-box-" prefix, others "agentbox-".
    const runId = runRef.startsWith("kbc-box-")
      ? runRef.slice("kbc-box-".length)
      : runRef.startsWith("agentbox-")
        ? runRef.slice("agentbox-".length)
        : runRef;
    const rec = capabilityRunManager.get(runId);
    if (rec) return !isTerminalCapabilityStatus(rec.status);
    // Memory miss ≠ dead. Boot recovery can race the consumer (the exact
    // scenario adopt() exists for — e.g. a helm upgrade restarting both):
    // recover() fails soft, memory stays empty, and a memory-only oracle
    // would let the first sweep kill every LIVE idle box. Ask the store;
    // unknown/error counts as live — the sweep must fail safe (a leaked pod
    // survives one more cycle; a killed live box loses the owner's session).
    try {
      const row = (await frontendClient.request(CAPABILITY_GET_RUN, { run_id: runId })) as
        | { id?: string; status?: string }
        | null;
      return !!row?.id && !isTerminalCapabilityStatus((row.status as any) || "running");
    } catch {
      return true;
    }
  });

  rpcMethods.set("capability.start", async (params) => {
    const startedAt = Date.now();
    let startedRunId = "";
    const req = params as unknown as CapabilityStartRequest;
    const profile = req.profile?.trim();
    if (!profile) throw new Error("profile is required");
    // Fail-closed BEFORE minting the run: an unknown profile must never fall
    // back to some other box shape (that would hand out the wrong tool/trust
    // envelope), and we don't persist runs we can't spawn.
    getBoxProfile(profile);
    const orgId = req.org_id;
    const instruction = req.input?.instruction as string | undefined;
    let inputRevision: string | undefined;
    if (req.input_revision !== undefined) {
      if (typeof req.input_revision !== "string" || !req.input_revision.trim()) {
        throw new Error("input_revision must be a non-empty string");
      }
      inputRevision = req.input_revision.trim();
    }
    // siclaw mints the runId (the run is siclaw-owned). Initial status follows
    // the instruction: a kickoff instruction drives an immediate turn (running);
    // an instruction-less start (chat arrives via capability.message right
    // after, or the run only hosts test sessions) starts at rest (idle) — the
    // first capability.message flips it running.
    try {
      const rec = await capabilityRunManager.startRun({
        profile,
        orgId: orgId ?? "",
        correlationId: req.correlation_id,
        inputRevision,
        initialStatus: instruction && instruction.trim() ? "running" : "idle",
      });
      startedRunId = rec.runId;
      await ensureCapabilitySession(rec.runId, rec.profile, orgId, instruction);
      capabilityStartsTotal.inc({ outcome: "success" });
      capabilityStartDurationMs.observe({ outcome: "success" }, Date.now() - startedAt);
      const res: CapabilityStartResponse = { run_id: rec.runId };
      return res;
    } catch (err) {
      capabilityStartsTotal.inc({ outcome: "failure" });
      capabilityStartDurationMs.observe({ outcome: "failure" }, Date.now() - startedAt);
      if (startedRunId) {
        await capabilityRunManager.endRun(startedRunId, "failed", {
          code: "start_failed",
          stage: "capability_start",
          message: `start_failed:${err instanceof Error ? err.name : "Error"}`,
          exception_class: err instanceof Error ? err.name : undefined,
        });
      }
      throw err;
    }
  });

  rpcMethods.set("capability.message", async (params) => {
    const req = params as unknown as CapabilityMessageRequest;
    const runId = req.run_id;
    const message = req.message;
    const messageId = req.message_id?.trim();
    if (!runId) throw new Error("run_id is required");
    if (!message) throw new Error("message is required");
    if (messageId && messageId.length > 128) throw new Error("message_id must be at most 128 characters");
    // The run record is the authority for the box's profile/org. A run missing
    // from memory is first re-adopted from the consumer's store (heals a boot
    // recovery that raced the consumer); only a run the STORE doesn't know (or
    // already ended) is refused — never silently spawn an unmanaged box. The
    // consumer reacts by starting a fresh run (its find-or-start only reuses
    // non-terminal runs).
    const rec = capabilityRunManager.get(runId) ?? (await capabilityRunManager.adopt(runId));
    // A terminal record can linger in memory while its final persist retries
    // (flushTerminal) — it is just as unaddressable as an unknown run.
    if (!rec || isTerminalCapabilityStatus(rec.status)) throw new Error(`unknown capability run: ${runId}`);
    if (messageId && capabilityRunManager.hasMessageId(runId, messageId)) {
      return { ok: true, run_id: runId, duplicate: true };
    }
    capabilityRunManager.touch(runId); // keep the watchdog off an actively-used run
    const { client } = await ensureCapabilitySession(runId, rec.profile, rec.orgId || undefined, undefined);
    const previousStatus = rec.status;
    // Publish running BEFORE the box can emit turn_done. Posting first allowed a
    // fast turn_done→idle to land and then be overwritten by this handler's late
    // running write, leaving an already-finished turn permanently busy.
    await capabilityRunManager.setStatus(runId, "running");
    let accepted: { duplicate?: boolean };
    try {
      accepted = await client.postJson<{ duplicate?: boolean }>(`/message/${runId}`, {
        message,
        ...(messageId ? { message_id: messageId } : {}),
      });
    } catch (err) {
      // The box did not accept the turn. Restore the hosting run exactly; a
      // terminal state that raced here remains sticky in setStatus().
      await capabilityRunManager.setStatus(runId, previousStatus);
      throw err;
    }
    // A box-level duplicate after runtime recovery has no future turn_done. Put
    // the hosting run back exactly where it was before this replay.
    if (accepted.duplicate) await capabilityRunManager.setStatus(runId, previousStatus);
    if (messageId) await capabilityRunManager.rememberMessageId(runId, messageId);
    return { ok: true, run_id: runId, duplicate: accepted.duplicate === true };
  });

  rpcMethods.set("capability.command", async (params) => {
    const req = params as unknown as CapabilityCommandRequest;
    const runId = req.run_id?.trim();
    const commandId = req.command_id?.trim();
    if (!runId) throw new Error("run_id is required");
    if (!commandId) throw new Error("command_id is required");
    if (commandId.length > 128) throw new Error("command_id must be at most 128 characters");
    if (!req.command || typeof req.command !== "object") throw new Error("command is required");
    if (!Number.isInteger(req.command.version) || req.command.version < 1) throw new Error("command.version is required");
    if (!req.command.action?.trim()) throw new Error("command.action is required");
    if (!req.command.operation_id?.trim()) throw new Error("command.operation_id is required");
    if (!Number.isInteger(req.command.generation) || req.command.generation < 1) {
      throw new Error("command.generation must be a positive integer");
    }
    if (req.command.parameters !== undefined && (typeof req.command.parameters !== "object" || req.command.parameters === null || Array.isArray(req.command.parameters))) {
      throw new Error("command.parameters must be an object");
    }

    const digest = stablePayloadDigest(req.command);

    const rec = capabilityRunManager.get(runId) ?? (await capabilityRunManager.adopt(runId));
    if (!rec || isTerminalCapabilityStatus(rec.status)) throw new Error(`unknown capability run: ${runId}`);
    const durableReceipt = capabilityRunManager.commandReceipt(runId, commandId);
    if (durableReceipt) {
      if (durableReceipt.digest !== digest) {
        throw new RpcResponseError({
          code: ErrorCodes.CONFLICT,
          message: "command_id was already used with a different payload",
          retriable: false,
          status: 409,
        });
      }
      return { ok: true, run_id: runId, command_id: commandId, duplicate: true };
    }
    capabilityRunManager.touch(runId);
    const { client } = await ensureCapabilitySession(runId, rec.profile, rec.orgId || undefined, undefined);
    const previousStatus = rec.status;
    // Publish running BEFORE the box can emit turn_done. A fast command can
    // complete during postJson; no lifecycle write is allowed after a newly
    // accepted POST or it could overwrite that turn_done→idle transition.
    await capabilityRunManager.setStatus(runId, "running");
    let accepted: { duplicate?: boolean };
    try {
      accepted = await client.postJson<{ duplicate?: boolean }>(`/command/${runId}`, {
        command_id: commandId,
        command: req.command,
      });
    } catch (err) {
      await capabilityRunManager.setStatus(runId, previousStatus);
      throw err;
    }
    // A box-level duplicate after runtime recovery has no future turn_done. Put
    // the hosting run back exactly where it was before this replay.
    if (accepted.duplicate) await capabilityRunManager.setStatus(runId, previousStatus);
    await capabilityRunManager.rememberCommandReceipt(runId, commandId, digest);
    return { ok: true, run_id: runId, command_id: commandId, duplicate: accepted.duplicate === true };
  });

  rpcMethods.set("capability.cancel", async (params) => {
    const requestedRunId = (params as unknown as CapabilityCancelRequest).run_id;
    const runId = typeof requestedRunId === "string" ? requestedRunId.trim() : "";
    if (!runId) throw new Error("run_id is required");

    // Fence Runtime traffic before asking the box to stop. The consumer owns
    // domain rollback and must fence its writers before calling cancel; this
    // terminal mark additionally prevents a concurrent message/command from
    // entering while K8s processes the pod deletion.
    const rec = capabilityRunManager.get(runId) ??
      (await capabilityRunManager.adopt(runId, { notifyOnAdopt: false }));
    if (rec) await capabilityRunManager.endRun(runId, "done");

    // stop() is idempotent and treats an already-absent K8s pod as success. Any
    // other failure is uncertain cleanup and must reach the consumer; claiming
    // success here would let callers mistake a live box for a completed stop.
    try {
      // Target the run's own pod-name prefix — a compile box is "kbc-box-<id>",
      // not "agentbox-<id>". rec was just resolved above (get ?? adopt); an
      // absent profile falls back to the default prefix.
      await agentBoxManager.stop(runId, rec?.profile);
    } catch (err) {
      console.error(
        `[capability] cancel: stop box run=${runId} failed:`,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }
    const response: CapabilityCancelResponse = {
      ok: true,
      run_id: runId,
      stop_confirmed: true,
    };
    return response;
  });

  // ── Read-only test sessions (start-a-test-session) — reuse the run's live box ──
  // A test session probes the run's CURRENT draft exactly like a real consumer:
  // the box pins candidate/ into an immutable snapshot and hosts an ephemeral
  // session over it with the kb-test tool whitelist. Two invariants:
  //   - REUSE, never respawn: kb-test contributes ONLY its allowedTools list;
  //     the box stays the run's own (getOrCreate with profile "kb-test" would
  //     profile-mismatch-respawn the LIVE authoring box — destructive).
  //   - STATELESS: the relay never persists — test chatter must not pollute the
  //     authoring history (driveTestSession forwards live frames only).
  rpcMethods.set("capability.testStart", async (params) => {
    const req = params as unknown as CapabilityTestStartRequest;
    const runId = req.run_id;
    if (!runId) throw new Error("run_id is required");
    const rec = capabilityRunManager.get(runId) ?? (await capabilityRunManager.adopt(runId));
    if (!rec || isTerminalCapabilityStatus(rec.status)) throw new Error(`unknown capability run: ${runId}`);
    capabilityRunManager.touch(runId);
    // Ensure the authoring session is live. Cold box: this respawns + rehydrates
    // the durable workspace (materializeCapabilityInputs), so there is a
    // candidate/ draft to pin even after a reap/restart.
    const { client } = await ensureCapabilitySession(runId, rec.profile, rec.orgId || undefined, undefined);
    const allowedTools = getBoxProfile("kb-test").allowedTools ?? null;
    const opened = (await client.postJson(`/test-session/${runId}`, {
      allowed_tools: allowedTools,
      // Optional consumer-provided snapshot (e.g. a published version bundle);
      // absent → the box pins the run's candidate/ draft.
      ...(req.bundle_base64 ? { bundle_base64: req.bundle_base64, bundle_sha256: req.bundle_sha256 } : {}),
      // Idempotency: a retried testStart (same client_request_id) returns the
      // SAME live session instead of opening a second one — passed to the box.
      ...(req.client_request_id ? { client_request_id: req.client_request_id } : {}),
    })) as {
      test_session_id: string;
      snapshot_hash: string;
      consumer_fingerprint: string;
      pages: number;
      idempotent_replay?: boolean;
    };
    // Only drive a freshly-opened session — an idempotent replay is already
    // relayed, and the box's /test-events is single-consumer (see predicate).
    if (shouldRelayTestSession(opened)) {
      driveTestSession({
        client,
        runId,
        testSessionId: opened.test_session_id,
        frontendClient,
        touch: () => capabilityRunManager.touch(runId),
      }).catch((err) => {
        // A dead test relay is disposable — log, never fail the authoring run.
        console.warn(
          `[capability] test relay ended run=${runId} tid=${opened.test_session_id}:`,
          err instanceof Error ? err.message : String(err),
        );
      });
    }
    const res: CapabilityTestStartResponse = {
      run_id: runId,
      test_session_id: opened.test_session_id,
      snapshot_hash: opened.snapshot_hash,
      consumer_fingerprint: opened.consumer_fingerprint,
      pages: opened.pages,
    };
    return res;
  });

  rpcMethods.set("capability.testMessage", async (params) => {
    const req = params as unknown as CapabilityTestMessageRequest;
    if (!req.run_id) throw new Error("run_id is required");
    if (!req.test_session_id) throw new Error("test_session_id is required");
    if (!req.message) throw new Error("message is required");
    const rec = capabilityRunManager.get(req.run_id);
    if (!rec || isTerminalCapabilityStatus(rec.status)) throw new Error(`unknown capability run: ${req.run_id}`);
    capabilityRunManager.touch(req.run_id);
    const { client } = await ensureCapabilitySession(req.run_id, rec.profile, rec.orgId || undefined, undefined);
    // If the box died since testStart, the respawned box won't know this tid →
    // the box's 404 surfaces as an error and the consumer starts a fresh test
    // session (test sessions are disposable; there is nothing to resume).
    await client.postJson(`/test-message/${req.test_session_id}`, { message: req.message });
    return { ok: true, run_id: req.run_id, test_session_id: req.test_session_id };
  });

  rpcMethods.set("capability.testRecommend", async (params) => {
    const req = params as unknown as CapabilityTestRecommendRequest;
    if (!req.run_id) throw new Error("run_id is required");
    const rec = capabilityRunManager.get(req.run_id) ?? (await capabilityRunManager.adopt(req.run_id));
    if (!rec || isTerminalCapabilityStatus(rec.status)) throw new Error(`unknown capability run: ${req.run_id}`);
    capabilityRunManager.touch(req.run_id);
    const { client } = await ensureCapabilitySession(req.run_id, rec.profile, rec.orgId || undefined, undefined);
    const recommended = await client.postJson<{
      question: string;
      reference_answer: string;
      evidence_paths: string[];
    }>(`/test-recommendation/${req.run_id}`, {}, 210_000);
    const response: CapabilityTestRecommendResponse = {
      run_id: req.run_id,
      question: recommended.question,
      reference_answer: recommended.reference_answer,
      evidence_paths: recommended.evidence_paths,
    };
    return response;
  });

  rpcMethods.set("capability.testReferenceAssist", async (params) => {
    const req = params as unknown as CapabilityTestReferenceAssistRequest;
    if (!req.run_id) throw new Error("run_id is required");
    if (req.mode !== "suggest" && req.mode !== "polish") throw new Error("mode must be suggest or polish");
    if (!req.question?.trim()) throw new Error("question is required");
    if (req.mode === "polish" && !req.draft_answer?.trim()) throw new Error("draft_answer is required for polish");
    const rec = capabilityRunManager.get(req.run_id) ?? (await capabilityRunManager.adopt(req.run_id));
    if (!rec || isTerminalCapabilityStatus(rec.status)) throw new Error(`unknown capability run: ${req.run_id}`);
    capabilityRunManager.touch(req.run_id);
    const { client } = await ensureCapabilitySession(req.run_id, rec.profile, rec.orgId || undefined, undefined);
    const assisted = await client.postJson<
      | {
          ok: true;
          mode: "suggest";
          candidates: Extract<CapabilityTestReferenceAssistResponse, { mode: "suggest" }>["candidates"];
        }
      | {
          ok: true;
          mode: "polish";
          polished_answer: string;
          evidence_paths: string[];
          warnings: string[];
        }
    >(
      `/test-reference-assist/${req.run_id}`,
      {
        mode: req.mode,
        question: req.question,
        ...(req.draft_answer ? { draft_answer: req.draft_answer } : {}),
        ...(req.evidence_paths?.length ? { evidence_paths: req.evidence_paths } : {}),
      },
      615_000,
    );
    if (assisted.mode === "suggest") {
      const response: CapabilityTestReferenceAssistResponse = {
        run_id: req.run_id,
        mode: "suggest",
        candidates: assisted.candidates,
      };
      return response;
    }
    if (assisted.mode === "polish") {
      const response: CapabilityTestReferenceAssistResponse = {
        run_id: req.run_id,
        mode: "polish",
        polished_answer: assisted.polished_answer,
        evidence_paths: assisted.evidence_paths,
        warnings: assisted.warnings,
      };
      return response;
    }
    throw new Error("reference assistant returned an unexpected mode");
  });

  rpcMethods.set("capability.testClose", async (params) => {
    const req = params as unknown as CapabilityTestCloseRequest;
    if (!req.run_id) throw new Error("run_id is required");
    if (!req.test_session_id) throw new Error("test_session_id is required");
    // Closing a test session is a fencing operation, not ordinary best-effort
    // cleanup.  The in-memory capability run may have been lost across a
    // Runtime restart while its box pod is still alive, so absence from the run
    // manager is NOT proof that the session is gone.  Inspect the box directly
    // and never spawn/rehydrate one merely to close it.
    let client: AgentBoxClient;
    if (localCapabilityBoxEndpoint) {
      client = new AgentBoxClient(localCapabilityBoxEndpoint, 30000, agentBoxTlsOptions);
    } else {
      // getAsync computes the pod name from the run's PROFILE prefix (a compile
      // box is "kbc-box-<id>", a chat box "agentbox-<id>"), so it must be told
      // the profile or it looks up the wrong pod and reports a live session as
      // already-closed. The in-memory run may be gone after a Runtime restart —
      // recover its profile from the consumer store WITHOUT reattaching a relay
      // (notifyOnAdopt:false) or spawning a box. Unknown profile ⇒ default prefix.
      const rec =
        capabilityRunManager.get(req.run_id) ??
        (await capabilityRunManager.adopt(req.run_id, { notifyOnAdopt: false }));
      const alive = await agentBoxManager.getAsync(req.run_id, rec?.profile);
      if (!alive) {
        const response: CapabilityTestCloseResponse = {
          ok: true,
          run_id: req.run_id,
          test_session_id: req.test_session_id,
          already_closed: true,
          close_confirmed: true,
        };
        return response;
      }
      client = new AgentBoxClient(alive.endpoint, 30000, agentBoxTlsOptions);
    }
    await client.postJson(`/test-session/${req.test_session_id}/close`, {});
    const response: CapabilityTestCloseResponse = {
      ok: true,
      run_id: req.run_id,
      test_session_id: req.test_session_id,
      close_confirmed: true,
    };
    return response;
  });

  rpcMethods.set("capability.testSessions", async (params) => {
    const req = params as unknown as CapabilityTestSessionsRequest;
    if (!req.run_id) throw new Error("run_id is required");
    // Read-only reconciliation: NEVER spawn/rehydrate a box just to list (mirrors
    // testClose's box discovery). An absent/dead box has no live sessions → [].
    // The box's GET /test-sessions rows are passed through verbatim (the `tid`
    // wire field is load-bearing for the consumer — do not rename).
    let client: AgentBoxClient;
    if (localCapabilityBoxEndpoint) {
      client = new AgentBoxClient(localCapabilityBoxEndpoint, 30000, agentBoxTlsOptions);
    } else {
      // Same profile-aware discovery as testClose: getAsync needs the run's
      // profile to build the right pod-name prefix (kbc-box-<id> for a compile
      // box). Recover it from the store when memory-cold — never spawning a box
      // or reattaching a relay (notifyOnAdopt:false). Unknown profile ⇒ default.
      const rec =
        capabilityRunManager.get(req.run_id) ??
        (await capabilityRunManager.adopt(req.run_id, { notifyOnAdopt: false }));
      const alive = await agentBoxManager.getAsync(req.run_id, rec?.profile);
      if (!alive) {
        const empty: CapabilityTestSessionsResponse = { run_id: req.run_id, sessions: [] };
        return empty;
      }
      client = new AgentBoxClient(alive.endpoint, 30000, agentBoxTlsOptions);
    }
    const listed = await client.getJson<{ sessions: CapabilityTestSessionSummary[] }>("/test-sessions");
    // Scope to THIS run: a SHARED box (SICLAW_COMPILE_BOX_ENDPOINT) hosts test
    // sessions for multiple parent runs, and one run must never see (or reap)
    // another's. Double protection with the consumer's own ParentRunID check.
    const response: CapabilityTestSessionsResponse = {
      run_id: req.run_id,
      sessions: (listed.sessions ?? []).filter((s) => s.parent_run_id === req.run_id),
    };
    return response;
  });

  /**
   * The box running this session's turn, for operations that reach into that turn.
   *
   * steer, abort and clearQueue all act on a turn that is ALREADY running, so they have to
   * land on the box running it. Resolving them through placement was correct only while a
   * session belonged to one box for its lifetime: with free placement the same lookup can
   * return a different box of the same agent, which has never heard of the session and
   * answers 404 — the user sees a failure they did not cause, and a frontend that resends
   * the text as a new prompt gets the message answered twice.
   *
   * Three sources, most exact first. The turn lock knows where THIS Runtime dispatched the
   * turn. The holder lookup asks the boxes, covering a turn this Runtime has forgotten
   * across a restart. Placement is the last resort — no evidence anywhere is not a reason
   * to do nothing, because the turn may still be running somewhere.
   */
  async function boxForRunningTurn(agentId: string, sessionId: string): Promise<AgentBoxClient> {
    const endpoint = sessionTurnLocks.busyOn(sessionId)?.endpoint
      ?? (await agentBoxManager.getHolder?.(agentId, sessionId).catch(() => undefined))?.endpoint
      ?? (await agentBoxManager.getOrCreate(agentId, undefined, sessionId)).endpoint;
    return new AgentBoxClient(endpoint, 10000, agentBoxTlsOptions);
  }

  /** A box that has not created the session yet answers exactly like one that never will. */
  function isSessionNotFound(err: unknown): boolean {
    return /session not found/i.test(String((err as Error)?.message ?? err));
  }

  rpcMethods.set("chat.abort", async (params) => {
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    if (!agentId || !sessionId) throw new Error("agentId, sessionId required");
    // Optional: a control-plane abort that supervises one specific turn names it, so
    // an abort delayed past that turn's end — a lease expiry, a retry — cannot stop
    // whatever is running now. The user's Stop button sends none, and means "current".
    const requestedTurnId = typeof params.turnId === "string" ? params.turnId : undefined;
    // SNAPSHOT, not a live view: breaking the consumer below lets a turn settle and
    // remove itself from this set, so reading it afterwards would miss the very turn
    // the Stop was for.
    const liveTurns = [...(liveTurnIds.get(sessionId) ?? [])];
    if (requestedTurnId && liveTurns.length > 0 && !liveTurns.includes(requestedTurnId)) {
      console.log(`[runtime] abort for turn=${requestedTurnId} session=${sessionId} is stale (live: ${liveTurns.join(", ")}); ignoring`);
      return { ok: true, stale: true };
    }

    // Break the gateway's SSE consumer FIRST, then stop the agentbox. Aborting the
    // signal before abortSession ensures it is set before the agentbox's final
    // agent_end/prompt_done events (or the natural stream close they cause) reach
    // the consumer — so consumeAgentSse runs its abort-finalization (in-flight tool
    // rows → "stopped", partial assistant text persisted) instead of exiting as a
    // normal completion that leaves the tool row stuck "running" → "resumes on refresh".
    // A Stop that names no turn means "whatever is running", and more than one turn
    // can be live — one on the box, one queued behind the session lock. Both are
    // named below; the box stops the one it is running and answers the rest as
    // already stopped.
    const targets = requestedTurnId ? [requestedTurnId] : liveTurns;

    // Break the gateway's SSE consumer FIRST, then stop the agentbox. Aborting the
    // signal before abortSession ensures it is set before the agentbox's final
    // agent_end/prompt_done events (or the natural stream close they cause) reach
    // the consumer — so consumeAgentSse runs its abort-finalization (in-flight tool
    // rows → "stopped", partial assistant text persisted) instead of exiting as a
    // normal completion that leaves the tool row stuck "running" → "resumes on refresh".
    //
    // Cancel exactly the turns being stopped, and do it BEFORE the awaited box
    // lookup: deciding session-wide-versus-per-turn on state read after an await
    // would let a turn settle in between, drop us into the session-wide branch, and
    // break the consumer of a SUCCESSOR that started meanwhile. The snapshot above
    // decides it instead.
    if (liveTurns.length > 0) {
      for (const id of targets) turnAborts.get(id)?.abort();
    } else {
      // Nothing of ours is registered for this session — a turn from before a
      // restart, or a caller naming one we never saw. Fall back to the session's own
      // controllers, which is all the evidence there is.
      for (const ctrl of pendingStartAborts.get(sessionId) ?? []) ctrl.abort();
      activeStreamAborts.get(sessionId)?.abort();
    }

    // A cold-start Stop used to be skipped here to avoid arming a session-wide
    // pre-spawn latch that the user's retry would then consume; a turn-scoped latch
    // is only ever consumed by the prompt for that same turn — precisely the prompt
    // being cancelled — so there is nothing left to avoid.
    const client = await boxForRunningTurn(agentId, sessionId);
    // Stopping a session a box does not have is already the outcome the user asked for;
    // reporting it as a failed Stop would be a lie.
    const stopOne = (id?: string) => client.abortSession(sessionId, id).catch((err) => {
      if (!isSessionNotFound(err)) throw err;
      console.log(`[runtime] abort: session=${sessionId} not on the box we asked; treating as already stopped`);
    });
    if (targets.length === 0) {
      // Nothing in flight here: the box may still hold a turn from before a restart.
      await stopOne(undefined);
    } else {
      for (const id of targets) await stopOne(id);
    }
    return { ok: true };
  });

  rpcMethods.set("chat.steer", async (params) => {
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    const text = params.text as string;
    const images = params.images as PromptOptions["images"];
    const files = params.files as PromptOptions["files"];
    if (!agentId || !sessionId || !text) throw new Error("agentId, sessionId, text required");

    // Persist the steer as a user message BEFORE injecting it, mirroring
    // chat.send (L198). Without this the steer only rides the running prompt's
    // SSE stream and is rendered optimistically by the frontend, but never lands
    // in chat_messages — so it vanishes on the next history reload. metadata.kind
    // = "steer" lets the frontend render it as a steer bubble, not a plain user
    // message. No ensureChatSession: a steer always targets an already-running
    // session, so the row exists and we must not clobber its title/preview.
    const steerMessageId = await appendMessage({ sessionId, role: "user", content: text, metadata: { kind: "steer" }, deferSequence: true });
    await incrementMessageCount(sessionId);

    // The prompt returns as soon as the turn STARTS, so a steer can arrive while the box is
    // still creating the session — it answers 404 for a moment before it would accept. Retry
    // briefly rather than reporting a failure the user would have to resend around.
    // A steer sent seconds into a turn still races the box: /api/prompt is dispatched
    // before the box has created the session, so the first steers of a conversation used
    // to spend their whole retry budget being told "Session not found". Wait for the box
    // to say it took the prompt; the retry below stays as a backstop for the cases this
    // Runtime cannot see (a turn it did not start, or one that started before a restart).
    await sessionTurnLocks.whenPromptAccepted(sessionId, STEER_PROMPT_WAIT_MS);
    const deadline = Date.now() + STEER_SESSION_WAIT_MS;
    let steerResult: Awaited<ReturnType<AgentBoxClient["steerSession"]>> | undefined;
    for (;;) {
      const client = await boxForRunningTurn(agentId, sessionId);
      try {
        steerResult = await client.steerSession(sessionId, text, { images, files });
        break;
      } catch (err) {
        if (!isSessionNotFound(err) || Date.now() >= deadline) throw err;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    // Accepted by the box: this row is now in line to be processed, and is ordered when
    // the box says it started (see pending-user-rows.ts). A steer that never got that far
    // is deliberately NOT queued — it would take the place of the next message instead.
    pendingUserRows.push(sessionId, steerMessageId, text);
    void bindMessageTraceId(steerMessageId, sessionId, steerResult.traceId).catch((bindErr) => {
      warnTraceBindFailure("explicit steer", sessionId, steerMessageId, bindErr);
    });
    // The row id, so a caller can reconcile its optimistic bubble by identity instead of
    // by content — two steers with the same text are two messages, not one.
    return { ok: true, messageId: steerMessageId };
  });

  rpcMethods.set("chat.clearQueue", async (params) => {
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    if (!agentId || !sessionId) throw new Error("agentId, sessionId required");

    const client = await boxForRunningTurn(agentId, sessionId);
    const cleared = await client.clearQueue(sessionId);
    return { ok: true, ...cleared };
  });

  // chat.sessionStatus — explicit liveness of a session's in-progress turn, for the Portal
  // reconnect-after-refresh flow. Uses getAsync (NON-spawning): checking liveness must never
  // boot an AgentBox — no box means nothing is running. Any failure is fail-safe "not running"
  // so a transient hiccup makes the page show static history rather than a stuck spinner.
  rpcMethods.set("chat.sessionStatus", async (params) => {
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    if (!agentId || !sessionId) throw new Error("agentId, sessionId required");

    // Session-aware: an agent may run several boxes, and this session lives on exactly
    // one of them. Deriving the instance-0 pod name would report a session pinned to
    // instance 1 as not running — losing stream reattachment on refresh, and making a
    // live A2A task look orphaned after a Portal restart.
    const handle = await (agentBoxManager.getForSession?.(agentId, sessionId) ?? agentBoxManager.getAsync(agentId));
    if (!handle) return { ok: true, running: false };
    try {
      const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
      const { running } = await client.sessionStatus(sessionId);
      return { ok: true, running: !!running };
    } catch (err: any) {
      console.warn(`[rpc] chat.sessionStatus: agent=${agentId} session=${sessionId} probe failed: ${err?.message ?? err}`);
      return { ok: true, running: false };
    }
  });

  rpcMethods.set("agent.clearMemory", async (params) => {
    const agentId = params.agentId as string;
    if (!agentId) throw new Error("agentId required");

    const { memoryDir, deletedFiles } = clearAgentMemory(agentId);

    console.log(`[rpc] agent.clearMemory: deleted ${deletedFiles} files in ${memoryDir}`);

    // Notify AgentBox to reset indexer
    try {
      const handle = await agentBoxManager.getAsync(agentId);
      if (handle) {
        const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
        await client.resetMemory();
        console.log("[rpc] agent.clearMemory: AgentBox notified to reset indexer");
      }
    } catch (err: any) {
      console.warn(`[rpc] agent.clearMemory: AgentBox notify failed: ${err.message}`);
    }

    return { ok: true, deletedFiles };
  });

  rpcMethods.set("agent.terminate", async (params) => {
    const agentId = params.agentId as string;
    if (!agentId) throw new Error("agentId required");

    const boxes = await agentBoxManager.list();
    const targets = boxes.filter((b) => b.agentId === agentId);

    // Stop all matching boxes in parallel; each error is contained so one
    // failure doesn't block the rest.
    const results = await Promise.all(
      targets.map(async (box) => {
        try {
          // The CONCRETE box, not the agent: stop(agentId) always derives the instance-0
          // pod name, so an N-box agent issued N deletes for instance 0, left 1..N-1
          // running, and still reported them stopped.
          await (agentBoxManager.stopBox?.(box.boxId) ?? agentBoxManager.stop(box.agentId));
          return { ok: true, boxId: box.boxId };
        } catch (err: any) {
          console.warn(`[rpc] agent.terminate: failed to stop ${box.boxId}: ${err.message}`);
          return { ok: false, boxId: box.boxId, error: err.message as string };
        }
      }),
    );

    const stopped = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);

    console.log(`[rpc] agent.terminate: stopped ${stopped}/${targets.length} boxes for agent=${agentId}`);
    return { ok: true, stopped, total: targets.length, failed };
  });

  rpcMethods.set("agent.reload", async (params) => {
    const agentId = params.agentId as string;
    if (!agentId) throw new Error("agentId required");

    // All types route through GATEWAY_SYNC_DESCRIPTORS — the legacy
    // "credentials" umbrella type is replaced by the more granular
    // "cluster" + "host" so CRUD events can notify only what changed.
    // Prompt invalidation is intentionally explicit. The resources endpoint
    // omits `resources` for its legacy all-bindings refresh; including prompt
    // here would rebuild every warm brain for unrelated binding changes.
    const resourceTypes = (params.resources as string[] | undefined) ?? ["skills", "mcp", "cluster", "host", "knowledge"];
    const wantsModel = resourceTypes.includes("model");
    const expectedReleaseId = params.releaseId as string | undefined;
    const expectedModelFingerprint = params.modelFingerprint as string | undefined;
    let preparedReleaseId = "";
    let preparedModelFingerprint = "";
    if (wantsModel) {
      const binding = await resolveAgentModelBinding(agentId, frontendClient);
      if (!binding) throw new Error(`model binding unavailable for agent ${agentId}`);
      preparedReleaseId = binding.releaseId ?? "";
      preparedModelFingerprint = binding.modelFingerprint ?? "";
      if (expectedReleaseId && preparedReleaseId !== expectedReleaseId) {
        throw new Error(`model binding release ${preparedReleaseId || "<empty>"} does not match expected ${expectedReleaseId}`);
      }
      if (expectedModelFingerprint && preparedModelFingerprint !== expectedModelFingerprint) {
        throw new Error(`model binding fingerprint ${preparedModelFingerprint || "<empty>"} does not match expected ${expectedModelFingerprint}`);
      }
    }

    const boxes = await agentBoxManager.list();
    // Only "running" boxes are reachable — Pending/Terminating/Succeeded/Failed
    // pods either have no podIP yet or a stale one, and RPCs to them would
    // ETIMEDOUT and slow the whole fan-out. See bug report
    // "siclaw-agent-reload-stale-pods-and-serial-blocking".
    const targets = boxes.filter((b) => b.agentId === agentId && b.status === "running");

    if (targets.length === 0) {
      console.log(`[rpc] agent.reload: no active boxes for agent=${agentId}, skipping`);
      return {
        ok: true, reloaded: [], skipped: resourceTypes, boxes: 0,
        preparedReleaseId, preparedModelFingerprint,
      };
    }

    // Fan out across boxes AND resource types concurrently so one slow box
    // (network hiccup, etc.) cannot serially block the reload on others.
    const reloadedSet = new Set<string>();
    const failedSet = new Set<string>();

    await Promise.all(
      targets.map(async (box) => {
        const client = new AgentBoxClient(box.endpoint, 15_000, agentBoxTlsOptions);
        await Promise.all(
          resourceTypes.map(async (rt) => {
            try {
              await client.reloadResource(rt as import("../shared/gateway-sync.js").GatewaySyncType);
              reloadedSet.add(rt);
            } catch (err: any) {
              console.warn(`[rpc] agent.reload: ${rt} failed for box=${box.boxId}: ${err.message}`);
              failedSet.add(rt);
            }
          }),
        );
      }),
    );

    const reloaded = Array.from(reloadedSet);
    const failed = Array.from(failedSet);
    console.log(`[rpc] agent.reload: agent=${agentId} boxes=${targets.length} reloaded=[${reloaded}] failed=[${failed}]`);
    return {
      ok: true, reloaded, failed, boxes: targets.length,
      preparedReleaseId, preparedModelFingerprint,
    };
  });

  // agent.syncStatus — read the box's observed inventory. Reload ACK only
  // proves the RPC ran; this is what actually landed on disk.
  rpcMethods.set("agent.syncStatus", async (params) => {
    const agentId = params.agentId as string;
    if (!agentId) throw new Error("agentId required");

    const boxes = await agentBoxManager.list();
    const agentBoxes = boxes.filter((b) => b.agentId === agentId);
    const targets = agentBoxes.filter((b) => b.status === "running");
    if (targets.length === 0) {
      return {
        schemaVersion: AGENT_SYNC_STATUS_SCHEMA_VERSION,
        ok: true,
        available: false,
        reason: "no_running_box",
        boxes: agentBoxes.length,
        runningBoxes: 0,
        observedBoxes: 0,
        consistent: false,
        observations: [] as BoxSyncObservation[],
      };
    }

    // Observe every running replica concurrently. Returning the first reachable
    // box made a partially updated deployment look healthy whenever that box
    // happened to be queried first.
    const observations: BoxSyncObservation[] = await Promise.all(targets.map(async (box) => {
      try {
        const client = new AgentBoxClient(box.endpoint, 8_000, agentBoxTlsOptions);
        const status = normalizeBoxSyncStatus(await client.getJson<unknown>("/api/sync-status"));
        return { boxId: box.boxId, available: true, status };
      } catch (err: any) {
        const message = String(err?.message ?? err);
        const reason = /\b404\b/.test(message) || /not found/i.test(message)
          ? "unsupported"
          : "query_failed";
        console.warn(`[rpc] agent.syncStatus: box=${box.boxId} failed: ${reason}`);
        // Do not return the transport error: endpoints and headers can contain
        // credentials. The per-box reason is enough for the control plane.
        return { boxId: box.boxId, available: false, reason };
      }
    }));

    const observed = observations.filter(
      (item): item is Extract<BoxSyncObservation, { available: true }> => item.available,
    );
    if (observed.length === 0) {
      return {
        schemaVersion: AGENT_SYNC_STATUS_SCHEMA_VERSION,
        ok: true,
        available: false,
        reason: observations.some((item) => !item.available && item.reason === "unsupported")
          ? "unsupported"
          : "query_failed",
        boxes: agentBoxes.length,
        runningBoxes: targets.length,
        observedBoxes: 0,
        consistent: false,
        observations,
      };
    }

    // Timestamps are evidence freshness, not harness identity. Ignore them when
    // deciding whether replicas agree, while retaining content/version fields.
    const identity = (status: BoxSyncStatus): string => JSON.stringify({
      schemaVersion: status.schemaVersion ?? 0,
      knowledge: [...(status.knowledge?.repos ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
      skills: [...(status.skills?.names ?? [])].sort(),
      mcp: [...(status.mcp?.names ?? [])].sort(),
      harness: status.harness ? {
        agentType: status.harness.agentType,
        systemPromptTemplate: status.harness.systemPromptTemplate,
        skillNames: [...(status.harness.skillNames ?? [])].sort(),
        skillDigests: Object.fromEntries(Object.entries(status.harness.skillDigests ?? {}).sort(([a], [b]) => a.localeCompare(b))),
        toolNames: [...(status.harness.toolNames ?? [])].sort(),
      } : null,
      model: status.model ? {
        releaseId: status.model.releaseId,
        modelFingerprint: status.model.modelFingerprint,
      } : null,
      // Sub-agent tiering is part of what a replica IS, so it belongs here for the
      // same reason `model` does. Without it two boxes serving different tier state
      // — one that lost its menu, one that never received candidates — produced an
      // identical identity and the aggregate reported `consistent: true`, which is
      // the exact silent divergence the observation was added to expose. Reporting
      // per box while the consensus ignores it is worse than not reporting: a
      // publisher gating on `consistent` reads a green light.
      //
      // `observedAt` is deliberately excluded, like harness/model above: a timestamp
      // is evidence freshness, not identity.
      //
      // A differing revision therefore makes replicas inconsistent, and that is the
      // intent — same semantics as a differing `releaseId`. Two boxes whose last
      // turns straddled a config change have not converged yet, and "not converged"
      // must read as pending rather than verified.
      //
      // `null` (no turn observed yet) stays distinct from `{both null}` (a turn ran,
      // carrying no tiers). Collapsing them would let a box that has never run pass
      // as agreeing with one that ran without tiers.
      tiers: status.tiers ? {
        menuRevision: status.tiers.menuRevision,
        candidatesRevision: status.tiers.candidatesRevision,
      } : null,
    });
    const first = observed[0].status;
    const firstIdentity = identity(first);
    const consistent = observed.length === targets.length &&
      observed.every((item) => identity(item.status) === firstIdentity);

    return {
      schemaVersion: AGENT_SYNC_STATUS_SCHEMA_VERSION,
      ok: true,
      available: true,
      boxes: agentBoxes.length,
      runningBoxes: targets.length,
      observedBoxes: observed.length,
      consistent,
      observations,
      // Keep the legacy aggregate while old Sicore versions roll forward. A
      // model is proof only when every running box agrees; otherwise null keeps
      // the old verifier in sync_pending rather than producing a false success.
      knowledge: first.knowledge ?? { syncedAt: null, repos: [] },
      skills: first.skills ?? { names: [] },
      mcp: first.mcp ?? { names: [] },
      harness: consistent ? (first.harness ?? null) : null,
      model: consistent ? (first.model ?? null) : null,
      // Same gate as the two above: a tier observation is proof only when every
      // running box agrees. A consumer that reads this flat aggregate instead of
      // walking `observations` would otherwise have no way to see tier state at all.
      tiers: consistent ? (first.tiers ?? null) : null,
    };
  });

  // agent.promptInspection — explicit sensitive audit of one resident session.
  // The exact prompt is never included in routine sync status or logs. Portal
  // exposes this RPC only through its admin-only, session-addressed endpoint.
  rpcMethods.set("agent.promptInspection", async (params) => {
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    if (!agentId) throw new Error("agentId required");
    if (!sessionId) throw new Error("sessionId required");

    const boxes = await agentBoxManager.list();
    const targets = boxes.filter((box) =>
      box.agentId === agentId && box.status === "running" && Boolean(box.endpoint));
    if (targets.length === 0) {
      return { ok: true, available: false, reason: "no_running_box" };
    }

    const observations = await Promise.all(targets.map(async (box) => {
      try {
        const client = new AgentBoxClient(box.endpoint, 8_000, agentBoxTlsOptions);
        const inspection = await client.getJson<any>(
          `/api/sessions/${encodeURIComponent(sessionId)}/prompt-inspection`,
        );
        return { boxId: box.boxId, available: true as const, inspection };
      } catch (err: any) {
        const status = Number(err?.status ?? err?.metadata?.status ?? err?.statusCode ?? 0);
        return {
          boxId: box.boxId,
          available: false as const,
          reason: status === 404 ? "session_not_resident" : "query_failed",
        };
      }
    }));
    const found = observations.filter((item) => item.available);
    if (found.length === 0) {
      return {
        ok: true,
        available: false,
        reason: observations.some((item) => item.reason === "query_failed")
          ? "query_failed"
          : "session_not_resident",
        observations,
      };
    }

    const first = found[0].inspection;
    const promptHash = first?.prompt?.sha256;
    const consistent = found.every((item) => item.inspection?.prompt?.sha256 === promptHash);
    return {
      ok: true,
      available: true,
      consistent,
      inspection: first,
      observations: observations.map((item) => item.available
        ? {
            boxId: item.boxId,
            available: true,
            promptSha256: item.inspection?.prompt?.sha256 ?? null,
            stage: item.inspection?.stage ?? null,
          }
        : item),
    };
  });

  // tracing.reloadAll — GLOBAL tracing hot-reload. Unlike agent.reload, tracing
  // is a single fan-out set shared by every agent, so this enumerates ALL
  // running boxes (no agentId filter) and POSTs /api/reload-tracing to each.
  // Uses the generic AgentBoxClient.post (NOT reloadResource) because tracing
  // config never lands on disk — see DESIGN module 3. Each box is contained in
  // its own try/catch so one unreachable/slow box cannot block the rest.
  rpcMethods.set("tracing.reloadAll", async () => {
    const boxes = await agentBoxManager.list();
    // Only "running" boxes are reachable; Pending/Terminating pods have no/stale
    // podIP and would ETIMEDOUT (same rationale as agent.reload).
    const targets = boxes.filter((b) => b.status === "running");

    if (targets.length === 0) {
      console.log("[rpc] tracing.reloadAll: no running boxes, skipping");
      return { ok: true, reloaded: 0, failed: [], boxes: 0 };
    }

    const failed: string[] = [];
    await Promise.all(
      targets.map(async (box) => {
        try {
          const client = new AgentBoxClient(box.endpoint, 15_000, agentBoxTlsOptions);
          await client.post("/api/reload-tracing");
        } catch (err: any) {
          console.warn(`[rpc] tracing.reloadAll: box=${box.boxId} failed: ${err.message}`);
          failed.push(box.boxId);
        }
      }),
    );

    const reloaded = targets.length - failed.length;
    console.log(`[rpc] tracing.reloadAll: boxes=${targets.length} reloaded=${reloaded} failed=[${failed}]`);
    return { ok: true, reloaded, failed, boxes: targets.length };
  });

  // Reliable cross-Runtime delegation controls arrive as RPCs instead of the
  // best-effort event lane. Acknowledge only after the matching source handler
  // has consumed the envelope; the control plane retains and retries it otherwise.
  rpcMethods.set("delegation.control", async (params) => {
    if (frontendClient.dispatchReliableEvent("delegation.event", params)) return { ok: true };
    // No live consumer is not automatically a delivery failure. A terminal whose
    // acknowledgement was lost gets re-sent, and by then its consumer is gone
    // *because it consumed the original*. Rejecting that would retry forever,
    // which keeps the sender's relay alive; a relay that later expires aborts by
    // (agent, session) and would kill a NEW turn reusing that peer session.
    const delegationId = typeof params?.delegationId === "string" ? params.delegationId : "";
    // A terminal that outlived its consumer (Stop, idle-timeout — or a source
    // restart that emptied the settled set) still carries the leg's trace id —
    // salvage the opening-row bind, or the interrupted legs a review drills into
    // stay unlinked. Fire-and-forget on BOTH branches: the ack (or the retry-driving
    // throw below) must not wait on a best-effort bind, and the salvage's own memo
    // keeps redelivery retries from repeating the history walk.
    if (delegationId) {
      void salvageDelegationTraceBind(params as Record<string, unknown>).catch((err) => {
        console.warn(`[runtime] settled-delegation trace salvage failed for ${delegationId}:`, err);
      });
    }
    if (delegationId && isDelegationSettled(delegationId)) {
      return { ok: true, alreadySettled: true };
    }
    throw new Error("No active delegation consumer accepted the control event");
  });

  // ── Phone-home: register inbound commands from Portal via FrontendWsClient ──
  // Portal sends commands (e.g. chat.send, agent.reload, task.fireNow) to
  // Runtime over the persistent WS connection. We route them through the
  // same rpcMethods map used by the WS server.
  frontendClient.onCommand(async (method, params) => {
    const handler = rpcMethods.get(method);
    if (!handler) throw new Error(`Unknown RPC method: ${method}`);
    // Build a context that emits events back to Portal via the WS connection.
    // chat.send uses context.sendEvent + context.ws to stream SSE events;
    // in phone-home mode we use frontendClient.emitEvent() instead of a WS ref.
    const context: RpcContext = {
      sendEvent: (event, payload) => {
        frontendClient.emitEvent(event, payload);
      },
    };
    return handler(params, context);
  });

  // ── MetricsAggregator (K8s only: Prometheus federation pull loop) ──
  const isK8sMode = !(spawner instanceof LocalSpawner);
  let metricsAggregator: MetricsAggregator | undefined;
  // K8s only: application-layer Prometheus federation. The gateway process emits no
  // business events in K8s mode (they fire inside agentbox pods), so its own
  // metricsRegistry is empty of them; federation provides those series instead.
  let promFederation: PromFederationAggregator | null = null;
  // The federation self-monitoring registry/counters (module 4), resolved once in
  // K8s mode and reused by the /metrics handler and the flush route — avoids a
  // per-request dynamic import whose rejection could escape a route handler.
  let federationSelfMetrics: typeof import("./federation-self-metrics.js") | null = null;
  if (isK8sMode) {
    promFederation = new PromFederationAggregator();
    federationSelfMetrics = await import("./federation-self-metrics.js");
    metricsAggregator = new MetricsAggregator(agentBoxManager, {
      async fetch(endpoint: string) {
        try {
          const client = new AgentBoxClient(endpoint, 3000, agentBoxTlsOptions);
          return await client.getJson("/api/internal/metrics-snapshot");
        } catch {
          return null;
        }
      },
    }, promFederation, federationSelfMetrics);
  }

  // ── Metrics config ───────────────────────────────────────
  const cachedMetricsToken = process.env.SICLAW_METRICS_TOKEN;

  // ── HTTP Server (Port 3001) ──────────────────────────────
  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    // CORS
    if (method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-Token, X-Agent-Id");
      res.writeHead(204);
      res.end();
      return;
    }

    res.setHeader("Access-Control-Allow-Origin", "*");

    // Health check
    if (url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // Prometheus metrics
    if (url === "/metrics" && method === "GET") {
      if (!checkMetricsAuth(req, res, cachedMetricsToken)) return;
      (async () => {
        try {
          const { metricsRegistry } = await import("../shared/metrics.js");
          capabilityActiveRuns.set(capabilityRunManager.activeCount());
          if (promFederation && federationSelfMetrics) {
            // K8s mode: business metrics come from federation. The gateway's own
            // metricsRegistry holds the same metric *names* with empty values, so we
            // must NOT emit it here (it would duplicate # TYPE lines). Instead we
            // append only the dedicated self-monitoring registry, whose metric names
            // (siclaw_federation_*) have zero overlap with the federated business
            // metrics — two non-overlapping exposition texts concatenate safely.
            const { federationSelfRegistry } = federationSelfMetrics;
            const federated = promFederation.metrics();
            const selfMon = await federationSelfRegistry.metrics();
            res.writeHead(200, { "Content-Type": federationSelfRegistry.contentType });
            res.end(selfMon ? `${federated}${selfMon}` : federated);
          } else {
            // Local mode: gateway emits business events in-process — serve them directly.
            res.writeHead(200, { "Content-Type": metricsRegistry.contentType });
            res.end(await metricsRegistry.metrics());
          }
        } catch (err) {
          console.error("[runtime] /metrics error:", err);
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      })();
      return;
    }

    // Everything else → 404
    // Siclaw CRUD routes live in Portal; Runtime only exposes health, WS,
    // and internal mTLS endpoints above.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  // Runtime no longer accepts inbound WS connections — Portal / the management server drive
  // RPCs over the phone-home WS owned by FrontendWsClient. The HTTP server
  // here serves only /api/health and the internal mTLS endpoints.
  httpServer.keepAliveTimeout = 500;
  httpServer.listen(config.port, config.host, () => {
    console.log(`[runtime] HTTP listening on http://${config.host}:${config.port}`);
  });

  // ── HTTPS Server (Port 3002 — mTLS for AgentBox) ────────
  const internalPort = config.internalPort;
  let httpsServer: https.Server | null = null;

  const mtlsMiddleware = createMtlsMiddleware({
    certManager,
    protectedPaths: ["/api/internal/"],
  });

  try {
    httpsServer = https.createServer(
      {
        cert: serverCert.cert,
        key: serverCert.key,
        ca: certManager.getCACertificate(),
        requestCert: true,
        rejectUnauthorized: true,
      },
      (req, res) => {
        const url = req.url ?? "/";
        const method = req.method ?? "GET";

        mtlsMiddleware(req, res, () => {
          const identity = (req as any).certIdentity as CertificateIdentity | undefined;

          // Credential request — resolve via CredentialService (local DB or external)
          if (url === "/api/internal/credential-request" && method === "POST") {
            if (!identity) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Client certificate required" }));
              return;
            }
            void handleCredentialRequest(req, res, identity, credentialService);
            return;
          }

          // Credential list — metadata for all clusters bound to this agent
          if (url === "/api/internal/credential-list" && method === "POST") {
            if (!identity) {
              res.writeHead(401, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Client certificate required" }));
              return;
            }
            void handleCredentialList(req, res, identity, credentialService);
            return;
          }

          // Settings (model providers + entries) — via RPC
          if (url === "/api/internal/settings" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleSettings(req, res, identity, frontendClient);
            return;
          }

          // Global tracing config (no agentId) — hot-reload source via RPC
          if (url === "/api/internal/tracing-config" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleTracingConfig(req, res, identity, frontendClient);
            return;
          }

          // MCP servers — filtered by agent binding (via RPC)
          if (url === "/api/internal/mcp-servers" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleMcpServers(req, res, identity, frontendClient);
            return;
          }

          // Tool capabilities — resolved allowedTools for the agent (via RPC)
          if (url === "/api/internal/tool-capabilities" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleToolCapabilities(req, res, identity, frontendClient);
            return;
          }

          // Skills bundle — filtered by agent binding (via RPC)
          if (url === "/api/internal/skills/bundle" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleSkillsBundle(req, res, identity, frontendClient);
            return;
          }

          // Knowledge bundle — filtered by agent binding (via RPC)
          if (url === "/api/internal/knowledge/bundle" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleKnowledgeBundle(req, res, identity, frontendClient);
            return;
          }

          // Delegation roster — peer agents this coordinator may delegate to (via RPC)
          if (url === "/api/internal/delegates" && method === "GET") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            void handleDelegates(req, res, identity, frontendClient);
            return;
          }

          // Agent-to-agent delegation — coordinator delegates a bounded read-only
          // task to a peer agent; gateway prompts the peer + returns its artifact.
          if (url === "/api/internal/authority/consume" && method === "POST") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            void (async () => {
              try {
                const raw = await new Promise<string>((resolve, reject) => {
                  let buf = "";
                  req.on("data", (c) => { buf += c; if (buf.length > 64 * 1024) reject(new Error("body too large")); });
                  req.on("end", () => resolve(buf));
                  req.on("error", reject);
                });
                const body = JSON.parse(raw || "{}") as { receipt?: string };
                if (!body?.receipt) {
                  res.writeHead(400, { "Content-Type": "application/json" });
                  res.end(JSON.stringify({ error: "receipt is required" }));
                  return;
                }
                // Atomic one-time consumption happens on the management plane;
                // the box's mTLS identity is recorded as the consumer.
                const result = await frontendClient.request("authority.consumeReceipt", {
                  receipt: body.receipt,
                  subject: `box/${identity.boxId ?? identity.agentId ?? "unknown"}`,
                }, 10_000);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result ?? { ok: true }));
              } catch (err) {
                res.writeHead(409, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
              }
            })();
            return;
          }

          if (url === "/api/internal/delegate" && method === "POST") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            void handleDelegate(req, res, identity, { agentBoxManager, agentBoxTlsOptions, frontendClient, shutdownGate });
            return;
          }

          // Agent tasks — CRUD scoped by mTLS identity.agentId (via RPC)
          if (url.startsWith("/api/internal/agent-tasks")) {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            const pathOnly = url.split("?")[0];
            const idMatch = pathOnly.match(/^\/api\/internal\/agent-tasks\/([^/]+)$/);
            if (pathOnly === "/api/internal/agent-tasks" && method === "GET") {
              handleAgentTasksList(req, res, identity, frontendClient);
              return;
            }
            if (pathOnly === "/api/internal/agent-tasks" && method === "POST") {
              handleAgentTasksCreate(req, res, identity, frontendClient);
              return;
            }
            if (idMatch && method === "PUT") {
              handleAgentTasksUpdate(req, res, identity, idMatch[1], frontendClient);
              return;
            }
            if (idMatch && method === "DELETE") {
              handleAgentTasksDelete(req, res, identity, idMatch[1], frontendClient);
              return;
            }
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          // Background delegation persistence/audit callback from AgentBox.
          if (url === "/api/internal/delegation-events" && method === "POST") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            handleDelegationEvents(req, res, identity, frontendClient);
            return;
          }

          // SIGTERM final-flush of an AgentBox's prom snapshot (K8s federation, module 5).
          if (url === "/api/internal/metrics-flush" && method === "POST") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            if (!promFederation || !federationSelfMetrics) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Federation not enabled" })); return; }
            // handleMetricsFlush has its own try/catch and always responds; selfMetrics
            // is the already-resolved module reference (no per-request import to escape).
            void handleMetricsFlush(req, res, identity, promFederation, federationSelfMetrics);
            return;
          }

          // Feedback endpoint
          if (url === "/api/internal/feedback" && method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }

          // Default 404
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        });
      },
    );

    // 🔴 A rejected client certificate is otherwise INVISIBLE ON BOTH SIDES. Node fails the
    // handshake inside `rejectUnauthorized` and closes the socket without ever reaching a
    // request handler, so nothing above logs it; the AgentBox, which has already sent its
    // request, sees only `socket hang up`. An expired AgentBox certificate presented
    // exactly that way for a whole release — every internal call failing with a message
    // that names neither certificates nor expiry. This one line is the difference between
    // reading the cause and inferring it.
    //
    // Rate-limited per (peer, code), because the condition it reports PERSISTS: a box whose
    // certificate expired keeps calling — every turn, several times — and each call fails
    // the handshake. Logging all of them would bury everything else in the runtime's output
    // for as long as nobody fixes it, which is exactly the window the line exists to serve.
    const tlsErrorLastLogged = new Map<string, number>();
    const TLS_ERROR_LOG_INTERVAL_MS = 60_000;
    httpsServer.on("tlsClientError", (err: Error & { code?: string }, socket: tls.TLSSocket) => {
      const peer = socket.remoteAddress ?? "unknown";
      const code = err.code ?? "unknown";
      const key = `${peer} ${code}`;
      const now = Date.now();
      const last = tlsErrorLastLogged.get(key);
      if (last !== undefined && now - last < TLS_ERROR_LOG_INTERVAL_MS) return;
      // Bounded: one entry per (peer, code) seen in the window, swept as it is consulted.
      if (tlsErrorLastLogged.size > 256) {
        for (const [k, at] of tlsErrorLastLogged) {
          if (now - at >= TLS_ERROR_LOG_INTERVAL_MS) tlsErrorLastLogged.delete(k);
        }
      }
      tlsErrorLastLogged.set(key, now);
      console.warn(`[runtime] mTLS handshake rejected from ${peer}: ${code} ${err.message}`);
    });

    httpsServer.listen(internalPort, config.host, () => {
      console.log(`[runtime] Internal mTLS API on https://${config.host}:${internalPort}`);
    });
  } catch (err) {
    console.error("[runtime] Failed to start HTTPS server:", err);
  }

  // ── Server handle ────────────────────────────────────────
  const runtimeServer: RuntimeServer = {
    httpServer,
    httpsServer,
    certManager,
    rpcMethods,
    agentBoxTlsOptions,
    credentialService,
    async close() {
      metricsAggregator?.destroy();
      unsubscribeCapabilityReconnect?.();
      // Before frontendClient.close(): the acknowledged terminal for a delegated turn
      // travels over that same connection.
      await endInFlightTurns();
      frontendClient.close();
      // Older embedded test/adapter managers may only implement cleanup(); the
      // concrete manager's shutdown() preserves K8s boxes across Runtime rolls.
      const manager = agentBoxManager as AgentBoxManager & { shutdown?: () => Promise<void> };
      if (typeof manager.shutdown === "function") await manager.shutdown();
      else await manager.cleanup();
      httpServer.close();
      httpsServer?.close();
    },
  };

  return runtimeServer;
}
