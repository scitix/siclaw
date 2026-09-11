/**
 * driveCapabilitySession — the capability-protocol box driver (option B, B2b).
 *
 * Consumes a box's `/events/:runId` SSE and speaks the GENERIC capability wire:
 *   - live frames  → capability.event {runId, type: log|turn|summary|lifecycle}
 *   - knowledge    → capability.persistArtifacts (one all-or-nothing consumer batch)
 *   - lifecycle    → writes back to the CapabilityRunManager (idle/done/failed)
 *
 * This is the capability-native replacement for compile-driver's relayBoxEvents
 * (which still speaks compile.* and stays in use until B3 deletes the old path).
 * Contradiction handling is a normal turn, so there is NO parked/awaiting_input
 * frame — the box never emits `parked`, so there is no handler for it.
 */

import type { AgentBoxClient } from "../agentbox/client.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";
import type { CapabilityRunManager } from "./run-manager.js";
import type {
  CapabilityEventFrame,
  CapabilityEventPayload,
  CapabilityEventType,
  CapabilityPersistArtifactsRequest,
  CapabilityPersistTurnRequest,
} from "./contract.js";
import {
  CAPABILITY_EVENT,
  CAPABILITY_PERSIST_ARTIFACTS,
  CAPABILITY_PERSIST_TURN,
  isTerminalCapabilityStatus,
} from "./contract.js";
import { structuredBoxFailure } from "./failure.js";
import { capabilityRelayReconnectsTotal } from "./capability-metrics.js";
import { ExecutionObservationRelay, type ExecutionObservation } from "./execution-observation.js";

interface BoxEvent {
  type: string;
  /** Negotiated ordered delivery; only these frames require a persistence ACK. */
  event_id?: string;
  event_ack?: number;
  summary?: string;
  /**
   * On error events: producer **safe** short reason for checkpoint (e.g.
   * `batch_failed:TimeoutError`). Never the owner-facing `error` / exception repr.
   * On other events historically unused free-form text — still never logged from error path.
   */
  message?: string;
  text?: string;
  /** Owner-facing error text only — never logs/checkpoint. */
  error?: string;
  /** Only this owner turn failed; the connected session can accept another. */
  recoverable?: boolean;
  /** `deleted` entries are tombstones — the box removed a previously-synced file. */
  artifacts?: Array<{ path: string; content?: string; deleted?: boolean }>;
  /** Explicit full-compile commit. Replayed file presence alone is not a commit. */
  commit_input?: boolean;
  /** KBC durability barrier identity; ACK only after consumer commit succeeds. */
  sync_id?: string;
  code?: string;
  stage?: string;
  attempts?: number;
  idle_s?: number;
  bound_s?: number;
  tool_pending?: boolean;
  last_sdk_message?: string;
  /** Exception type name token only. */
  exception_class?: string;
  reason?: string;
  observation?: ExecutionObservation;
}

export interface DriveCapabilitySessionOptions {
  client: AgentBoxClient;
  runId: string;
  frontendClient: FrontendWsClient;
  manager: CapabilityRunManager;
  /** Re-attaching to a live box after relay/runtime loss: request full replay. */
  replayWorkspace?: boolean;
  /** Bounded reconnect of the box event stream (see driveCapabilitySession). */
  reconnect?: Partial<StreamReconnectPolicy>;
}

export interface StreamReconnectPolicy {
  /** Reconnect attempts per run before the relay gives up and fails the run. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Probe the box before reconnecting; a dead box is not worth waiting for. */
  isBoxAlive: (client: AgentBoxClient) => Promise<boolean>;
}

// Six attempts per run with 2s→60s backoff allow 122 seconds of backoff
// in total; the run-manager's data-stale watchdog still bounds a box that is
// alive but silent. A box that answers /health is worth reconnecting to — the
// alternative (relay_failed → stop the box) throws away the whole in-flight
// batch for a broken TCP connection.
export const defaultStreamReconnectPolicy: StreamReconnectPolicy = {
  maxAttempts: 6,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  isBoxAlive: async (client) => {
    try {
      await client.getJson("/health");
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Relay the box event stream over the capability protocol until the box closes
 * the stream (`end`). Returns when the stream ends. Errors propagate to the
 * caller, which fails the run.
 */
export async function driveCapabilitySession(opts: DriveCapabilitySessionOptions): Promise<void> {
  const { client, runId, frontendClient, manager } = opts;
  const emit = (type: CapabilityEventType, payload: CapabilityEventPayload) => {
    const frame: CapabilityEventFrame = { run_id: runId, type, payload };
    frontendClient.emitEvent(CAPABILITY_EVENT, frame);
  };

  const observations = new ExecutionObservationRelay(frontendClient, runId, () => {
    emit("summary", { text: "Some execution diagnostics could not be saved. Compilation continues; its artifact checkpoints remain authoritative." });
  });
  const policy: StreamReconnectPolicy = { ...defaultStreamReconnectPolicy, ...opts.reconnect };
  let replay = opts.replayWorkspace === true;
  let attempts = 0;
  let replaySupported = false;
  let lastCommittedEvent = manager.get(runId)?.persistedRelayEventId;
  // Only TRANSPORT errors (the stream itself) are retried. An error thrown while
  // relaying an event — e.g. the artifact persist loop giving up because the run
  // was cancelled or reaped — is a relay decision and must fail the run as before.
  let relayError: unknown;
  try {
    for (;;) {
      // onComment: the box emits `: heartbeat` SSE comments between data events. A
      // long read-only compile phase can be data-silent for >10min — the heartbeat
      // must count as liveness (touchHeartbeat, the separate clock) or the watchdog
      // reaps a healthy run and kills its box. It is deliberately NOT touch(): a box
      // that ONLY heartbeats (a wedged turn) must still be reaped at dataStaleMs.
      const eventPath = `/events/${runId}?ack=1${replay ? "&replay=1" : ""}`;
      let acknowledgedStream = false;
      let sawEnd = false;
      try {
        for await (const raw of client.streamPath(eventPath, { onComment: () => manager.touchHeartbeat(runId) })) {
          const event = raw as BoxEvent;
          if (event.type === "end") sawEnd = true;
          if (event.type === "relay_ready" && event.event_ack === 1) {
            acknowledgedStream = true;
            replaySupported = true;
            continue;
          }
          try {
            if ((replaySupported || replay) && !acknowledgedStream) throw new Error("box cannot safely replay lifecycle events");
            if (acknowledgedStream && ["syncArtifacts", "turn_done", "error", "done", "end"].includes(event.type)) {
              if (typeof event.event_id !== "string" || !/^[a-f0-9]{32}:[1-9][0-9]{0,15}$/.test(event.event_id)) {
                throw new Error("box omitted a valid durable event id");
              }
              if (event.event_id !== lastCommittedEvent && event.event_id !== manager.get(runId)?.persistedRelayEventId) {
                // The consumer already supports adjacent persistTurn retries.
                // No later frame is consumed until this event and its state commit.
                for (let retry = 0; ; retry++) {
                  try {
                    if (manager.get(runId)?.persistedRelayEventId === event.event_id) break;
                    await relayBoxEvent(event);
                    await manager.commitRelayEvent(runId, event.event_id);
                    break;
                  } catch (err) {
                    if (retry >= 3) throw err;
                    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** retry));
                  }
                }
              }
              lastCommittedEvent = event.event_id;
            } else {
              await relayBoxEvent(event);
            }
          } catch (err) {
            relayError = err;
            throw err;
          }
          if (acknowledgedStream && event.event_id) {
            // Lost ACK responses are transport failures: reattach and ACK the
            // same event without replaying its already-persisted side effects.
            await client.postJson(`/events/ack/${runId}`, { event_id: event.event_id }, 10_000);
          }
        }
        if (replay && !acknowledgedStream) throw new Error("box cannot safely replay lifecycle events");
        if (acknowledgedStream && !sawEnd && !runSettled()) throw new Error("box stream ended before its end event");
        return; // clean close: the box ended the stream
      } catch (err) {
        if (relayError !== undefined) throw err;
        // A stream error after the run already settled has nothing left to relay
        // — do not turn it into a relay_failed that stops a box which is already
        // finished. endRun() DROPS the live record once the terminal state is
        // persisted, so "no record" is the normal settled case, not an unknown.
        if (runSettled()) {
          console.warn(`[capability] run=${runId} box stream error after the run settled; ignoring`);
          return;
        }
        if (!replaySupported) throw err; // Legacy boxes cannot replay lost lifecycle frames.
        attempts++;
        if (attempts > policy.maxAttempts || !(await policy.isBoxAlive(client))) {
          throw err;
        }
        // The probe awaited; the run may have been cancelled or finished meanwhile.
        if (runSettled()) return;
        const delay = Math.min(policy.baseDelayMs * 2 ** (attempts - 1), policy.maxDelayMs);
        console.warn(
          `[capability] run=${runId} box stream lost (${attempts}/${policy.maxAttempts}), box alive; ` +
            `reconnecting with replay in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        // Same check after the backoff: never reopen a stream for a settled run.
        if (runSettled()) return;
        // Re-attach semantics: ask for the workspace replay so a sync batch that
        // was in flight when the connection broke is delivered again (the
        // consumer accepts duplicate ACKs; persistArtifacts is idempotent).
        capabilityRelayReconnectsTotal.inc();
        replay = true;
      }
    }
  } finally {
    // Bounded background drain; terminal state and artifact ACKs do not await it.
    void observations.close();
  }

  /** True once the run is terminal or its live record is gone (endRun drops it). */
  function runSettled(): boolean {
    const rec = manager.get(runId);
    return !rec || isTerminalCapabilityStatus(rec.status);
  }

  async function relayBoxEvent(evt: BoxEvent): Promise<void> {
    // ANY box event means the box is alive → bump activity so the watchdog never
    // reaps an actively-working run (e.g. a long compile emitting only `log`).
    // touch() is in-memory only (no persist), so it is cheap to call every event.
    manager.touch(runId);
    if (evt.type === "error") {
      // Log only the safe contract fields — never evt.error (may hold paths /
      // provider fragments). Production triage previously saw only "error".
      const safe = structuredBoxFailure(evt);
      console.error(
        `[capability] run=${runId} box event: error` +
          ` code=${safe.code} stage=${safe.stage}` +
          ` exception_class=${safe.exception_class ?? "-"}` +
          ` last_sdk_message=${safe.last_sdk_message ?? "-"}` +
          ` message=${truncateForLog(safe.message ?? "")}`,
      );
    } else {
      console.log(`[capability] run=${runId} box event: ${evt.type}`);
    }
    switch (evt.type) {
      case "execution_observation":
        observations.enqueue(evt.observation);
        break;
      case "log":
        emit("log", { text: evt.text ?? "" });
        break;
      case "summary":
        emit("summary", { text: evt.summary ?? "" });
        break;
      case "turn_done":
        // A conversational/compile turn ended. Surface the reply LIVE, then persist
        // it durably (the frontend renders from a DB refetch, not the live frame) —
        // this is the generalization of compile.assistantTurn. The run is now idle
        // (awaiting the next turn) — NOT terminal.
        emit("turn", { text: evt.text ?? "" });
        try {
          const turn: CapabilityPersistTurnRequest = { run_id: runId, text: evt.text ?? "" };
          await frontendClient.request(CAPABILITY_PERSIST_TURN, turn);
        } catch (err) {
          if (evt.event_id) throw err;
          console.error(`[capability] run=${runId} persistTurn failed:`, err instanceof Error ? err.message : String(err));
        }
        if (evt.event_id) await manager.commitRelayEvent(runId, evt.event_id, "idle");
        else await manager.setStatus(runId, "idle");
        break;
      case "syncArtifacts":
        // One box sync event is one consumer transaction. Keep retrying the
        // SAME batch until acknowledged; consuming later turn_done/done frames
        // before its workspace is durable would expose a torn draft.
        {
          const artifacts = (evt.artifacts ?? []).flatMap((a) => {
            if (!a || typeof a.path !== "string" || !a.path) {
              console.error(`[capability] run=${runId} malformed artifact entry skipped`);
              return [];
            }
            if (!a.deleted && a.content !== undefined && typeof a.content !== "string") {
              console.error(`[capability] run=${runId} malformed artifact entry (${a.path}) skipped`);
              return [];
            }
            return [a.deleted
              ? { path: a.path, deleted: true }
              : {
                  path: a.path,
                  content: { inline_base64: Buffer.from(a.content ?? "", "utf8").toString("base64") },
                }];
          });
          const inputRevision = manager.get(runId)?.inputRevision?.trim();
          const commitInput = evt.commit_input === true && Boolean(inputRevision);
          if (evt.commit_input && !commitInput) {
            const warning =
              "Source provenance was not advanced because this run has no pinned input revision. Any artifact changes will be saved without committing the input baseline; start a new compile run after source materialization recovers.";
            console.error(`[capability] run=${runId} commit_input downgraded to content-only persistence: missing input revision`);
            emit("summary", { text: warning });
          }
          if (artifacts.length === 0 && !commitInput) break;
          const request: CapabilityPersistArtifactsRequest = {
            run_id: runId,
            ...(inputRevision ? { input_revision: inputRevision } : {}),
            ...(commitInput ? { commit_input: true } : {}),
            artifacts,
          };
          let delayMs = 250;
          for (;;) {
            try {
              await frontendClient.request(CAPABILITY_PERSIST_ARTIFACTS, request);
              break;
            } catch (err) {
              const rec = manager.get(runId);
              if (!rec || isTerminalCapabilityStatus(rec.status)) {
                throw new Error(
                  `persistArtifacts retry aborted because run ${runId} is no longer active: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
              console.error(
                `[capability] run=${runId} persistArtifacts failed; retrying in ${delayMs}ms:`,
                err instanceof Error ? err.message : String(err),
              );
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              delayMs = Math.min(delayMs * 2, 5000);
            }
          }
          if (evt.sync_id !== undefined) {
            if (typeof evt.sync_id !== "string" || !evt.sync_id || evt.sync_id.length > 128) {
              throw new Error(`invalid artifact sync id for run ${runId}`);
            }
            // Persistence acknowledgement is a second, idempotent hop back to
            // KBC. Until it lands, the box must not start the next batch. A WS
            // reconnect may replay the same sync_id; the control plane upserts atomically
            // and this endpoint accepts duplicate ACKs.
            let ackDelayMs = 250;
            for (;;) {
              try {
                await client.postJson(`/artifacts/ack/${runId}`, { sync_id: evt.sync_id }, 10_000);
                break;
              } catch (err) {
                const rec = manager.get(runId);
                if (!rec || isTerminalCapabilityStatus(rec.status)) {
                  throw new Error(
                    `artifact acknowledgement aborted because run ${runId} is no longer active: ${err instanceof Error ? err.message : String(err)}`,
                  );
                }
                console.error(
                  `[capability] run=${runId} artifact ACK failed; retrying in ${ackDelayMs}ms:`,
                  err instanceof Error ? err.message : String(err),
                );
                await new Promise((resolve) => setTimeout(resolve, ackDelayMs));
                ackDelayMs = Math.min(ackDelayMs * 2, 5000);
              }
            }
          }
        }
        break;
      case "done":
        emit("lifecycle", { status: "done" });
        if (evt.event_id) await manager.commitRelayEvent(runId, evt.event_id, "done");
        else await manager.endRun(runId, "done");
        break;
      case "error":
        if (evt.recoverable === true) {
          // A provider refusal ended one conversational turn; the worker and
          // its workspace remain usable. turn_done returns this run to idle.
          emit("summary", { text: evt.error ?? evt.message ?? "Model request failed" });
          break;
        }
        emit("lifecycle", { status: "failed", error: evt.error ?? "" });
        // Always persist a structured failure. Bare box errors (error string
        // only, no code/stage) used to call endRun without a failure object, so
        // the consumer checkpoint and auto-resume detail were empty.
        if (evt.event_id) await manager.commitRelayEvent(runId, evt.event_id, "failed", structuredBoxFailure(evt));
        else await manager.endRun(runId, "failed", structuredBoxFailure(evt));
        break;
      case "end": {
        // The box's session coroutine exited (clean stream close: max_turns
        // exhaustion, subprocess EOF). This run can never take another turn —
        // the box keeps its RUNS entry with a dead client, so every /message
        // 409s. Left non-terminal it wedges the consumer for the whole idle TTL
        // (find-or-start only replaces TERMINAL runs) and the watchdog then
        // blesses the dead session as a 2h-idle "done". Terminalize now instead:
        // the consumer starts a fresh run on the next message and the workspace
        // rehydrates — the designed recovery path. endRun is sticky, so a done/
        // error that arrived before `end` keeps its outcome; the lifecycle frame
        // is skipped in that case to avoid a duplicate.
        const rec = manager.get(runId);
        if (rec && !isTerminalCapabilityStatus(rec.status)) {
          emit("lifecycle", { status: "done" });
        }
        if (evt.event_id) await manager.commitRelayEvent(runId, evt.event_id, "done");
        else await manager.endRun(runId, "done");
        break;
      }
      default:
        break;
    }
  }
}

function truncateForLog(text: string, max = 200): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine || "-";
  return `${oneLine.slice(0, max)}…`;
}

// structuredBoxFailure is shared with run-manager's normalizeFailure (failure.ts)
// so forged/non-token code values are stripped before the log line is written.
