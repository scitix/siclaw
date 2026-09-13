import {
  createAgentSessionFromServices,
  type CreateAgentSessionFromServicesOptions,
} from "@earendil-works/pi-coding-agent";
import { convertOpenAIPdfPayload } from "./openai-file-payload.js";
import {
  extractModelEnvelopeInspection,
  inspectModelEnvelope,
  type ModelEnvelopeInspection,
  type ModelEnvelopeManifest,
} from "./model-envelope.js";
import { createGuardRegistry, installGuardPipeline, type GuardRegistry } from "./guard-pipeline.js";
import { LlmCallRecorder } from "./llm-call-recorder.js";

export interface PiExecutionOptions extends Omit<CreateAgentSessionFromServicesOptions, "noTools" | "tools" | "excludeTools"> {
  /** Harness-owned guards. Omission retains the standard message/tool guards. */
  guards?: GuardRegistry;
  /** Receives hashes and counts, never prompt or tool contents. */
  onModelEnvelope?: (manifest: ModelEnvelopeManifest) => void;
}

/**
 * Shared Pi execution assembly. Callers provide resolved model/auth services,
 * resources, session storage and tools; this module never discovers configuration,
 * skills, memory, credentials or domain policy on the caller's behalf.
 *
 * Ordinary conversations and the compiler own their prompting/retry/completion
 * policies above this seam. Both use the same SDK lifecycle, payload conversion,
 * guards and per-request recorder below it.
 */
export async function createPiExecutionSession(options: PiExecutionOptions) {
  const { guards, onModelEnvelope, ...sessionOptions } = options;
  const result = await createAgentSessionFromServices({
    ...sessionOptions,
    // Every harness supplies its own bounded tools. Never enable SDK built-ins
    // merely because a caller omitted an allowlist.
    noTools: "builtin",
  });
  const { session } = result;

  // Restore persisted extension state for every server and headless session.
  await session.bindExtensions({});

  const modelEnvelopeManifestRef: { current?: ModelEnvelopeManifest } = {};
  const modelEnvelopeInspectionRef: { current?: ModelEnvelopeInspection } = {};
  const previousOnPayload = session.agent.onPayload;
  session.agent.onPayload = async (payload, model) => {
    const converted = convertOpenAIPdfPayload(payload);
    const next = previousOnPayload ? await previousOnPayload(converted, model) : converted;
    const finalPayload = convertOpenAIPdfPayload(next ?? converted);
    const manifest = inspectModelEnvelope(finalPayload);
    modelEnvelopeInspectionRef.current = extractModelEnvelopeInspection(finalPayload);
    const previous = modelEnvelopeManifestRef.current;
    modelEnvelopeManifestRef.current = manifest;
    if (!previous || previous.system.sha256 !== manifest.system.sha256 ||
        previous.tools.schemaSha256 !== manifest.tools.schemaSha256) {
      onModelEnvelope?.(manifest);
    }
    return finalPayload;
  };

  // Recorder stays closest to the provider: input/output guard work belongs to
  // setup/tool time rather than network latency. Preserve this wrapper order.
  const llmCallRecorder = new LlmCallRecorder();
  session.agent.streamFunction = llmCallRecorder.wrapStreamFn(session.agent.streamFunction);
  installGuardPipeline(guards ?? createGuardRegistry(options.model?.contextWindow ?? 128_000), {
    agent: session.agent,
    sessionManager: options.sessionManager,
  });

  return { ...result, llmCallRecorder, modelEnvelopeManifestRef, modelEnvelopeInspectionRef };
}
