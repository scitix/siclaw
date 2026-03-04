import { EventEmitter } from "events";
import type { ProgressEvent } from "./sub-agent.js";

/**
 * Global singleton EventEmitter bridging deep-search tool progress
 * to the extension layer (deep-investigation extension).
 *
 * - tool.ts emits "progress" events during investigate()
 * - deep-investigation extension listens and renders to terminal UI
 */
export const deepSearchEvents = new EventEmitter();
export type { ProgressEvent };

/** Gate: blocks deep_search until user confirms hypotheses in gateway mode */
export const deepSearchGate = { blocked: false };
