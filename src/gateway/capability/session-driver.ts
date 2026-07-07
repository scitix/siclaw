/**
 * driveCapabilitySession — the capability-protocol box driver (option B, B2b).
 *
 * Consumes a box's `/events/:runId` SSE and speaks the GENERIC capability wire:
 *   - live frames  → capability.event {runId, type: log|turn|summary|lifecycle}
 *   - knowledge    → capability.persistArtifact (content → the consumer's store)
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
  CapabilityPersistArtifactRequest,
  CapabilityPersistTurnRequest,
} from "./contract.js";
import {
  CAPABILITY_EVENT,
  CAPABILITY_PERSIST_ARTIFACT,
  CAPABILITY_PERSIST_TURN,
  isTerminalCapabilityStatus,
} from "./contract.js";

interface BoxEvent {
  type: string;
  summary?: string;
  message?: string;
  text?: string;
  error?: string;
  /** `deleted` entries are tombstones — the box removed a previously-synced file. */
  artifacts?: Array<{ path: string; content?: string; deleted?: boolean }>;
}

export interface DriveCapabilitySessionOptions {
  client: AgentBoxClient;
  runId: string;
  frontendClient: FrontendWsClient;
  manager: CapabilityRunManager;
}

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

  for await (const raw of client.streamPath(`/events/${runId}`)) {
    const evt = raw as BoxEvent;
    // ANY box event means the box is alive → bump activity so the watchdog never
    // reaps an actively-working run (e.g. a long compile emitting only `log`).
    // touch() is in-memory only (no persist), so it is cheap to call every event.
    manager.touch(runId);
    console.log(`[capability] run=${runId} box event: ${evt.type}`);
    switch (evt.type) {
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
          console.error(`[capability] run=${runId} persistTurn failed:`, err instanceof Error ? err.message : String(err));
        }
        await manager.setStatus(runId, "idle");
        break;
      case "syncArtifacts":
        // Knowledge content the box produced → the consumer's store, one artifact
        // at a time. Content is inline base64 (opaque to the transport). A failed
        // persist must not fail the run (a transient WS blip would kill a healthy
        // compile), but it IS real potential loss — the box's sync dedups by
        // content hash, so this exact version is only re-sent if the file changes
        // again. Hence one retry, then a loud log.
        for (const a of evt.artifacts ?? []) {
          const artifact: CapabilityPersistArtifactRequest = a.deleted
            ? // Tombstone: the box deleted this file (page merge/rename/restructure).
              // Without propagating it, the consumer's row outlives the file —
              // publish ships the deleted page and the next respawn's workspace
              // rehydration resurrects it onto the box's disk.
              { run_id: runId, path: a.path, deleted: true }
            : {
                run_id: runId,
                path: a.path,
                content: { inline_base64: Buffer.from(a.content ?? "", "utf8").toString("base64") },
              };
          try {
            await frontendClient.request(CAPABILITY_PERSIST_ARTIFACT, artifact);
          } catch {
            try {
              await new Promise((r) => setTimeout(r, 1000));
              await frontendClient.request(CAPABILITY_PERSIST_ARTIFACT, artifact);
            } catch (err) {
              console.error(
                `[capability] run=${runId} persistArtifact(${a.path}) DROPPED after retry (box only re-sends on content change):`,
                err instanceof Error ? err.message : String(err),
              );
            }
          }
        }
        break;
      case "done":
        emit("lifecycle", { status: "done" });
        await manager.endRun(runId, "done");
        break;
      case "error":
        emit("lifecycle", { status: "failed", error: evt.error ?? "" });
        await manager.endRun(runId, "failed");
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
        await manager.endRun(runId, "done");
        break;
      }
      default:
        break;
    }
  }
}
