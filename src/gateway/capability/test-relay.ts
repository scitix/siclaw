/**
 * driveTestSession — the read-only test-session relay (start-a-test-session).
 *
 * Consumes a box's `/test-events/:tid` SSE and forwards each frame LIVE as
 * capability.event {type:"test", payload:{test_session_id, kind, text}} on the
 * PARENT authoring run.
 *
 * DELIBERATELY stateless — the structural difference from driveCapabilitySession:
 * a test session is a disposable consumer probe over a pinned snapshot, so this
 * relay NEVER calls persistTurn / persistArtifact and never writes run lifecycle.
 * Test chatter must not pollute the authoring history; what the product keeps
 * (starred questions, reference answers, gradings) is the consumer's own domain
 * data, written through its own APIs — not through the capability sink.
 */

import type { AgentBoxClient } from "../agentbox/client.js";
import type { FrontendWsClient } from "../frontend-ws-client.js";
import type { CapabilityEventFrame } from "./contract.js";
import { CAPABILITY_EVENT } from "./contract.js";

interface TestBoxEvent {
  type: string;
  text?: string;
  error?: string;
  session_id?: string;
}

export interface DriveTestSessionOptions {
  client: AgentBoxClient;
  /** The parent AUTHORING run (owns the box the test session lives in). */
  runId: string;
  testSessionId: string;
  frontendClient: FrontendWsClient;
  /**
   * Bump the parent run's activity on every test frame so the watchdog keeps
   * the SHARED box alive while a human is mid-test (an idle authoring run would
   * otherwise age toward its idle TTL while its box is actively serving tests).
   */
  touch?: () => void;
}

/**
 * Relay the test-session event stream until the box closes it (`end`, emitted
 * on teardown/close). Errors propagate to the caller — which only logs: a dead
 * test relay is disposable, never a run failure.
 */
export async function driveTestSession(opts: DriveTestSessionOptions): Promise<void> {
  const { client, runId, testSessionId, frontendClient, touch } = opts;
  for await (const raw of client.streamPath(`/test-events/${testSessionId}`)) {
    const evt = raw as TestBoxEvent;
    touch?.();
    const frame: CapabilityEventFrame = {
      run_id: runId,
      type: "test",
      payload: {
        test_session_id: testSessionId,
        kind: evt.type,
        text: evt.text ?? evt.error ?? "",
      },
    };
    frontendClient.emitEvent(CAPABILITY_EVENT, frame);
    if (evt.type === "end") break;
  }
}
