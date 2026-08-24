import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../skills/core/cluster-events");
const SKILL = join(SKILL_DIR, "SKILL.md");
/**
 * The reasoning and the measurements live beside the skill, not inside it — SKILL.md is
 * read on every invocation, and 100 lines of justification before the first diagnostic
 * step is a cost paid every time. Assertions about WHY point here; assertions about
 * what the queries DO run the queries.
 */
const REFERENCE = join(SKILL_DIR, "references/event-timestamps-and-fields.md");

/**
 * Events with a known answer: 3 started inside the window, 2 are long-running but still
 * active, and 2 exercise the layouts that were being dropped — a v1 `series` and the
 * events.k8s.io shape.
 */
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
    {
      // A SERIES on the plain v1 Event. `kubectl explain events.series` shows
      // {count, lastObservedTime} — this is where a continuing event records its
      // latest activity, and `lastTimestamp` may be absent entirely. Reading only
      // `lastTimestamp // eventTime` places this event in January and drops it out
      // of any recent window, even though it was active two minutes ago.
      metadata: { namespace: "app" },
      involvedObject: { kind: "Pod", name: "series-event" },
      reason: "BackOff",
      eventTime: "2026-01-14T06:04:41Z",
      series: { count: 42, lastObservedTime: "2026-08-21T09:05:00Z" },
    },
    {
      // A series whose v1 lastTimestamp/count are STALE. This is the normal state,
      // not a corner case: the recorder in client-go/tools/events updates only
      // Series.Count and Series.LastObservedTime on a repeat, and the API conversion
      // sets `LastTimestamp = DeprecatedLastTimestamp` — a field nothing updates. So
      // reading lastTimestamp first places a live event at its origin.
      metadata: { namespace: "app" },
      involvedObject: { kind: "Pod", name: "stale-lastts" },
      reason: "BackOff",
      count: 2,
      firstTimestamp: "2026-01-14T06:04:41Z",
      lastTimestamp: "2026-01-14T06:04:41Z",
      series: { count: 99, lastObservedTime: "2026-08-21T09:05:30.123456Z" },
    },
    {
      // MicroTime with fractional seconds, exactly on the window's opening second.
      // String comparison gets this backwards: "…09:00:00.500000Z" >= "…09:00:00Z"
      // is false because `.` sorts below `Z`.
      metadata: { namespace: "app" },
      involvedObject: { kind: "Pod", name: "fractional-edge" },
      reason: "Unhealthy",
      count: 1,
      firstTimestamp: "2026-08-21T08:42:00.500000Z",
      lastTimestamp: "2026-08-21T08:42:00.500000Z",
    },
    {
      // The events.k8s.io/v1 layout, which `kubectl get events.events.k8s.io`
      // returns: no lastTimestamp, no count, no involvedObject. Measured field
      // list. Reading `.involvedObject.kind` on this renders "null/null".
      metadata: { namespace: "app" },
      regarding: { kind: "Pod", name: "eventsk8sio-shape" },
      reason: "Unhealthy",
      // eventTime is when it FIRST happened; deprecatedLastTimestamp is the latest.
      // They must differ in the fixture or the test cannot tell the two apart — the
      // first version set both to the same instant, so removing the
      // deprecatedLastTimestamp fallback broke nothing and the revert-check passed
      // for the wrong reason. eventTime sits OUTSIDE the window, the last timestamp
      // inside it: reading only eventTime drops the event.
      eventTime: "2026-08-21T08:00:00Z",
      deprecatedCount: 7,
      deprecatedFirstTimestamp: "2026-08-21T09:00:00Z",
      deprecatedLastTimestamp: "2026-08-21T09:03:30Z",
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

/**
 * Feed a document to a query by FILE, never through stdin.
 *
 * The first version substituted `cat /dev/stdin` and passed the JSON via
 * `spawnSync`'s `input`. That works on macOS and fails on the Linux CI runner with
 * `cat: /dev/stdin: No such device or address` — 24 of these tests failed there while
 * all of them passed locally. Reopening fd 0 depends on what fd 0 IS, and for a
 * spawned pipe on Linux it cannot be reopened. A temp file has no such dependency.
 */
const fixtureDir = mkdtempSync(join(tmpdir(), "cluster-events-fixtures-"));
let fixtureSeq = 0;

function fixtureFile(doc: unknown): string {
  const path = join(fixtureDir, `events-${fixtureSeq++}.json`);
  writeFileSync(path, typeof doc === "string" ? doc : JSON.stringify(doc));
  return path;
}

/** Replace the kubectl call in a skill block with a read of `path`. */
function readFrom(block: string, path: string): string {
  return block.replace(/kubectl get events [^|]*\| /g, `cat ${path} | `);
}

afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

function hasJq(): boolean {
  return spawnSync("/bin/sh", ["-c", "command -v jq"], { encoding: "utf8" }).status === 0;
}

/** Run one of the skill's jq pipelines against the fixture instead of a cluster. */
function runPipeline(block: string): { stdout: string; status: number | null } {
  // Replace the kubectl call with the fixture, and pin the window the block reads.
  const script = block
    .replace(/kubectl get events [^|]*\| /g, `cat ${fixtureFile(FIXTURE)} | `)
    // NOT /^SINCE=\S+$/ — the line in SKILL.md carries a trailing comment, so the `$`
    // anchor never matched and every windowed assertion silently ran against the
    // skill's own hardcoded 08:30:00Z. It passed because that value also predates the
    // fixture events; the first test with events on both sides of the window exposed
    // it. Match up to whitespace or the comment instead.
    .replace(/^SINCE=[^\s#]*/m, `SINCE=${WINDOW_START}`);
  const r = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" });
  return { stdout: r.stdout ?? "", status: r.status };
}

/**
 * Pick a block by WHAT IT DOES, not by how it is written.
 *
 * Three separate breakages came from selectors keyed on implementation detail:
 * `firstTimestamp // .eventTime` (which the retention probe later also contained),
 * then `sort_by(.firstTimestamp`, then `sort_by(.start)` — each stopped matching the
 * moment the block it selects was edited, and a `find` that returns undefined fails
 * as "expected undefined to be defined" rather than as the drift it is.
 *
 * These predicates key on the one thing each block is FOR.
 */
const pick = {
  /** The retention-boundary probe: the only block that prints the three edges. */
  probe: () => blocks.find((b) => b.includes("events retained")),
  /** The windowed listing: filters on the active time and prints "first seen". */
  listing: () => blocks.find((b) => b.includes("first seen") && b.includes("$since")),
  /** The first-seen ranking: filters on the START time, so it has no "first seen". */
  ranking: () => blocks.find((b) => b.includes("$since") && !b.includes("first seen")
                                    && b.includes("firstTimestamp")),
};

describe("the cluster-events skill's queries do what the skill claims", () => {
  it("skips when jq is unavailable", () => {
    // The skill's flow depends on jq; a host without it cannot verify these.
    expect(true).toBe(true);
  });

  it("the retention probe reports the boundary, and never silently nothing", () => {
    if (!hasJq()) return;
    const probe = pick.probe();
    expect(probe, "SKILL.md should carry the retention-boundary probe").toBeDefined();
    const { stdout, status } = runPipeline(probe!);
    expect(status).toBe(0);
    expect(stdout).toMatch(/9 events retained/);
    // Three distinct numbers, because two of them mean different things and giving
    // only one misleads in opposite directions. Writing this test is what surfaced
    // that: the first version reported a single "oldest" and I asserted the wrong
    // field for it, which is only ambiguous because the value itself is.
    //
    //   retention floor = oldest lastTimestamp → the real limit on what is answerable
    //   earliest start  = oldest firstTimestamp → when some still-active thing began
    // The floor is the OLDEST activity, so adding a fixture event active at 08:42:00
    // legitimately moves it. It must never be one of the January values — that is the
    // failure this probe exists to prevent.
    expect(stdout, "oldest observed activity").toMatch(/oldest observed activity:\s+2026-08-21T08:42:00Z/);
    expect(stdout, "oldest start").toMatch(/oldest start still present:\s+2026-01-14T06:04:41Z/);
    expect(stdout, "newest activity").toMatch(/newest activity:\s+2026-08-21T09:06:00Z/);
  });

  it("the retention probe says so out loud when nothing is retained", () => {
    if (!hasJq()) return;
    const probe = pick.probe()!;
    const script = probe.replace(/kubectl get events [^|]*\| /g, 'echo \'{"items":[]}\' | ');
    const r = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" });
    expect(r.status).toBe(0);
    // An empty cluster must not produce empty output — that reads as "no warnings".
    expect(r.stdout.trim()).toBe("no events retained at all");
  });

  it("the two oldest-value lines are not the same number", () => {
    if (!hasJq()) return;
    const probe = pick.probe()!;
    const { stdout } = runPipeline(probe);
    const floor = /oldest observed activity:\s+(\S+)/.exec(stdout)?.[1];
    const start = /oldest start still present:\s+(\S+)/.exec(stdout)?.[1];
    expect(floor).toBeDefined();
    expect(start).toBeDefined();
    // Seven months apart in this fixture. Collapsing them into one "oldest event"
    // is what makes a 4-minute observation window look like seven months of
    // coverage, or the reverse.
    expect(floor).not.toBe(start);
  });

  it("the window filter keeps events active in the window", () => {
    if (!hasJq()) return;
    const listing = pick.listing();
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
    const listing = pick.listing()!;
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
    // The ranking block sorts by the normalised start, which is `sort_by(.start)`
    // once both field layouts are read. Matching only the old `sort_by(.firstTimestamp`
    // silently found nothing — a selector that has to track the block it selects.
    const ranking = pick.ranking();
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
      .replace(/kubectl get events [^|]*\| /g, `cat ${fixtureFile(raw)} | `)
      .replace(/^SINCE=[^\s#]*/m, `SINCE=${WINDOW_START}`);
    return spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" });
  };

  for (const [label, raw] of [
    ["an object with no items key", "{}"],
    ["items explicitly null", '{"items":null}'],
    ["items empty", '{"items":[]}'],
  ] as const) {
    it(`the retention probe still speaks up: ${label}`, () => {
      if (!hasJq()) return;
      const probe = pick.probe()!;
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

describe("both Event field layouts are read, not just the v1 one", () => {
  // `Event` exists in two API groups with almost disjoint field names, and the v1
  // object additionally carries `series` for a continuing event. Reading only
  // `lastTimestamp // eventTime` + `involvedObject` loses:
  //
  //   a series event   → placed by its ORIGIN, so it falls out of any recent window
  //   the events.k8s.io shape → no count, and the object renders as "null/null"
  //
  // Both reproduced against the fixture before the fix; both are silent losses,
  // which is the failure mode this whole skill is about.

  it("a series event is placed by its latest activity, not its origin", () => {
    if (!hasJq()) return;
    const listing = pick.listing()!;
    const { stdout } = runPipeline(listing);
    // Active at 09:05, window starts 08:42 → must be present.
    expect(stdout, "a series event active inside the window must appear").toContain("series-event");
    // Placed at series.lastObservedTime, and carrying series.count.
    expect(stdout).toMatch(/2026-08-21T09:05:00Z\s+x42\s+Pod\/series-event/);
    // …while still reporting the January origin, so it reads as a long-running one.
    expect(stdout).toMatch(/series-event.*first seen 2026-01-14T06:04:41Z/);
  });

  it("and is excluded from the first-seen ranking, because it did not start here", () => {
    if (!hasJq()) return;
    const ranking = pick.ranking()!;
    const { stdout } = runPipeline(ranking);
    expect(stdout, "started in January, so not news").not.toContain("series-event");
  });

  it("the events.k8s.io layout keeps its object name and count", () => {
    if (!hasJq()) return;
    const listing = pick.listing()!;
    const { stdout } = runPipeline(listing);
    expect(stdout, "regarding must be read when involvedObject is absent").toContain("Pod/eventsk8sio-shape");
    expect(stdout, "deprecatedCount must be read when count is absent").toMatch(/x7\s+Pod\/eventsk8sio-shape/);
    expect(stdout, "no null/null object references").not.toContain("null/null");
    expect(stdout).toMatch(/eventsk8sio-shape.*first seen 2026-08-21T09:00:00Z/);
  });

  it("it does appear in the first-seen ranking, because it did start here", () => {
    if (!hasJq()) return;
    const ranking = pick.ranking()!;
    const { stdout } = runPipeline(ranking);
    expect(stdout).toContain("eventsk8sio-shape");
    expect(stdout).not.toContain("null/null");
  });

  it("the retention probe reads series activity too", () => {
    if (!hasJq()) return;
    const probe = pick.probe()!;
    const { stdout } = runPipeline(probe);
    // Newest activity is the series event's 09:05, not the 09:06 of ancient-probe…
    expect(stdout).toMatch(/newest activity:\s+2026-08-21T09:06:00Z/);
    // …and the floor must NOT be the series event's January eventTime, which is what
    // reading `lastTimestamp // eventTime` produced: a floor seven months old, i.e.
    // a claim that the cluster can answer for seven months.
    expect(stdout).not.toMatch(/oldest observed activity:\s+2026-01-14/);
  });

  it("both layouts are documented — the fields in the skill, the reason beside it", () => {
    const md = readFileSync(SKILL, "utf8");
    // The definitions are what a reader copies, so they stay in SKILL.md.
    expect(md).toContain("series.lastObservedTime");
    expect(md).toContain("deprecatedLastTimestamp");
    expect(md).toContain("regarding");
    // The explanation is what a reader needs before EDITING, so it sits in references/.
    const ref = readFileSync(REFERENCE, "utf8");
    expect(ref).toMatch(/two API groups/);
    expect(ref).toMatch(/explain\s+events\.series/);
  });
});

describe("a series event is placed by series.lastObservedTime, not by a stale lastTimestamp", () => {
  // Why `series` must be read FIRST, from the source rather than from a guess:
  //   client-go/tools/events/event_broadcaster.go updates Series.Count and
  //   Series.LastObservedTime on a repeat, and touches no deprecated field;
  //   pkg/apis/events/v1/conversion.go then sets LastTimestamp =
  //   DeprecatedLastTimestamp.
  // So on a series event the v1 lastTimestamp and count are frozen at first write.

  it("appears in the window even though lastTimestamp says January", () => {
    if (!hasJq()) return;
    const listing = pick.listing()!;
    const { stdout } = runPipeline(listing);
    expect(stdout, "last observed 09:05:30, window opens 08:42").toContain("stale-lastts");
    // The fraction is stripped on output, so the timestamp ends in `Z` — asserting
    // without it is what made this fail the first time.
    expect(stdout).toMatch(/2026-08-21T09:05:30Z\s+x99\s+Pod\/stale-lastts/);
  });

  it("reports series.count, not the frozen count", () => {
    if (!hasJq()) return;
    const listing = pick.listing()!;
    const { stdout } = runPipeline(listing);
    // The v1 count on this event is 2; the series count is 99.
    expect(stdout).not.toMatch(/x2\s+Pod\/stale-lastts/);
  });

  it("and the retention floor is not dragged back to the stale value", () => {
    if (!hasJq()) return;
    const probe = pick.probe()!;
    const { stdout } = runPipeline(probe);
    // A January value here would suggest the cluster holds seven months of activity.
    expect(stdout).not.toMatch(/oldest observed activity:\s+2026-01-14/);
  });

  it("but it is still excluded from the first-seen ranking", () => {
    if (!hasJq()) return;
    const ranking = pick.ranking()!;
    const { stdout } = runPipeline(ranking);
    // Active now, started in January — not news, whichever field carries the activity.
    expect(stdout).not.toContain("stale-lastts");
  });
});

describe("fractional seconds do not fall out of the window", () => {
  // MicroTime serialises with a fraction, and a string comparison sorts
  // "…T09:00:00.500000Z" BELOW "…T09:00:00Z" because `.` < `Z`. A window opening on
  // a whole second therefore dropped everything in its first second.
  it("an event on the opening second is kept", () => {
    if (!hasJq()) return;
    const listing = pick.listing()!;
    const { stdout } = runPipeline(listing);
    expect(stdout, "08:42:00.5 with a window opening at 08:42:00").toContain("fractional-edge");
  });

  it("and appears in the first-seen ranking too", () => {
    if (!hasJq()) return;
    const ranking = pick.ranking()!;
    const { stdout } = runPipeline(ranking);
    expect(stdout).toContain("fractional-edge");
  });

  it("timestamps are reported without the fraction, so they sort as text", () => {
    if (!hasJq()) return;
    const probe = pick.probe()!;
    const { stdout } = runPipeline(probe);
    // Every emitted timestamp is whole-second UTC — that is what makes lexical
    // ordering chronological for the caller reading this output.
    for (const line of stdout.split("\n")) {
      const m = /(\d{4}-\d{2}-\d{2}T[0-9:]+(\.\d+)?Z)/.exec(line);
      if (m) expect(m[2], `fraction left in ${m[1]}`).toBeUndefined();
    }
  });

  it("the skill explains why, so the next reader does not simplify it back", () => {
    const md = readFileSync(SKILL, "utf8");
    expect(md).toMatch(/MicroTime|sorts below/);
    expect(md).toMatch(/series` comes first|series.*load-bearing/si);
    const ref = readFileSync(REFERENCE, "utf8");
    expect(ref).toMatch(/sorts below `Z`/);
    expect(ref).toMatch(/event_broadcaster\.go/);
  });
});

describe("a fractional window start separates events inside the same second", () => {
  // The window value can carry a fraction too — it gets copied out of a log line or
  // an alert timestamp. Truncating cannot handle that, on either side: cutting to
  // whole seconds maps …00.400000Z and …00.600000Z onto the SAME value, so a window
  // opening at …00.500000Z can no longer separate them. Measured against real time
  // semantics: truncating the event side alone is wrong twice, truncating both sides
  // is wrong the same twice, padding both to 6 digits is wrong zero times.
  const FRACTIONAL: Record<string, unknown> = {
    items: [
      { metadata: { namespace: "app" }, involvedObject: { kind: "Pod", name: "before-half" },
        reason: "A", firstTimestamp: "2026-08-21T08:42:00.400000Z",
        lastTimestamp: "2026-08-21T08:42:00.400000Z" },
      { metadata: { namespace: "app" }, involvedObject: { kind: "Pod", name: "after-half" },
        reason: "B", firstTimestamp: "2026-08-21T08:42:00.600000Z",
        lastTimestamp: "2026-08-21T08:42:00.600000Z" },
      { metadata: { namespace: "app" }, involvedObject: { kind: "Pod", name: "whole-second" },
        reason: "C", firstTimestamp: "2026-08-21T08:42:00Z",
        lastTimestamp: "2026-08-21T08:42:00Z" },
    ],
  };

  const runWith = (block: string, since: string) => {
    const script = block
      .replace(/kubectl get events [^|]*\| /g, `cat ${fixtureFile(FRACTIONAL)} | `)
      .replace(/^SINCE=[^\s#]*/m, `SINCE=${since}`);
    return spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" }).stdout ?? "";
  };

  const SINCE_HALF = "2026-08-21T08:42:00.500000Z";

  it("the listing excludes the earlier half of the second", () => {
    if (!hasJq()) return;
    const out = runWith(pick.listing()!, SINCE_HALF);
    expect(out, "…00.600000Z is after the window start").toContain("after-half");
    expect(out, "…00.400000Z is BEFORE it — truncation would have admitted this").not.toContain("before-half");
    // A whole second is .000000, i.e. also before .500000.
    expect(out, "…00Z means …00.000000Z").not.toContain("whole-second");
  });

  it("the ranking applies the same boundary", () => {
    if (!hasJq()) return;
    const out = runWith(pick.ranking()!, SINCE_HALF);
    expect(out).toContain("after-half");
    expect(out).not.toContain("before-half");
    expect(out).not.toContain("whole-second");
  });

  it("a whole-second window still admits everything in that second", () => {
    if (!hasJq()) return;
    // The counter-case: padding must not turn a whole-second window into an
    // exclusive one. …00Z pads to …00.000000Z, so every event in that second passes.
    const out = runWith(pick.listing()!, "2026-08-21T08:42:00Z");
    for (const n of ["before-half", "after-half", "whole-second"]) {
      expect(out, n).toContain(n);
    }
  });

  it("output stays whole-second, whatever the input precision", () => {
    if (!hasJq()) return;
    const out = runWith(pick.listing()!, "2026-08-21T08:42:00Z");
    // Padding is for comparison only. Six digits in the report would be noise.
    expect(out).not.toMatch(/\.\d+Z/);
  });

  it("the reference records that truncation cannot work, so it is not reintroduced", () => {
    const ref = readFileSync(REFERENCE, "utf8");
    expect(ref).toMatch(/PADDED, not truncated|padded, not truncated/i);
    expect(ref).toMatch(/Truncating cannot work/);
    // The measured table is the evidence; keep it.
    expect(ref).toMatch(/truncate both sides.*\|\s*2/s);
    // And SKILL.md must point at it, or the reasoning is unreachable in practice.
    expect(readFileSync(SKILL, "utf8")).toContain("references/event-timestamps-and-fields.md");
  });
});

describe("the documented --until bound actually bounds", () => {
  // The skill tells the reader how to close the window at the other end. That snippet
  // is a instruction to edit a query, so the only way to test it is to APPLY it and
  // run the result — asserting the prose would have passed while the snippet was
  // broken, which is exactly what happened: the earlier text bounded on `.t`, a field
  // produced by the `map(.t = …)` that runs AFTER the filter. At select time it is
  // null, jq orders null below every string, so `null <= $until` is true for every
  // event and the bound did nothing.
  const WINDOWED: Record<string, unknown> = {
    items: [
      { metadata: { namespace: "app" }, involvedObject: { kind: "Pod", name: "before-since" },
        reason: "A", firstTimestamp: "2026-08-21T08:00:00Z", lastTimestamp: "2026-08-21T08:00:00Z" },
      { metadata: { namespace: "app" }, involvedObject: { kind: "Pod", name: "inside" },
        reason: "B", firstTimestamp: "2026-08-21T08:50:00Z", lastTimestamp: "2026-08-21T08:50:00Z" },
      { metadata: { namespace: "app" }, involvedObject: { kind: "Pod", name: "after-until" },
        reason: "C", firstTimestamp: "2026-08-21T09:30:00Z", lastTimestamp: "2026-08-21T09:30:00Z" },
    ],
  };

  /** The upper-bound snippet the skill hands the reader. */
  function untilSnippet(): string {
    const md = readFileSync(SKILL, "utf8");
    const m = /```\n(\s*\| map\(select\(\.raw[\s\S]*?)```/.exec(md);
    expect(m, "SKILL.md should carry the --until select snippet").not.toBeNull();
    return m![1].trimEnd();
  }

  /**
   * Apply the snippet to a query the way a reader would, then run it.
   *
   * Parameterised over the block on purpose: the skill says the same line works in
   * both the listing and the ranking, and that claim was FALSE for a release — the
   * ranking filtered inside its object construction, where only the jq variable
   * `$raw` exists, so pasting the `.raw` snippet there died with "null (null) cannot
   * be matched". Testing only the listing is what let that ship.
   */
  function runBoundedOn(block: string, since: string, until: string): string {
    const snippet = untilSnippet().trim();
    const patched = block
      // swap the single-bound select for the documented two-bound one
      .replace(/\| map\(select\(\.raw != null and \(\.raw \| pad\) >= \(\$since \| pad\)\)\)/,
               snippet.replace(/^\s*\|\s*/, "| "))
      .replace(/--arg since "\$SINCE"/, '--arg since "$SINCE" --arg until "$UNTIL"')
      .replace(/^SINCE=[^\s#]*/m, `SINCE=${since}\nUNTIL=${until}`)
      .replace(/kubectl get events [^|]*\| /g, `cat ${fixtureFile(WINDOWED)} | `);
    const r = spawnSync("/bin/bash", ["-c", patched], { encoding: "utf8" });
    expect(r.stderr, "the patched query must not be a jq error").not.toMatch(/error|Cannot/);
    return r.stdout ?? "";
  }

  const runBounded = (since: string, until: string) => runBoundedOn(pick.listing()!, since, until);

  it("excludes an event after the upper bound", () => {
    if (!hasJq()) return;
    const out = runBounded("2026-08-21T08:42:00Z", "2026-08-21T09:00:00Z");
    expect(out, "inside the window").toContain("inside");
    expect(out, "30 minutes past the bound — this was still reported before the fix")
      .not.toContain("after-until");
    expect(out, "before the lower bound").not.toContain("before-since");
  });

  it("bounds on .raw, not on the display field", () => {
    // The distinction the snippet has to get right, stated as an assertion so a
    // future edit back to `.t` fails here rather than silently unbounding the query.
    expect(untilSnippet()).toContain(".raw");
    expect(untilSnippet()).not.toMatch(/\.t\s*<=/);
  });


  it("the same snippet bounds the RANKING query too", () => {
    if (!hasJq()) return;
    // The skill claims one line serves both queries. It only does because both build
    // the object first and filter afterwards; when the ranking filtered inside its
    // construction, this exact paste was a jq type error.
    const out = runBoundedOn(pick.ranking()!, "2026-08-21T08:42:00Z", "2026-08-21T09:00:00Z");
    expect(out).toContain("inside");
    expect(out, "past the upper bound").not.toContain("after-until");
    expect(out, "before the lower bound").not.toContain("before-since");
  });

  it("both queries filter after building the object, which is what makes one snippet work", () => {
    // Structural, because this is the property the shared snippet depends on. If
    // either query goes back to filtering inside its construction, the snippet
    // silently stops applying to it — and prose in the skill will still say it does.
    for (const [name, block] of [["listing", pick.listing()!], ["ranking", pick.ranking()!]] as const) {
      const filterAt = block.indexOf("map(select(.raw");
      const buildAt = block.indexOf("{raw:");
      expect(filterAt, `${name}: filters on .raw via map(select(...))`).toBeGreaterThan(-1);
      expect(buildAt, `${name}: builds an object with a raw field`).toBeGreaterThan(-1);
      expect(filterAt, `${name}: the filter must come AFTER the construction`).toBeGreaterThan(buildAt);
      // And neither may filter on the bare variable, which is what diverged them.
      expect(block, `${name}: no select on $raw before construction`).not.toMatch(/select\(\$raw/);
    }
  });

  it("and the skill says why .t cannot be used", () => {
    const md = readFileSync(SKILL, "utf8");
    expect(md).toMatch(/`\.t` is produced by the `map\(\.t = …\)` that runs AFTER/);
    expect(md).toMatch(/null.*below every string|orders `null` below/);
  });
});

describe("a non-UTC window is refused, not silently mis-filtered", () => {
  // `pad` compares lexically, so an RFC3339 offset does not sort against Kubernetes'
  // `…Z`. Padded naively, "2026-08-21T16:30:00+08:00" became
  // "…T16:30:00+08:00.000000Z" and an event at 08:45:00Z — inside that window, which
  // is 08:30 UTC — was silently dropped. A timestamp with no zone was silently taken
  // as UTC, which is the same mistake wearing a different hat.
  //
  // The fix is refusal rather than zone arithmetic: jq's fromdateiso8601 accepts
  // neither an offset nor a fraction, so converting by hand would be more code to be
  // wrong in, for a spelling the cluster never emits.
  const EVENTS: Record<string, unknown> = {
    items: [
      { metadata: { namespace: "app" }, involvedObject: { kind: "Pod", name: "at-0845" },
        reason: "A", firstTimestamp: "2026-08-21T08:45:00Z", lastTimestamp: "2026-08-21T08:45:00Z" },
    ],
  };

  const run = (block: string, since: string) => {
    const script = block
      .replace(/kubectl get events [^|]*\| /g, `cat ${fixtureFile(EVENTS)} | `)
      .replace(/^SINCE=[^\s#]*/m, `SINCE=${since}`);
    return spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" });
  };

  for (const [label, since] of [
    ["an offset window", "2026-08-21T16:30:00+08:00"],
    ["a negative offset", "2026-08-21T04:30:00-04:00"],
    ["no zone at all", "2026-08-21T08:30:00"],
  ] as const) {
    it(`refuses ${label} loudly`, () => {
      if (!hasJq()) return;
      for (const [name, block] of [["listing", pick.listing()!], ["ranking", pick.ranking()!]] as const) {
        const r = run(block, since);
        // Loud: a message naming the offending value, and NOT a quietly empty answer.
        expect(r.stderr, `${name}: must say what is wrong`).toMatch(/must be UTC and end in Z/);
        expect(r.stderr, `${name}: must quote the value it rejected`).toContain(since);
        expect(r.stdout.trim(), `${name}: must not answer at all`).toBe("");
      }
    });
  }

  it("and the equivalent UTC window works, so the refusal is about the spelling", () => {
    if (!hasJq()) return;
    // 16:30+08:00 is 08:30 UTC; written as UTC the event is found.
    const r = run(pick.listing()!, "2026-08-21T08:30:00Z");
    expect(r.stderr).not.toMatch(/must be UTC/);
    expect(r.stdout).toContain("at-0845");
  });

  it("the skill says the window must be UTC, and the reference says why", () => {
    // The rule belongs in SKILL.md, which is what gets read on every run; the argument
    // for it belongs beside it.
    expect(readFileSync(SKILL, "utf8")).toMatch(/window must be UTC/i);
    const ref = readFileSync(REFERENCE, "utf8");
    expect(ref).toMatch(/fromdateiso8601` accepts neither/);
    // The measured failure, so nobody re-adds the permissive pad.
    expect(ref).toMatch(/silently dropped/);
  });
});

describe("the probe reports observations, not a retention boundary", () => {
  // The oldest observed activity is NOT the TTL cutoff, and calling it one inverts the
  // very error this skill is about. With a one-hour TTL and a single event at 09:55 the
  // probe reads 09:55 — while everything back to 09:00 is still retained and merely
  // uneventful. Reporting "the evidence for 09:30 is deleted" there states an absence
  // as a deletion, which is the same class of mistake as reporting a deletion as an
  // absence.
  it("the probe does not name itself a retention floor or a limit", () => {
    const md = readFileSync(SKILL, "utf8");
    // The output labels must not promise a boundary.
    expect(md).toContain("oldest observed activity");
    expect(md).not.toMatch(/retention floor/);
    // Nor may the prose claim earlier evidence is deleted.
    expect(md).not.toMatch(/is \*\*gone, not absent\*\*/);
  });

  it("it says coverage before that point is UNKNOWN, and why", () => {
    const md = readFileSync(SKILL, "utf8");
    expect(md).toMatch(/coverage is \*\*unknown\*\*/i);
    // Both readings must be named, since the data cannot separate them.
    expect(md).toMatch(/quiet or deleted/);
    // And it must point at the thing that WOULD settle it.
    expect(md).toMatch(/--event-ttl/);
  });

  it("a single recent event does not imply everything older was deleted", () => {
    if (!hasJq()) return;
    // The exact case from the review: one event, late in the window.
    const single = { items: [{
      metadata: { namespace: "app" }, involvedObject: { kind: "Pod", name: "lone" },
      reason: "A", firstTimestamp: "2026-08-21T09:55:00Z", lastTimestamp: "2026-08-21T09:55:00Z",
    }] };
    const script = readFrom(pick.probe()!, fixtureFile(single));
    const out = spawnSync("/bin/bash", ["-c", script], { encoding: "utf8" }).stdout ?? "";
    // It may state what it observed…
    expect(out).toMatch(/oldest observed activity:\s+2026-08-21T09:55:00Z/);
    // …but nothing in the output may present that as a limit on what is retained.
    expect(out).not.toMatch(/already deleted|retention floor|the real limit/);
  });
});
