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
 * roll back up to a sync interval of newer on-disk work. A successful fetch
 * with no bundle is the consumer's typed absence (an empty KB / brand-new
 * workspace). Transport and install failures fail setup closed: continuing
 * from a partial or unknown input could overwrite a durable draft.
 *
 * Known bounded gap: a box CONTAINER restart clears its in-process run table
 * but keeps /work (emptyDir survives container restarts), so /sources then
 * succeeds and the rehydrate overwrites up to one sync interval (~20s) of
 * on-disk work that never reached the store. That slice was never visible to
 * the user and the end state is store-consistent — accepted for now; a box
 * workspace probe would be needed to close it.
 */

import { CAPABILITY_FETCH_INPUT, CAPABILITY_INPUT_WORKSPACE_REF } from "./contract.js";
import type {
  CapabilityFetchInputRequest,
  CapabilityFetchInputResponse,
  CapabilityLlmConfig,
} from "./contract.js";

/** Just the surfaces this needs (so tests can pass fakes). */
export interface MaterializeBoxClient {
  postJson<T = unknown>(path: string, body: unknown): Promise<T>;
}
export interface MaterializeBackend {
  request(method: string, params?: unknown): Promise<any>;
}

export interface MaterializeResult {
  /** Immutable input revision actually installed into a fresh box. */
  inputRevision?: string;
  /** /sources reported an already-live run; the event relay must request replay. */
  reattached?: boolean;
  /** Consumer-declared locale for the run's box (fetchInput), if any. */
  locale?: string;
  /** Consumer-managed LLM block for the box (opaque whole-block passthrough; never logged). */
  llm?: CapabilityLlmConfig;
  /** Consumer-managed KBC_* behavior knobs for the box (opaque passthrough). */
  settings?: Record<string, string>;
}

export type CapabilityMaterializationStage =
  | "source-fetch"
  | "source-install"
  | "workspace-fetch"
  | "workspace-install";

/** Setup error with a stable stage for lifecycle reporting and metrics. */
export class CapabilityMaterializationError extends Error {
  readonly stage: CapabilityMaterializationStage;

  constructor(stage: CapabilityMaterializationStage, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`capability input materialization failed at ${stage}: ${detail}`, { cause });
    this.name = "CapabilityMaterializationError";
    this.stage = stage;
  }
}

function isBoxAlreadyLive(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 409) return true;
  const message = err instanceof Error ? err.message : String(err);
  return typeof status !== "number" && message.includes("failed: 409");
}

export async function materializeCapabilityInputs(opts: {
  client: MaterializeBoxClient;
  backend: MaterializeBackend;
  runId: string;
  /** Existing checkpoint recovered for this run; fresh boxes must reinstall it exactly. */
  inputRevision?: string;
}): Promise<MaterializeResult> {
  const { client, backend, runId, inputRevision } = opts;

  const result: MaterializeResult = {};
  const req: CapabilityFetchInputRequest = {
    run_id: runId,
    ...(inputRevision ? { input_revision: inputRevision } : {}),
  };
  let src: CapabilityFetchInputResponse;
  try {
    src = (await backend.request(CAPABILITY_FETCH_INPUT, req)) as CapabilityFetchInputResponse;
  } catch (err) {
    throw new CapabilityMaterializationError("source-fetch", err);
  }

  const pinnedRevision = inputRevision?.trim();
  if (pinnedRevision) {
    const returnedRevision = typeof src?.input_revision === "string" ? src.input_revision.trim() : "";
    if (returnedRevision !== pinnedRevision) {
      throw new CapabilityMaterializationError(
        "source-fetch",
        new Error(
          `input revision mismatch: requested ${pinnedRevision}, received ${returnedRevision || "<missing>"}`,
        ),
      );
    }
    if (!src.bundle_base64) {
      throw new CapabilityMaterializationError(
        "source-fetch",
        new Error(`pinned input revision ${pinnedRevision} returned no source bundle`),
      );
    }
  }

  if (src?.locale) result.locale = src.locale;
  if (src?.llm && typeof src.llm === "object") result.llm = src.llm;
  if (src?.settings && typeof src.settings === "object") result.settings = src.settings;

  // RPC success + no bundle is the explicit empty-source result. It is not a
  // fresh-box signal, so never guess and push workspace state onto a live box.
  if (!src?.bundle_base64) return result;

  try {
    await client.postJson("/sources", {
      run_id: runId,
      bundle_base64: src.bundle_base64,
      bundle_sha256: src.bundle_sha256,
      locale: src.locale,
    });
  } catch (err) {
    // Prefer the structured HTTP status; message parsing is only a rolling-
    // upgrade fallback for older clients that did not attach err.status.
    if (isBoxAlreadyLive(err)) {
      // The box already holds this run (live on-disk state) — reattach without
      // touching its workspace.
      console.log(`[capability] session ${runId}: box already live; skipping materialization`);
      result.reattached = true;
      return result;
    }
    throw new CapabilityMaterializationError("source-install", err);
  }
  if (src.input_revision) result.inputRevision = src.input_revision;

  let ws: CapabilityFetchInputResponse;
  try {
    const workspaceReq: CapabilityFetchInputRequest = { run_id: runId, ref: CAPABILITY_INPUT_WORKSPACE_REF };
    ws = (await backend.request(CAPABILITY_FETCH_INPUT, workspaceReq)) as CapabilityFetchInputResponse;
  } catch (err) {
    throw new CapabilityMaterializationError("workspace-fetch", err);
  }

  // Successful absence is a brand-new attempt with no durable workspace yet.
  if (!ws?.bundle_base64) return result;

  try {
    await client.postJson("/authoring", {
      run_id: runId,
      bundle_base64: ws.bundle_base64,
      bundle_sha256: ws.bundle_sha256,
      locale: result.locale,
    });
  } catch (err) {
    throw new CapabilityMaterializationError("workspace-install", err);
  }
  console.log(`[capability] session ${runId}: rehydrated authoring workspace into fresh box`);
  return result;
}
