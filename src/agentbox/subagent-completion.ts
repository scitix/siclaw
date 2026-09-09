import type { SubagentMailbox } from "./subagent-lifecycle.js";
import type { BrainSession } from "../core/brain-session.js";

/** A model turn ending is not task acceptance. Bound repairs within the caller's deadline. */
export async function runSubagentToAcceptance(options: {
  brain: BrainSession;
  prompt: string;
  assignment: string;
  mailbox?: SubagentMailbox;
  stopped: () => boolean;
  stopReason: () => string | undefined;
  reviewing: (active: boolean) => void;
}): Promise<{ accepted: boolean; reason?: string }> {
  let prompt = options.prompt;
  let repairs = 0;
  for (let turn = 0; turn < 36; turn++) {
    const guidance = await options.mailbox?.takePending();
    if (guidance) prompt += "\n\nCaller guidance:\n" + guidance;
    options.mailbox?.setReviewing(false);
    if (options.stopped()) return { accepted: false, reason: "Execution stopped" };
    await options.brain.prompt(prompt);
    if (options.stopped()) return { accepted: false, reason: "Execution stopped" };
    options.mailbox?.setReviewing(true);
    const pending = await options.mailbox?.takePending();
    if (pending) { prompt = pending; continue; }
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
        result = await options.brain.assessTaskCompletion(options.mailbox?.assignment(options.assignment) ?? options.assignment);
      } catch {
        return { accepted: false, reason: "Completion could not be verified" };
      } finally {
        options.reviewing(false);
      }
    }
    if (options.stopped()) return { accepted: false, reason: "Execution stopped" };
    const followUp = await options.mailbox?.takePending();
    if (followUp) { prompt = followUp; continue; }
    if ((result.status === "complete" || result.status === "blocked" || repairs === 2) && options.mailbox && !options.mailbox.seal()) { prompt = "Continue with the caller's latest guidance."; continue; }
    if (result.status === "complete") return { accepted: true };
    if (result.status === "blocked" || repairs++ === 2) return { accepted: false, reason: result.reason };
    prompt = "The task is not yet complete. Continue in this session using the existing evidence. " +
      "Finish the missing deliverables and return the findings, or clearly report an actual blocker. " +
      "Do not repeat completed operations.\nMissing work: " + result.reason;
  }
  return { accepted: false, reason: "Continuation budget exhausted" };
}
