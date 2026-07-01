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
 * frame — a box `parked` (vestigial) is treated as a turn that returned to idle.
 */

import type { AgentBoxClient } from "../agentbox/client.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";
import type { CapabilityRunManager } from "./run-manager.js";
import { CAPABILITY_EVENT, CAPABILITY_PERSIST_ARTIFACT } from "./contract.js";

interface BoxEvent {
  type: string;
  summary?: string;
  message?: string;
  text?: string;
  error?: string;
  artifacts?: Array<{ path: string; content: string }>;
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
  const emit = (type: string, payload: Record<string, unknown>) =>
    frontendClient.emitEvent(CAPABILITY_EVENT, { run_id: runId, type, payload });

  for await (const raw of client.streamPath(`/events/${runId}`)) {
    const evt = raw as BoxEvent;
    // ANY box event means the box is alive → bump activity so the watchdog never
    // reaps an actively-working run (e.g. a long compile emitting only `log`).
    // touch() is in-memory only (no persist), so it is cheap to call every event.
    manager.touch(runId);
    switch (evt.type) {
      case "log":
        emit("log", { text: evt.text ?? "" });
        break;
      case "summary":
        emit("summary", { text: evt.summary ?? "" });
        break;
      case "turn_done":
        // A conversational/compile turn ended. Surface the reply; the run is now
        // idle (awaiting the next turn) — NOT terminal.
        emit("turn", { text: evt.text ?? "" });
        await manager.setStatus(runId, "idle");
        break;
      case "syncArtifacts":
        // Knowledge content the box produced → the consumer's store, one artifact
        // at a time. Content is inline base64 (opaque to the transport).
        for (const a of evt.artifacts ?? []) {
          await frontendClient.request(CAPABILITY_PERSIST_ARTIFACT, {
            run_id: runId,
            path: a.path,
            content: { inline_base64: Buffer.from(a.content, "utf8").toString("base64") },
          });
        }
        break;
      case "parked":
        // Vestigial: the contradiction-as-turn model never blocks. Treat like a
        // turn that returned to idle so a stray park can't wedge the run.
        emit("turn", { text: evt.message ?? "" });
        await manager.setStatus(runId, "idle");
        break;
      case "done":
        emit("lifecycle", { status: "done" });
        await manager.endRun(runId, "done");
        break;
      case "error":
        emit("lifecycle", { status: "failed", error: evt.error ?? "" });
        await manager.endRun(runId, "failed");
        break;
      case "end":
      default:
        // end is box-local; the live stream already carried the content.
        break;
    }
  }
}
