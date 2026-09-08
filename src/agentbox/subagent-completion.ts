import type { BrainSession } from "../core/brain-session.js";

/** A model turn ending is not task acceptance. Bound repairs within the caller's deadline. */
export async function runSubagentToAcceptance(options: {
  brain: BrainSession;
  prompt: string;
  assignment: string;
  stopped: () => boolean;
  stopReason: () => string | undefined;
  reviewing: (active: boolean) => void;
}): Promise<{ accepted: boolean; reason?: string }> {
  let prompt = options.prompt;
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (options.stopped()) return { accepted: false, reason: "Execution stopped" };
    await options.brain.prompt(prompt);
    if (options.stopped()) return { accepted: false, reason: "Execution stopped" };
    const stop = options.stopReason();
    if (stop === "error" || stop === "aborted") {
      return { accepted: false, reason: `Model execution ended with ${stop}` };
    }
    let result;
    if (stop === "length") {
      result = { status: "incomplete", reason: "The model response hit its output limit. Continue from the interrupted result without repeating completed work." };
    } else {
      if (!options.brain.assessTaskCompletion) return { accepted: false, reason: "Completion assessment unavailable" };
      options.reviewing(true);
      try {
        result = await options.brain.assessTaskCompletion(options.assignment);
      } catch {
        return { accepted: false, reason: "Completion could not be verified" };
      } finally {
        options.reviewing(false);
      }
    }
    if (options.stopped()) return { accepted: false, reason: "Execution stopped" };
    if (result.status === "complete") return { accepted: true };
    if (result.status === "blocked" || attempt === 2) return { accepted: false, reason: result.reason };
    prompt = "The task is not yet complete. Continue in this session using the existing evidence. " +
      "Finish the missing deliverables and return the findings, or clearly report an actual blocker. " +
      "Do not repeat completed operations.\nMissing work: " + result.reason;
  }
  return { accepted: false, reason: "Continuation budget exhausted" };
}
