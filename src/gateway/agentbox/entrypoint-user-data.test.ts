import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The entrypoint's handling of `user-data` — the only NFS-backed mount it touches.
 *
 * This block reads as needlessly elaborate next to the two `chown -R` lines around it, and the
 * obvious "simplification" back to `chown -R` is what caused a production outage: it is
 * O(the agent's entire session history) over NFS, one SETATTR round trip per file, and it runs
 * before node can log anything. It consumed the whole 60s startupProbe window; kubelet killed
 * the container; `restartPolicy: Never` made that permanent; the Runtime respawned a box that
 * met the same end, so the pool never filled.
 *
 * Nothing in the shell says any of that at runtime, and a reviewer has no way to feel the
 * difference between this directory and the emptyDirs beside it. So the shape is pinned here.
 */
const entrypoint = readFileSync(
  resolve(import.meta.dirname, "../../../docker/agentbox-entrypoint.sh"),
  "utf8",
);

/** The `user-data` block: from its marker comment to the chmod that closes it. */
function userDataBlock(): string {
  const start = entrypoint.indexOf("user_data_dir=/app/.siclaw/user-data");
  expect(start, "the user-data block").toBeGreaterThan(-1);
  const end = entrypoint.indexOf("chmod 0777", start);
  expect(end, "the chmod closing the user-data block").toBeGreaterThan(start);
  return entrypoint.slice(start, end);
}

describe("agentbox entrypoint: user-data ownership", () => {
  it("never walks the tree unconditionally", () => {
    // The emptyDirs may be chowned recursively — they are local and small. This one may not.
    expect(entrypoint).not.toMatch(/chown\s+-R\s+\S+\s+\S*\.siclaw\/user-data/);
  });

  it("guards the walk on the root's ownership, so a claimed tree costs one stat", () => {
    const block = userDataBlock();
    expect(block).toMatch(/stat -c '%u:%g'/);
    // Both halves: a root left at 1000:0 is not claimed, and checking only the uid calls it done.
    expect(block).toContain("1000:1000");
  });

  it("claims the contents BEFORE the root, so an interrupted repair resumes", () => {
    // `chown -R` does the opposite — root first, then recurse — which is precisely why it
    // cannot be resumed: killed midway it leaves the root correct and the tree half-done, and
    // every later start then skips the repair forever. Being killed midway is the failure this
    // whole block exists for, so the order is the contract.
    const block = userDataBlock();
    const contents = block.indexOf("find ");
    const root = block.indexOf('chown 1000:1000 "$user_data_dir"');
    expect(contents, "the contents walk").toBeGreaterThan(-1);
    expect(root, "the root claim").toBeGreaterThan(-1);
    expect(contents).toBeLessThan(root);
  });

  it("does not follow symlinks when claiming", () => {
    // Without -h, chown retitles the symlink's TARGET. This tree holds agent-written content,
    // so a link pointing outside it would reach a file the entrypoint has no business touching
    // — and the entrypoint is still root here.
    expect(userDataBlock()).toMatch(/chown -h 1000:1000/);
  });

  it("reports a failed claim instead of failing the box", () => {
    const block = userDataBlock();
    // Not fatal: unlike the credential checks, this is a degradation, not a lost isolation
    // property — and exiting would brick `docker run` without CAP_CHOWN.
    expect(block).not.toMatch(/exit 1/);
    // But not silent either: silence over this directory is what made the outage unreadable.
    expect(block).toMatch(/WARNING/);
  });
});
