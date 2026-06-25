/**
 * Compile driver — the thin runtime adapter between a compile box and the
 * sicore control plane.
 *
 * The compile box (kbc, Python) speaks a lean compile protocol over mTLS:
 *   POST /compile {run_id, round, source_ref}      → start
 *   GET  /events/:run_id  (SSE)                     → summary | parked | done | log | error | end
 *   POST /rulings {run_id, rulings}                 → resume a parked compile
 *
 * This driver POSTs /compile, consumes the SSE stream, and relays the
 * structured events to sicore as compile.* RPCs over the runtime's WS — the
 * matching inbound handlers live in sicore's internal/siclaw/compilation. The
 * run state machine lives in sicore; this driver is stateless plumbing.
 */

import type { AgentBoxClient } from "./client.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";

export interface DriveCompileOptions {
  client: AgentBoxClient;
  runId: string;
  round: number;
  sourceRef?: string;
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
}

/**
 * Start the compile on the box and relay its event stream to sicore until the
 * box emits `end`. Throws if the box rejects /compile; the caller (compile.start
 * handler) logs and reports the failure.
 */
export async function driveCompile(opts: DriveCompileOptions): Promise<void> {
  const { client, runId, round, sourceRef, frontendClient } = opts;

  // Kick off the compile. workdir defaults to /work on the box (the spawned
  // pod's writable volume). Fast ack — the box runs the compile in the bg.
  await client.postJson("/compile", { run_id: runId, round, source_ref: sourceRef });

  for await (const raw of client.streamPath(`/events/${runId}`)) {
    const evt = raw as BoxEvent;
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
      case "error":
        // v1 has no compile.failed RPC; surface the error to the owner via the
        // summary channel so it's visible rather than a silent stall.
        await frontendClient.request("compile.summary", { run_id: runId, summary: `error: ${evt.error}` });
        break;
      case "log":
      case "end":
      default:
        // log/end are box-local lifecycle; nothing to relay.
        break;
    }
  }
}
