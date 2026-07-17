import type { PilotMessage } from "../components/chat/types"

/**
 * Status of the LATEST delegate card whose child_session_id matches `childSessionId`.
 *
 * A CONTINUED delegation intentionally reuses one peer `child_session_id` across
 * several turns, so the timeline can hold multiple delegate cards for the same peer
 * session. The drawer's liveness must track the NEWEST card — searching from the
 * start (`Array.find`) would return the oldest card and could overwrite a freshly
 * opened running continuation with a previous card's terminal status. Search from
 * the end so the current card wins. Returns undefined when no card matches.
 */
export function latestDelegateCardStatus(
  messages: PilotMessage[],
  childSessionId: string,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    const cid = (m.toolDetails?.child_session_id ?? m.metadata?.child_session_id) as string | undefined
    if (cid === childSessionId) {
      return (m.toolDetails?.status ?? m.metadata?.status) as string | undefined
    }
  }
  return undefined
}
