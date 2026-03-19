/**
 * Pipeline — transforms Semgrep extraction results into .sig package output.
 *
 * Phase 4: Context builder, JSONL emitter, manifest generator.
 */

export { ContextBuilder, type SourceContext } from "./context-builder.js";
export { emitRecords, recordsToJsonl, type EmitterOptions, type EmitResult } from "./emitter.js";
export { buildManifest, manifestToYaml, type ManifestOptions } from "./manifest.js";
