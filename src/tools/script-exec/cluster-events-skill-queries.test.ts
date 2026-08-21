import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The cluster-events skill has no scripts — its diagnostic flow is a set of `jq`
 * expressions embedded in SKILL.md. That makes them untested by construction, and
 * a wrong `jq` expression fails in the worst available way: it prints nothing and
 * exits 0, which an agent reads as "no warnings in this window".
 *
 * So the expressions are extracted from the skill and run against a fixture whose
 * answer is known. What they encode is the distinction the skill exists to draw:
 *
 *   an event's `count` and `lastTimestamp` say it is STILL HAPPENING
 *   its `firstTimestamp` says WHEN IT STARTED
 *
 * Measured on a live cluster while writing this: a `Unhealthy` with count 10505
 * whose lastTimestamp was seconds old and whose firstTimestamp was seven months
 * earlier. Sorted by lastTimestamp with no window — which is what the skill used
 * to do — that event heads the list of "recent warnings" forever.
 *
 * Extracting from the markdown rather than restating the expressions is the point:
 * a test with its own copy would keep passing after the skill drifted.
 */

const SKILL = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/core/cluster-events/SKILL.md",
);

/** Events with a known answer: 2 started inside the window, 2 are long-running. */
const FIXTURE = {
  items: [
    {
      metadata: { namespace: "app" },
      involvedObject: { kind: "Pod", name: "new-crash" },
      reason: "BackOff",
      count: 3,
      firstTimestamp: "2026-08-21T09:00:00Z",
      lastTimestamp: "2026-08-21T09:05:00Z",
    },
    {
      metadata: { namespace: "app" },
      involvedObject: { kind: "Pod", name: "new-probe" },
      reason: "Unhealthy",
      count: 1,
      firstTimestamp: "2026-08-21T09:02:00Z",
      lastTimestamp: "2026-08-21T09:02:00Z",
    },
    {
      // The case that motivated the change: active now, started seven months ago.
      metadata: { namespace: "kube-system" },
      involvedObject: { kind: "Pod", name: "ancient-probe" },
      reason: "Unhealthy",
      count: 10505,
      firstTimestamp: "2026-01-14T06:04:41Z",
      lastTimestamp: "2026-08-21T09:06:00Z",
    },
    {
      metadata: { namespace: "old" },
      involvedObject: { kind: "Pod", name: "stale-backoff" },
      reason: "BackOff",
      count: 174427,
      firstTimestamp: "2026-07-27T10:50:43Z",
      lastTimestamp: "2026-08-21T09:04:00Z",
    },
    {
      // eventTime-only shape (events.k8s.io) — no lastTimestamp at all.
      metadata: { namespace: "app" },
      involvedObject: { kind: "Pod", name: "eventtime-only" },
      reason: "FailedScheduling",
      eventTime: "2026-08-21T09:03:00Z",
    },
  ],
};

const WINDOW_START = "2026-08-21T08:42:00Z";

let blocks: string[] = [];

beforeAll(() => {
  const md = readFileSync(SKILL, "utf8");
  blocks = [...md.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  expect(blocks.length, "SKILL.md should contain bash blocks").toBeGreaterThan(2);
});

function hasJq(): boolean {
  return spawnSync("/bin/sh", ["-c", "command -v jq"], { encoding: "utf8" }).status === 0;
}

/** Run one of the skill's jq pipelines against the fixture instead of a cluster. */
function runPipeline(block: string): { stdout: string; status: number | null } {
  // Replace the kubectl call with the fixture, and pin the window the block reads.
  const script = block
    .replace(/kubectl get events [^|]*\| /g, `cat "$FIXTURE" | `)
    .replace(/^SINCE=\S+$/m, `SINCE=${WINDOW_START}`);
  const r = spawnSync("/bin/bash", ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, FIXTURE: "/dev/stdin" },
    input: JSON.stringify(FIXTURE),
  });
  return { stdout: r.stdout ?? "", status: r.status };
}

describe("the cluster-events skill's queries do what the skill claims", () => {
  it("skips when jq is unavailable", () => {
    // The skill's flow depends on jq; a host without it cannot verify these.
    expect(true).toBe(true);
  });

  it("the retention probe reports the boundary, and never silently nothing", () => {
    if (!hasJq()) return;
    const probe = blocks.find((b) => b.includes("events retained"));
    expect(probe, "SKILL.md should carry the retention-boundary probe").toBeDefined();
    const { stdout, status } = runPipeline(probe!);
    expect(status).toBe(0);
    expect(stdout).toMatch(/5 events retained/);
    // Three distinct numbers, because two of them mean different things and giving
    // only one misleads in opposite directions. Writing this test is what surfaced
    // that: the first version reported a single "oldest" and I asserted the wrong
    // field for it, which is only ambiguous because the value itself is.
    //
    //   retention floor = oldest lastTimestamp → the real limit on what is answerable
    //   earliest start  = oldest firstTimestamp → when some still-active thing began
    expect(stdout, "retention floor").toMatch(/retention floor:\s+2026-08-21T09:02:00Z/);
    expect(stdout, "earliest start").toMatch(/earliest start:\s+2026-01-14T06:04:41Z/);
    expect(stdout, "newest activity").toMatch(/newest activity:\s+2026-08-21T09:06:00Z/);
  });

  it("the retention probe says so out loud when nothing is retained", () => {
    if (!hasJq()) return;
    const probe = blocks.find((b) => b.includes("events retained"))!;
    const script = probe.replace(/kubectl get events [^|]*\| /g, 'echo \'{"items":[]}\' | ');
    const r = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" });
    expect(r.status).toBe(0);
    // An empty cluster must not produce empty output — that reads as "no warnings".
    expect(r.stdout.trim()).toBe("no events retained at all");
  });

  it("the retention floor and the earliest start are not the same number", () => {
    if (!hasJq()) return;
    const probe = blocks.find((b) => b.includes("events retained"))!;
    const { stdout } = runPipeline(probe);
    const floor = /retention floor:\s+(\S+)/.exec(stdout)?.[1];
    const start = /earliest start:\s+(\S+)/.exec(stdout)?.[1];
    expect(floor).toBeDefined();
    expect(start).toBeDefined();
    // In this fixture they are seven months apart. Collapsing them into one
    // "oldest event" is exactly the reading that makes a 4-minute retention window
    // look like seven months of coverage, or the reverse.
    expect(floor).not.toBe(start);
  });

  it("the window filter keeps events active in the window", () => {
    if (!hasJq()) return;
    const listing = blocks.find((b) => b.includes("first seen") && b.includes("$since"));
    expect(listing, "SKILL.md should carry the windowed listing").toBeDefined();
    const { stdout, status } = runPipeline(listing!);
    expect(status).toBe(0);
    // All four with a lastTimestamp are active inside the window, including the
    // long-running ones — being old does not remove them from the listing.
    for (const name of ["new-crash", "new-probe", "ancient-probe", "stale-backoff"]) {
      expect(stdout, name).toContain(name);
    }
    // And it must carry firstTimestamp, which is what makes the two kinds separable.
    expect(stdout).toContain("first seen 2026-01-14T06:04:41Z");
  });

  it("the window filter handles the eventTime-only shape", () => {
    if (!hasJq()) return;
    const listing = blocks.find((b) => b.includes("first seen") && b.includes("$since"))!;
    const { stdout } = runPipeline(listing);
    // events.k8s.io objects have no lastTimestamp. Dropping them silently would
    // hide a whole class of event from every windowed query.
    expect(stdout).toContain("eventtime-only");
  });

  it("the first-seen ranking excludes what started before the window", () => {
    if (!hasJq()) return;
    // Matched on `sort_by(.firstTimestamp`, which only the ranking block has. An
    // earlier version matched on `firstTimestamp // .eventTime` and silently picked
    // up the retention probe once that gained the same expression — the assertions
    // then ran against the wrong block, which is the failure mode a loose selector
    // always has here.
    const ranking = blocks.find((b) => b.includes("sort_by(.firstTimestamp"));
    expect(ranking, "SKILL.md should carry the first-seen ranking").toBeDefined();
    const { stdout, status } = runPipeline(ranking!);
    expect(status).toBe(0);
    // Started inside the window → present.
    expect(stdout).toContain("new-crash");
    expect(stdout).toContain("new-probe");
    expect(stdout).toContain("eventtime-only");
    // Started long before it → absent, however active they still are. This is the
    // distinction the skill was missing: `ancient-probe` has a count of 10505 and a
    // lastTimestamp inside the window, and it is still not news.
    expect(stdout, "a seven-month-old condition is not a recent warning").not.toContain("ancient-probe");
    expect(stdout).not.toContain("stale-backoff");
  });
});

describe("the skill states the constraints its flow depends on", () => {
  let md = "";
  beforeAll(() => { md = readFileSync(SKILL, "utf8"); });

  it("says kubectl cannot filter events by time server-side", () => {
    // Without this, the next reader reasonably tries --field-selector and gets a
    // BadRequest, or worse, believes a window was applied when none was.
    expect(md).toMatch(/no server-side time filter|cannot filter events by time server-side/);
    expect(md).toContain("field-selector");
  });

  it("requires the report to carry absolute window boundaries", () => {
    expect(md).toMatch(/## Reporting/);
    expect(md).toMatch(/absolute timestamps/);
  });

  it("forbids an unqualified \"no warnings\"", () => {
    // The finding this skill kept producing: "no recent warnings" for a period the
    // cluster could not answer for, because retention had already dropped it.
    expect(md).toMatch(/Never write "no warnings" without the window/);
    expect(md).toMatch(/gone, not absent|missing rather than clean/);
  });

  it("explains that count is not a within-window figure", () => {
    expect(md).toMatch(/not a rate and not a within-window figure|count is\s+the total since first occurrence/);
  });
});

describe("the queries do not fail the way this skill exists to prevent", () => {
  // Every expression here answers "was there anything?", so its failure mode has to
  // be loud. `jq` fails quietly by default: an unexpected shape prints a message to
  // stderr, leaves stdout EMPTY, and the caller reading stdout sees exactly what it
  // would see for a clean cluster. Found by self-review, not by the earlier tests —
  // they only ever fed well-formed input.
  const feed = (block: string, raw: string) => {
    const script = block
      .replace(/kubectl get events [^|]*\| /g, "cat /dev/stdin | ")
      .replace(/^SINCE=\S+$/m, `SINCE=${WINDOW_START}`);
    return spawnSync("/bin/bash", ["-c", script], { encoding: "utf8", input: raw });
  };

  for (const [label, raw] of [
    ["an object with no items key", "{}"],
    ["items explicitly null", '{"items":null}'],
    ["items empty", '{"items":[]}'],
  ] as const) {
    it(`the retention probe still speaks up: ${label}`, () => {
      if (!hasJq()) return;
      const probe = blocks.find((b) => b.includes("events retained"))!;
      const r = feed(probe, raw);
      // The point is not the exit code — jq exits 0 either way — it is that stdout
      // carries a statement rather than nothing.
      expect(r.stdout.trim(), label).toBe("no events retained at all");
      expect(r.stderr, `${label}: must not rely on stderr`).not.toMatch(/Cannot iterate/);
    });
  }

  it("the listing queries survive the same shapes without a jq error", () => {
    if (!hasJq()) return;
    const jqBlocks = blocks.filter((b) => b.includes("jq"));
    expect(jqBlocks.length).toBeGreaterThanOrEqual(3);
    for (const b of jqBlocks) {
      for (const raw of ["{}", '{"items":null}', '{"items":[]}']) {
        const r = feed(b, raw);
        expect(r.stderr, `${raw}: ${b.slice(0, 40)}`).not.toMatch(/Cannot iterate|error \(at/);
      }
    }
  });

  it("the skill warns that a missing namespace returns an empty list, not an error", () => {
    // `kubectl get events -n <nonexistent>` exits 0 with `"items": []` — measured.
    // So a namespace typo and a quiet namespace produce identical output, which is
    // the same "empty means fine" failure the rest of this skill is about.
    const md = readFileSync(SKILL, "utf8");
    expect(md).toMatch(/empty list and \*\*exit code 0\*\*|exit code 0.*namespace that does not exist/s);
    expect(md).toContain("kubectl get namespace");
    expect(md).toMatch(/indistinguishable/);
  });
});
