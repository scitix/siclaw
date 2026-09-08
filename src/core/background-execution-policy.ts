import type { SessionMode } from "./types.js";

/** Background commands require both result inspection and helper cleanup tools.
 * Respect the agent's allow-list; never add tools to work around missing capability. */
export function allowsBackgroundExec(mode: SessionMode, allowedTools?: readonly string[] | null): boolean {
  return mode !== "channel" && (!allowedTools ||
    ["task_output", "job_stop"].every(name => allowedTools.includes(name)));
}
