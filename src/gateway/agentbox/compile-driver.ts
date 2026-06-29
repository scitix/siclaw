/**
 * Compile driver — the thin runtime adapter between a compile box and the
 * sicore control plane.
 *
 * The compile box (kbc, Python) speaks a lean compile protocol over mTLS:
 *   POST /sources {run_id, bundle_base64, bundle_sha256} → materialize frozen raw input
 *   POST /authoring {run_id, bundle_base64, bundle_sha256} → materialize authoring assets
 *   POST /compile {run_id, round, source_ref, instruction} → start
 *   GET  /events/:run_id  (SSE)        → summary | parked | done | syncArtifacts | log | error | end
 *   POST /rulings {run_id, rulings}                 → resume a parked compile
 *
 * This driver asks sicore for the run's frozen source bundle, POSTs it to
 * /sources, POSTs /compile, consumes the SSE stream, and relays the structured
 * events to sicore as compile.* RPCs over the runtime's WS — the matching
 * inbound handlers live in sicore's internal/siclaw/compilation. The run state
 * machine lives in sicore; this driver is stateless plumbing.
 */

import type { AgentBoxClient } from "./client.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";

export interface DriveCompileOptions {
  client: AgentBoxClient;
  runId: string;
  round: number;
  sourceRef?: string;
  instruction?: string;
  authoringBundleBase64?: string;
  authoringBundleSHA256?: string;
  authoringBundleSizeBytes?: number;
  frontendClient: FrontendWsClient;
}

interface BoxEvent {
  type: string;
  summary?: string;
  checkpoint?: unknown;
  bundle_b64?: string;
  message?: string;
  error?: string;
  text?: string;
  artifacts?: Array<{ path: string; content: string }>;
}

interface SourceBundleResponse {
  bundle_base64?: string;
  bundle_sha256?: string;
  source_ref?: string;
}

/**
 * Start the compile on the box and relay its event stream to sicore until the
 * box emits `end`. Throws if the box rejects /compile; the caller (compile.start
 * handler) logs and reports the failure.
 */
export async function driveCompile(opts: DriveCompileOptions): Promise<void> {
  const { client, runId, round, sourceRef, instruction, authoringBundleBase64, authoringBundleSHA256, authoringBundleSizeBytes, frontendClient } = opts;

  const sourceBundle = await frontendClient.request("compile.sourceBundle", { run_id: runId }) as SourceBundleResponse;
  if (!sourceBundle?.bundle_base64) {
    throw new Error(`compile.sourceBundle for run ${runId} returned no bundle_base64`);
  }

  await client.postJson("/sources", {
    run_id: runId,
    bundle_base64: sourceBundle.bundle_base64,
    bundle_sha256: sourceBundle.bundle_sha256,
  });

  if (authoringBundleBase64) {
    await client.postJson("/authoring", {
      run_id: runId,
      bundle_base64: authoringBundleBase64,
      bundle_sha256: authoringBundleSHA256,
      bundle_size_bytes: authoringBundleSizeBytes,
    });
  }

  // Kick off the compile. workdir defaults to /work on the box (the spawned
  // pod's writable volume). Fast ack — the box runs the compile in the bg.
  await client.postJson("/compile", {
    run_id: runId,
    round,
    source_ref: sourceRef ?? sourceBundle.source_ref,
    instruction: instruction ?? "",
  });

  await relayBoxEvents(client, runId, frontendClient);
}

export interface DriveSessionOptions {
  client: AgentBoxClient;
  runId: string;
  frontendClient: FrontendWsClient;
}

/**
 * Drive a persistent conversational box session: just relay its event stream to
 * sicore until the box emits `end`. The session itself is started (POST /session)
 * and fed turns (POST /message) by the compile.message handler in server.ts; this
 * is the long-lived consumer that turns box events into compile.* RPCs + the live
 * browser stream — the same relay the one-shot compile uses, minus the setup.
 */
export async function driveSession(opts: DriveSessionOptions): Promise<void> {
  await relayBoxEvents(opts.client, opts.runId, opts.frontendClient);
}

/**
 * Consume the box's /events SSE and relay each event two ways: live to the
 * browser as compile.event (fire-and-forget, incl. the agent's `log` reasoning),
 * and as durable compile.* req/response RPCs so run state persists regardless of
 * viewers. Shared by the one-shot compile and the persistent session. Returns
 * when the box closes the stream (`end`).
 */
export async function relayBoxEvents(client: AgentBoxClient, runId: string, frontendClient: FrontendWsClient): Promise<void> {
  for await (const raw of client.streamPath(`/events/${runId}`)) {
    const evt = raw as BoxEvent;
    frontendClient.emitEvent("compile.event", { run_id: runId, event: evt });
    switch (evt.type) {
      case "summary":
        await frontendClient.request("compile.summary", { run_id: runId, summary: evt.summary });
        break;
      case "parked":
        await frontendClient.request("compile.parked", { run_id: runId, checkpoint: evt.checkpoint });
        break;
      case "done":
        await frontendClient.request("compile.done", {
          run_id: runId,
          bundle: evt.bundle_b64,
          message: evt.message,
        });
        break;
      case "syncArtifacts":
        // Persist the box's in-progress workspace files (candidate/PLAN/eval) so
        // work survives a box crash and a resumed box bootstraps from the latest
        // state instead of restarting from the frozen authoring snapshot.
        await frontendClient.request("compile.syncArtifacts", { run_id: runId, artifacts: evt.artifacts });
        break;
      case "turn_done":
        // A conversational turn ended; persist the whole assistant reply so the
        // prepare chat is durable (sicore no-ops on an empty text, e.g. a pure
        // tool/compile turn). The live text already streamed via compile.event.
        await frontendClient.request("compile.assistantTurn", { run_id: runId, text: evt.text ?? "" });
        break;
      case "error":
        // Terminal failure the box reported — mark the run failed in sicore so it
        // goes terminal now instead of stalling until the watchdog reaps it.
        await frontendClient.request("compile.failed", { run_id: runId, error: evt.error });
        break;
      case "log":
      case "end":
      default:
        // log/end are box-local lifecycle; the live stream already carried them.
        break;
    }
  }
}
