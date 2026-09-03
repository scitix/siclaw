/**
 * Action digest — binds one human approval to one exact tool call.
 *
 * The problem it solves: an approval used to be a bearer token. The runtime
 * minted a signed receipt, the control plane put it in a natural-language resume
 * message, and the guard accepted it for ANY gated tool — so an approval for
 * "scale deployment A" authorised one call to "delete namespace B", and the
 * token itself travelled through the model context, the transcript and the
 * dispatch outbox on the way.
 *
 * The digest removes both halves. `propose_execution` states the EXACT call it
 * intends and sends the digest of it alongside the proposal; the re-invocation
 * after approval carries only a proposal id (plain text, not a credential) and
 * the guard recomputes the digest from the arguments the tool is about to run
 * with. A mismatch is a different action, so the approval does not apply.
 *
 * ⚠️ Only the RUNTIME ever computes a digest. The management plane stores the
 * value opaquely and compares it byte-for-byte; it never recomputes one. That is
 * deliberate: recomputation on the other side would require two languages to
 * agree forever on a canonical JSON encoding (key ordering, number formatting,
 * Unicode normalisation), and a silent disagreement there would either wave
 * through mismatched actions or reject every legitimate one. One producer, one
 * encoder, no cross-language contract to drift.
 */

import { createHash } from "node:crypto";

/**
 * Control arguments carried by a gated call for the guard's benefit, which are
 * NOT part of the action being approved and must be removed before digesting.
 * Stripped at the TOP LEVEL of the argument object only — a nested key of the
 * same name belongs to the payload the user approved (e.g. a manifest that
 * genuinely contains that field) and removing it would change the action.
 */
export const DIGEST_STRIPPED_ARGS = ["approval_proposal_id", "approval_receipt"] as const;

/**
 * Deterministic JSON encoding: object keys sorted, arrays left in order,
 * `undefined` members dropped, no whitespace.
 *
 * Keys are ordered by BYTE order of their UTF-8 encoding, not by JavaScript's
 * default string comparison. The default sort compares UTF-16 code units, which
 * orders non-BMP characters (and some CJK/emoji sequences) differently from
 * their UTF-8 bytes — so two runtimes could canonicalise the same object two
 * ways. Byte order is the encoding-independent choice.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    // Array order is part of the action ([a, b] is not [b, a]), so it is kept.
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(",")}}`;
}

/** sha256 hex over `${toolName}\n${canonicalJson(args)}`. Control fields are stripped first. */
export function actionDigest(toolName: string, args: unknown): string {
  let payload = args;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const copy: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
    for (const key of DIGEST_STRIPPED_ARGS) delete copy[key];
    payload = copy;
  }
  return createHash("sha256").update(`${toolName}\n${canonicalJson(payload)}`, "utf8").digest("hex");
}
