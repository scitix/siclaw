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
import type { RuntimeConfig } from "./config.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type PromptOptions } from "./agentbox/client.js";
import { getBoxProfile } from "./agentbox/box-profile.js";
import { buildSpawnEnv } from "./agentbox/spawn-env.js";
import { CapabilityRunManager } from "./capability/run-manager.js";
import { driveCapabilitySession } from "./capability/session-driver.js";
import { driveTestSession } from "./capability/test-relay.js";
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
import { handleDelegate, handleDelegates } from "./delegate-api.js";
// siclaw-api.ts routes moved to Portal — Runtime no longer registers CRUD routes.
import { appendMessage, bindMessageTraceId, incrementMessageCount, ensureChatSession } from "./chat-repo.js";
import { consumeAgentSse } from "./sse-consumer.js";
import { buildRedactionConfigForModelConfig } from "./output-redactor.js";
import { MetricsAggregator } from "./metrics-aggregator.js";
import { PromFederationAggregator } from "./prom-federation-aggregator.js";
import { LocalSpawner } from "./agentbox/local-spawner.js";
import { sessionRegistry } from "./session-registry.js";
import { resolveAgentModelBinding } from "./agent-model-binding.js";

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

  // Per-session AbortController for the in-flight chat.send SSE consumer, keyed
  // by sessionId. chat.abort looks this up to break the gateway's consumeAgentSse
  // loop so its abort-finalization runs (in-flight tool rows → "stopped", partial
  // text persisted). Without this the consumer ends only when the agentbox closes
  // the stream NATURALLY (signal never aborted), the finalization is skipped, and
  // the tool row stays persisted as "running" — so a page refresh re-paints the
  // turn as still reasoning. Registered in chat.send, cleared on its settle.
  const activeStreamAborts = new Map<string, AbortController>();

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
    // Portal stamps turnStartMs at POST receipt — closer to user click than
    // the runtime's loop start. Use it as the canonical turn anchor when
    // present; fall back gracefully so direct callers (tests, /run path)
    // still work without it.
    const turnStartMs = typeof params.turnStartMs === "number" ? params.turnStartMs : undefined;

    if (!agentId || !userId || !text) {
      throw new Error("agentId, userId, and text are required");
    }

    // Pre-generate a UUID so AgentBox doesn't fall back to the literal
    // "default" session id (LocalSpawner behaviour), which would merge
    // every caller's trace into one chat_sessions row.
    const sessionId = incomingSessionId ?? crypto.randomUUID();
    sessionRegistry.remember(sessionId, userId, agentId);

    const modelConfig = params.modelConfig as PromptOptions["modelConfig"];
    const modelRouting = params.modelRouting as PromptOptions["modelRouting"];
    const images = params.images as PromptOptions["images"];
    const files = params.files as PromptOptions["files"];
    const promptOpts: PromptOptions = {
      sessionId,
      userId,
      text,
      agentId,
      modelProvider: params.modelProvider as string | undefined,
      modelId: params.modelId as string | undefined,
      systemPromptTemplate: params.systemPrompt as string | undefined,
      mode: params.mode as string | undefined,
      origin: origin as PromptOptions["origin"],
      delegation,
      modelConfig,
      modelRouting,
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
    (async () => {
      try {
        // Persist user message + ensure session row before any agent events
        // could land. consumeAgentSse writes assistant/tool rows with FK
        // referencing chat_sessions, so the row has to exist first.
        await ensureChatSession(sessionId, agentId, userId, text, undefined, origin);
        const promptMessageId = await appendMessage({ sessionId, role: "user", content: text });
        await incrementMessageCount(sessionId);

        // Persistence is resolved by agentId in the manager's persistenceResolver
        // (registered in startRuntime), not from per-request params — so every
        // entry point lands the same mode for the same agent.
        const handle = await agentBoxManager.getOrCreate(agentId);
        const client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);

        let promptResult: Awaited<ReturnType<typeof client.prompt>>;
        try {
          promptResult = await client.prompt(promptOpts);
        } catch (err) {
          // Concurrent send: agentbox returns 409 "Session is already
          // running. Use the steer endpoint to add input to the active
          // prompt." when the user double-taps send before the previous
          // prompt's pi-agent retries settle. Per agentbox's own hint,
          // inject as steer — the message rides on the still-running
          // prompt's stream. Don't emit prompt_done here: the running
          // prompt will fire its own when it actually finishes, and an
          // extra one would close the frontend stream prematurely.
          if (err instanceof Error && err.message.includes("Session is already running")) {
            const steerResult = await client.steerSession(sessionId, text, { images, files });
            await bindMessageTraceId(promptMessageId, sessionId, steerResult.traceId).catch((bindErr) => {
              console.warn(`[runtime] failed to bind steer trace session=${sessionId} message=${promptMessageId}:`, bindErr);
            });
            return;
          }
          throw err;
        }

        await bindMessageTraceId(promptMessageId, promptResult.sessionId, promptResult.traceId).catch((bindErr) => {
          console.warn(`[runtime] failed to bind prompt trace session=${promptResult.sessionId} message=${promptMessageId}:`, bindErr);
        });

        const redactionConfig = buildRedactionConfigForModelConfig(modelConfig);
        const abortCtrl = new AbortController();
        // Register this turn's abort signal so chat.abort can break the consumer
        // (see activeStreamAborts declaration). Placed AFTER prompt() succeeds, on
        // the path that actually consumes: the concurrent-send "already running"
        // branch early-returns above (steer) before this line, so it never clobbers
        // the in-flight prompt's controller in the map. Keyed on the agentbox-echoed
        // promptResult.sessionId — the same id chat.abort looks up.
        activeStreamAborts.set(promptResult.sessionId, abortCtrl);

        try {
          await consumeAgentSse({
            client,
            sessionId: promptResult.sessionId,
            userId,
            traceId: promptResult.traceId,
            persistMessages: true,
            redactionConfig,
            signal: abortCtrl.signal,
            turnStartTime: turnStartMs,
            onEvent: (evt, _eventType, extras) => {
              context.sendEvent("chat.event", {
                sessionId: promptResult.sessionId,
                event: extras.dbMessageId ? { ...evt, dbMessageId: extras.dbMessageId } : evt,
              });
            },
          });
          context.sendEvent("chat.event", { sessionId: promptResult.sessionId, event: { type: "prompt_done" } });
        } catch (err) {
          if (!abortCtrl.signal.aborted) {
            console.error(`[runtime] SSE stream error for session=${promptResult.sessionId}:`, err);
            const detail = wrapError(err, {
              code: ErrorCodes.STREAM_INTERRUPTED,
              retriable: true,
            });
            context.sendEvent("chat.event", {
              sessionId: promptResult.sessionId,
              event: { type: "stream_error", error: detail },
            });
          }
          context.sendEvent("chat.event", { sessionId: promptResult.sessionId, event: { type: "prompt_done" } });
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
        console.error(`[runtime] chat.send background failure for session=${sessionId}:`, err);
        const detail = wrapError(err, {
          code: ErrorCodes.INTERNAL,
          retriable: true,
        });
        context.sendEvent("chat.event", {
          sessionId,
          event: { type: "stream_error", error: detail },
        });
        context.sendEvent("chat.event", { sessionId, event: { type: "prompt_done" } });
      }
    })();

    return { ok: true, sessionId };
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
      await agentBoxManager.stop(rec.runId).catch((err) => {
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
          const alive = await agentBoxManager.getAsync(rec.runId);
          if (!alive) return;
          await ensureCapabilitySession(rec.runId, rec.profile, rec.orgId || undefined, undefined);
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
  const ensureCapabilitySession = (runId: string, profile: string, orgId: string | undefined, instruction: string | undefined) => {
    // An empty profile would silently resolve to the all-tools default agent
    // profile (getBoxProfile("") → AGENT) — the wrong shape AND a trust
    // escalation. Runs minted via capability.start always carry one; refuse
    // anything else (e.g. a corrupt adopted row) instead of guessing.
    if (!profile) throw new Error(`capability run ${runId} has no profile`);
    let pending = capabilitySessions.get(runId);
    if (!pending) {
      pending = (async () => {
        const { client, created } = await capabilityBoxClient(runId, profile, orgId);
        let replayWorkspace = false;
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
          replayWorkspace = materialized.reattached === true;
          if (materialized.inputRevision) {
            await capabilityRunManager.setInputRevision(runId, materialized.inputRevision);
          }
          const allowedTools = getBoxProfile(profile).allowedTools ?? null;
          await client.postJson(`/session/${runId}`, {
            instruction: instruction ?? "",
            allowed_tools: allowedTools,
            locale: materialized.locale,
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
            void agentBoxManager.stop(runId).catch((stopErr) =>
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
            await capabilityRunManager.endRun(runId, "failed").catch(() => {});
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
            void agentBoxManager.stop(runId).catch((stopErr) =>
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
    const runId = runRef.startsWith("agentbox-") ? runRef.slice("agentbox-".length) : runRef;
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
      if (startedRunId) await capabilityRunManager.endRun(startedRunId, "failed");
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
      await agentBoxManager.stop(runId);
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
    })) as {
      test_session_id: string;
      snapshot_hash: string;
      consumer_fingerprint: string;
      pages: number;
    };
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
      const alive = await agentBoxManager.getAsync(req.run_id);
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

  rpcMethods.set("chat.abort", async (params) => {
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    if (!agentId || !sessionId) throw new Error("agentId, sessionId required");

    // Break the gateway's SSE consumer FIRST, then stop the agentbox. Aborting the
    // signal before abortSession ensures it is set before the agentbox's final
    // agent_end/prompt_done events (or the natural stream close they cause) reach
    // the consumer — so consumeAgentSse runs its abort-finalization (in-flight tool
    // rows → "stopped", partial assistant text persisted) instead of exiting as a
    // normal completion that leaves the tool row stuck "running" → "resumes on refresh".
    activeStreamAborts.get(sessionId)?.abort();

    const handle = await agentBoxManager.getOrCreate(agentId);
    const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
    await client.abortSession(sessionId);
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
    const steerMessageId = await appendMessage({ sessionId, role: "user", content: text, metadata: { kind: "steer" } });
    await incrementMessageCount(sessionId);

    const handle = await agentBoxManager.getOrCreate(agentId);
    const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
    const steerResult = await client.steerSession(sessionId, text, { images, files });
    await bindMessageTraceId(steerMessageId, sessionId, steerResult.traceId).catch((bindErr) => {
      console.warn(`[runtime] failed to bind explicit steer trace session=${sessionId} message=${steerMessageId}:`, bindErr);
    });
    return { ok: true };
  });

  rpcMethods.set("chat.clearQueue", async (params) => {
    const agentId = params.agentId as string;
    const sessionId = params.sessionId as string;
    if (!agentId || !sessionId) throw new Error("agentId, sessionId required");

    const handle = await agentBoxManager.getOrCreate(agentId);
    const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
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

    const handle = await agentBoxManager.getAsync(agentId);
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
          await agentBoxManager.stop(box.agentId);
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
    const resourceTypes = (params.resources as string[] | undefined) ?? ["skills", "mcp", "cluster", "host", "knowledge"];

    const boxes = await agentBoxManager.list();
    // Only "running" boxes are reachable — Pending/Terminating/Succeeded/Failed
    // pods either have no podIP yet or a stale one, and RPCs to them would
    // ETIMEDOUT and slow the whole fan-out. See bug report
    // "siclaw-agent-reload-stale-pods-and-serial-blocking".
    const targets = boxes.filter((b) => b.agentId === agentId && b.status === "running");

    if (targets.length === 0) {
      console.log(`[rpc] agent.reload: no active boxes for agent=${agentId}, skipping`);
      return { ok: true, reloaded: [], skipped: resourceTypes, boxes: 0 };
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
    return { ok: true, reloaded, failed, boxes: targets.length };
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
          if (url === "/api/internal/delegate" && method === "POST") {
            if (!identity) { res.writeHead(401, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Client certificate required" })); return; }
            void handleDelegate(req, res, identity, { agentBoxManager, agentBoxTlsOptions, frontendClient });
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
