/**
 * Every binding → prompt forwarding site must carry `subagentTiers`.
 *
 * There are two layers and only one of them is checkable by the compiler:
 *
 *   Runtime → AgentBox   typed as `PromptOptions`, where the field is REQUIRED, so
 *                        a site that forgets it does not build. Nothing here needs
 *                        to police that layer.
 *   producer → Runtime   untyped RPC `params` objects (chat.send, delegation
 *                        dispatch, a2a). A forgotten field is legal TypeScript and
 *                        silently disables tiering for that entry path.
 *
 * This file scans the second layer.
 *
 * ⚠️ IT DISCOVERS SITES, IT DOES NOT ENUMERATE THEM. The previous version read a
 * hardcoded six-file list and matched only `modelRouting: binding.modelRouting`.
 * `gateway/server.ts` was in neither — it takes the fields off `params` and passes
 * them on as shorthand properties — so the `chat.send` path, which is THE entry
 * path under a control plane, forwarded no candidates at all. The count was pinned
 * at 8 and passed, because it counted sites inside the list it was given: a test
 * that can only confirm what its author already knew.
 *
 * A scanner that walks the tree cannot make that mistake, so the exclusions below
 * are deliberate and each states its reason.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const SRC_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/**
 * A `modelRouting` property in an object literal, in either spelling: shorthand
 * (`modelRouting,`) or explicit (`modelRouting: binding.modelRouting,`). The old
 * pattern required the explicit form off a variable named `binding`/`modelBinding`,
 * which is exactly how it missed the shorthand site that mattered.
 */
const FORWARD_LINE = /^\s*modelRouting\s*[,:]/;
const TIER_LINE = /^\s*subagentTiers\s*[,:]/;
/** The vision-capability check reads the same fields for a different purpose. */
const CAPABILITY_CHECK = /modelOptionsSupportImageInput\(/;

/**
 * Paths that carry `modelRouting` but must NOT carry tier state, with the reason.
 *
 * `cli-main.ts` — the TUI registers no `spawnSubagentExecutor` (see the comment at
 * its job-registry wiring), so it builds no sub-agents. Forwarding candidates there
 * would ship provider credentials to a surface with no consumer for them.
 */
const DELIBERATE_EXCLUSIONS = new Map<string, string>([
  ["cli-main.ts", "TUI has no spawnSubagentExecutor — no sub-agents, so no tiers"],
]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

interface Site {
  rel: string;
  line: number;
  covered: boolean;
}

function scanForwardingSites(): Site[] {
  const sites: Site[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const rel = path.relative(SRC_ROOT, file);
    if (DELIBERATE_EXCLUSIONS.has(rel)) continue;
    const lines = fs.readFileSync(file, "utf-8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!FORWARD_LINE.test(lines[i])) continue;
      // The capability check passes these same fields; walk back for its call.
      if (CAPABILITY_CHECK.test(lines.slice(Math.max(0, i - 6), i).join("\n"))) continue;
      // Adjacent properties of one object literal — a generous window, since the
      // order of properties is nobody's contract.
      const window = lines.slice(Math.max(0, i - 6), i + 10);
      sites.push({ rel, line: i + 1, covered: window.some((l) => TIER_LINE.test(l)) });
    }
  }
  return sites;
}

describe("subagentTiers reaches every binding forwarding site", () => {
  it("no discovered forwarding site omits the field", () => {
    const missing = scanForwardingSites().filter((s) => !s.covered);
    expect(missing.map((s) => `${s.rel}:${s.line}`)).toEqual([]);
  });

  it("finds sites across the whole tree, not just a curated list", () => {
    // Guards the scanner itself: if a refactor breaks the pattern this drops and
    // the assertion above starts passing vacuously.
    //
    // 10 lines in the tree match `modelRouting` as a property. Two are the
    // vision-capability check (lark, chat-gateway), one is the excluded TUI, and
    // the remaining 7 are forwarding sites: chat-gateway ×2, a2a-gateway,
    // task-coordinator (cron), lark, dingtalk, and server.ts (chat.send). Bump
    // DELIBERATELY when adding an entry path, and add the field there in the
    // same change.
    //
    // ⚠️ Was 9. delegate-api's two sites (remote + local) are gone: delegation
    // goes over A2A and the control plane dispatches the peer, so this process
    // no longer forwards a model binding to a peer box at all. The remaining
    // count dropping is the correct signal — a delegation's tiers now ride the
    // control plane's own chat.send (server.ts), which is already on this list.
    //
    // The previous, list-driven version of this test counted 8 — the missing one
    // was server.ts, and that single gap was the whole feature under a control
    // plane.
    const sites = scanForwardingSites();
    expect(sites.length).toBe(7);

    // Named explicitly, because it is the one that shipped broken: a refactor that
    // moves chat.send's forwarding must not be able to drop it silently again.
    expect(sites.some((s) => s.rel === "gateway/server.ts")).toBe(true);
  });

  it("keeps every exclusion accounted for, with a reason", () => {
    // An exclusion is a claim about the code. If the file stops existing the claim
    // is stale, and a silent skip is how an entry path disappears from coverage.
    for (const [rel, reason] of DELIBERATE_EXCLUSIONS) {
      expect(fs.existsSync(path.join(SRC_ROOT, rel)), `${rel} is excluded but absent`).toBe(true);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it("the vision-capability check does NOT carry tier state", () => {
    // It reads modelProvider/modelId/modelConfig/modelRouting to decide whether
    // images can be sent. Tier state is unrelated, and passing it there was a real
    // mistake during implementation.
    for (const rel of ["portal/chat-gateway.ts", "gateway/channels/lark.ts"]) {
      const src = fs.readFileSync(path.join(SRC_ROOT, rel), "utf-8");
      for (const chunk of src.split(CAPABILITY_CHECK).slice(1)) {
        expect(chunk.slice(0, chunk.indexOf("})"))).not.toContain("subagentTiers");
      }
    }
  });
});
