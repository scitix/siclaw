import { createHash } from "node:crypto";

/** IDs are Runtime-generated UUIDs, never supplied by script requests. Linux
 * RLIMIT_NPROC is host-UID scoped, so a shared UID can exhaust unrelated runs. */
export function scriptRunnerUid(instanceName: string): number {
  return 100_000 + createHash("sha256").update(instanceName).digest().readUInt32BE(0) % 2_000_000_000;
}
