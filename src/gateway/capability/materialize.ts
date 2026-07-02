/**
 * materializeCapabilityInputs — populate a capability box's workspace from the
 * consumer's store before the session starts:
 *
 *   1. frozen raw sources        → POST /sources    (fetchInput, default ref)
 *   2. durable authoring workspace → POST /authoring (fetchInput ref=workspace)
 *
 * The workspace step ONLY runs when /sources succeeded, because that is the
 * fresh-box signal: a box that already holds this run 409s /sources ("run
 * already exists"), and pushing the store's workspace onto a LIVE box could
 * roll back up to a sync interval of newer on-disk work. Everything here is
 * best-effort — an empty KB or a store hiccup must not block the conversation;
 * the box then simply starts from whatever did materialize.
 *
 * Known bounded gap: a box CONTAINER restart clears its in-process run table
 * but keeps /work (emptyDir survives container restarts), so /sources then
 * succeeds and the rehydrate overwrites up to one sync interval (~20s) of
 * on-disk work that never reached the store. That slice was never visible to
 * the user and the end state is store-consistent — accepted for now; a box
 * workspace probe would be needed to close it.
 */

import { CAPABILITY_FETCH_INPUT, CAPABILITY_INPUT_WORKSPACE_REF } from "./contract.js";
import type { CapabilityFetchInputRequest, CapabilityFetchInputResponse } from "./contract.js";

/** Just the surfaces this needs (so tests can pass fakes). */
export interface MaterializeBoxClient {
  postJson<T = unknown>(path: string, body: unknown): Promise<T>;
}
export interface MaterializeBackend {
  request(method: string, params?: unknown): Promise<any>;
}

export interface MaterializeResult {
  /** Consumer-declared locale for the run's box (fetchInput), if any. */
  locale?: string;
}

export async function materializeCapabilityInputs(opts: {
  client: MaterializeBoxClient;
  backend: MaterializeBackend;
  runId: string;
}): Promise<MaterializeResult> {
  const { client, backend, runId } = opts;

  const result: MaterializeResult = {};
  let freshBox = false;
  try {
    const req: CapabilityFetchInputRequest = { run_id: runId };
    const src = (await backend.request(CAPABILITY_FETCH_INPUT, req)) as CapabilityFetchInputResponse;
    if (src?.locale) result.locale = src.locale;
    if (src?.bundle_base64) {
      await client.postJson("/sources", {
        run_id: runId,
        bundle_base64: src.bundle_base64,
        bundle_sha256: src.bundle_sha256,
        locale: src.locale,
      });
      freshBox = true;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("failed: 409")) {
      // The box already holds this run (live on-disk state) — reattach without
      // touching its workspace.
      console.log(`[capability] session ${runId}: box already live; skipping materialization`);
    } else {
      console.warn(`[capability] session ${runId}: source materialize skipped:`, msg);
    }
    return result;
  }
  if (!freshBox) return result; // empty KB — nothing told us the box is fresh, don't guess

  try {
    const req: CapabilityFetchInputRequest = { run_id: runId, ref: CAPABILITY_INPUT_WORKSPACE_REF };
    const ws = (await backend.request(CAPABILITY_FETCH_INPUT, req)) as CapabilityFetchInputResponse;
    if (ws?.bundle_base64) {
      await client.postJson("/authoring", {
        run_id: runId,
        bundle_base64: ws.bundle_base64,
        bundle_sha256: ws.bundle_sha256,
        locale: result.locale,
      });
      console.log(`[capability] session ${runId}: rehydrated authoring workspace into fresh box`);
    }
  } catch (err) {
    // The box still has raw/ — the agent can work; it just lost draft continuity.
    console.warn(
      `[capability] session ${runId}: workspace rehydrate skipped:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  return result;
}
