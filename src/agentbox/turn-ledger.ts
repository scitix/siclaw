/**
 * Per-session turn ledger — cross-restart dispatch idempotency.
 *
 * The Runtime already de-duplicates a retried dispatch, but only in process
 * memory: after a Runtime restart the same dispatchId is unknown again and the
 * turn executes a SECOND time. The AgentBox is the right authority for that
 * question, because it is what actually runs the turn and it outlives the
 * Runtime — so it records the turnIds it has accepted, and answers a repeat
 * without starting anything.
 *
 * Stored next to JSONL and the plan/router sidecars. Remote workspace checkpoints
 * carry these files to replacement pods; local disk alone does not survive loss
 * of a pod's emptyDir.
 *
 * A missing file is the normal first-turn case. Local mode retains best-effort
 * bookkeeping for compatibility. Remote mode rejects corrupt/unreadable ledgers
 * and failed writes: treating them as empty could replay an external side effect
 * after a Pod or Runtime restart.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateWorkspaceEnabled } from "../shared/private-workspace.js";

export const TURN_LEDGER_FILE = ".turn-ledger.json";

/**
 * How many accepted turnIds to keep, most recent last. A retry arrives seconds
 * to minutes after the original, so a few hundred is far more history than
 * de-duplication needs, and it bounds the file for a long-lived session.
 */
export const TURN_LEDGER_MAX = 200;

function ledgerPath(sessionDir: string): string {
  return path.join(sessionDir, TURN_LEDGER_FILE);
}

/** Remote mode fails closed; local mode tolerates unreadable legacy ledgers. */
export function readTurnLedger(sessionDir: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(sessionDir), "utf8"));
    if (privateWorkspaceEnabled() && (!Array.isArray(raw) || raw.some(id => typeof id !== "string" || !id))) {
      throw new Error("Invalid private turn ledger");
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      if (privateWorkspaceEnabled()) throw new Error("Private turn ledger is unreadable; refusing duplicate execution", { cause: err });
      console.warn(`[turn-ledger] ${ledgerPath(sessionDir)} unreadable, treating it as empty:`, err);
    }
    return [];
  }
}

/** True when this session has already accepted `turnId`. */
export function hasAcceptedTurn(sessionDir: string, turnId: string): boolean {
  if (!turnId) return false;
  return readTurnLedger(sessionDir).includes(turnId);
}

/**
 * Records `turnId` as accepted. Synchronous and written before the turn is
 * acknowledged: a record that landed after the ack would leave the window this
 * exists to close. Written to a unique temp file and renamed, so a concurrent
 * reader never sees a truncated file.
 */
export function recordAcceptedTurn(sessionDir: string, turnId: string): void {
  if (!turnId) return;
  try {
    const existing = readTurnLedger(sessionDir).filter((id) => id !== turnId);
    existing.push(turnId);
    const kept = existing.slice(-TURN_LEDGER_MAX);
    fs.mkdirSync(sessionDir, { recursive: true });
    const file = ledgerPath(sessionDir);
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(kept)}\n`, { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw err;
    }
  } catch (err) {
    if (privateWorkspaceEnabled()) throw new Error("Private turn could not be recorded", { cause: err });
    // Best-effort: failing to record costs cross-restart de-duplication for
    // this turn, which is strictly better than failing the turn itself.
    console.warn(`[turn-ledger] could not record turn ${turnId} in ${sessionDir}:`, err);
  }
}
