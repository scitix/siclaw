/**
 * Every binding → prompt-body forwarding site must carry `subagentTiers`.
 *
 * The forward is a field-by-field copy at each site, never a spread, so a new
 * field reaches an entry path only if someone remembered that path. The type
 * system does not help here: `PromptOptions` declares the field as optional, so a
 * site that forwards it is checked while a site that forgets it compiles cleanly
 * and silently disables tiering for that entry form.
 *
 * Modelled on `model-api-invariants.test.ts`, which pins its own call-site count
 * for the same reason.
 *
 * ⚠️ Earlier design drafts claimed 13 sites. That number came from grepping
 * `modelRouting:` and counting every hit; three hits pass those fields to
 * `modelOptionsSupportImageInput`, a vision-capability check that must NOT carry
 * tier state, and one is a local variable declaration.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const SRC_ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");

/** Files that forward a resolved binding into an AgentBox prompt. */
const FORWARDING_FILES = [
  "portal/chat-gateway.ts",
  "portal/a2a-gateway.ts",
  "gateway/delegate-api.ts",
  "gateway/task-coordinator.ts",
  "gateway/channels/lark.ts",
  "gateway/channels/dingtalk.ts",
];

/**
 * A forwarding site, identified by the line that hands `modelRouting` over from a
 * binding. Excludes capability-check call sites, which read the same fields for a
 * different purpose.
 */
const FORWARD_LINE = /modelRouting:\s*(binding|modelBinding)\??\.modelRouting,/;
const TIER_LINE = /subagentTiers:\s*(binding|modelBinding)\??\.subagentTiers,/;
/** The vision-capability check — same fields, must not carry tier state. */
const CAPABILITY_CHECK = /modelOptionsSupportImageInput\(/;

function readSource(rel: string): string[] {
  return fs.readFileSync(path.join(SRC_ROOT, rel), "utf-8").split("\n");
}

/**
 * Count forwarding sites and report any that lack the tier field.
 *
 * A site is "covered" when a tier line appears within a few lines of the
 * modelRouting line — they are adjacent properties of one object literal.
 */
function scanForwardingSites(): { total: number; missing: string[] } {
  let total = 0;
  const missing: string[] = [];

  for (const rel of FORWARDING_FILES) {
    const lines = readSource(rel);
    for (let i = 0; i < lines.length; i++) {
      if (!FORWARD_LINE.test(lines[i])) continue;
      // Skip the capability check: walk back a few lines looking for its call.
      const preceding = lines.slice(Math.max(0, i - 6), i).join("\n");
      if (CAPABILITY_CHECK.test(preceding)) continue;

      total++;
      const window = lines.slice(Math.max(0, i - 3), i + 8).join("\n");
      if (!TIER_LINE.test(window)) missing.push(`${rel}:${i + 1}`);
    }
  }
  return { total, missing };
}

describe("subagentTiers reaches every binding forwarding site", () => {
  it("no forwarding site omits the field", () => {
    const { missing } = scanForwardingSites();
    expect(missing).toEqual([]);
  });

  it("pins the forwarding-site count (guards the scanner itself)", () => {
    // Without this the test above passes vacuously if a refactor moves a site
    // somewhere the scanner does not look.
    //
    // chat-gateway ×3, delegate-api ×2 (remote + local), a2a-gateway,
    // task-coordinator (cron), lark, dingtalk. Bump DELIBERATELY when adding an
    // entry path, and add the field there in the same change.
    const { total } = scanForwardingSites();
    expect(total).toBe(8);
  });

  it("the vision-capability check does NOT carry tier state", () => {
    // It reads modelProvider/modelId/modelConfig/modelRouting to decide whether
    // images can be sent. Tier state is unrelated, and passing it there was a
    // real mistake during implementation (caught by the type checker).
    for (const rel of ["portal/chat-gateway.ts", "gateway/channels/lark.ts"]) {
      const src = readSource(rel).join("\n");
      const checks = src.split(CAPABILITY_CHECK).slice(1);
      for (const chunk of checks) {
        const callArgs = chunk.slice(0, chunk.indexOf("})"));
        expect(callArgs).not.toContain("subagentTiers");
      }
    }
  });
});
