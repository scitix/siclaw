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
 * Stored next to the session's JSONL history, on the same volume that already
 * carries session state (see the `.plan-ledger.json` / `.model-route-state.json`
 * precedents), so it survives a pod restart for exactly as long as the
 * conversation it belongs to does.
 *
 * NON-FATAL BY DESIGN. A missing file is the normal first-turn case; a corrupt
 * or unreadable one yields an EMPTY ledger. The failure mode of an empty ledger
 * is a duplicate turn — the pre-existing behaviour — whereas refusing the prompt
 * would turn an unreadable bookkeeping file into an outage.
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

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

/** Reads the ledger; any problem reading it yields an empty one. */
export function readTurnLedger(sessionDir: string): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(sessionDir), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
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
      fs.writeFileSync(tmp, `${JSON.stringify(kept)}\n`, "utf8");
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
      throw err;
    }
  } catch (err) {
    // Best-effort: failing to record costs cross-restart de-duplication for
    // this turn, which is strictly better than failing the turn itself.
    console.warn(`[turn-ledger] could not record turn ${turnId} in ${sessionDir}:`, err);
  }
}
