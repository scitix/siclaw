import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Behavioural tests for the node-logs skill's shell scripts.
 *
 * These scripts are the layer that decides what an EMPTY result means, and that
 * decision is not observable from TypeScript — the previous version reported a
 * missing unit, a failed journalctl, an unreadable file and a filter that simply
 * did not match as one identical "No logs found", exit 0. So the scripts are run
 * for real here, against a PATH containing only the utilities they may use plus
 * purpose-built fakes, which is what makes "journalctl is absent" and
 * "journalctl failed" reproducible states rather than properties of the host.
 *
 * The test lives here rather than beside the scripts because everything inside a
 * skill directory is packaged and shipped to agents (see collectSkillDirectoryFiles).
 */

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "../../../skills/core/node-logs/scripts");
const NODE_LOGS = join(SCRIPTS, "get-node-logs.sh");
const VIA_API = join(SCRIPTS, "get-node-logs-via-api.sh");

// Utilities the scripts are allowed to find. Everything else must be absent so a
// test cannot accidentally depend on the developer's machine having systemd.
const BASE_UTILS = ["awk", "grep", "cat", "cut", "gzip", "sed", "head", "dirname", "basename", "date", "id"];

let root: string;
let realUtil: Record<string, string> = {};

function which(cmd: string): string | undefined {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" });
  const p = r.stdout.trim();
  return p || undefined;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "node-logs-skill-"));
  for (const u of BASE_UTILS) {
    const p = which(u);
    if (p) realUtil[u] = p;
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

interface BinOpts {
  /** Shell body for a fake `journalctl`. Omit to make journalctl absent. */
  journalctl?: string;
  /** Shell body for a fake `systemctl`. Omit to make systemctl absent. */
  systemctl?: string;
  /** Shell body for a fake `kubectl`. Omit to make kubectl absent. */
  kubectl?: string;
  /** Shell body for a fake `id`, to pin who the script thinks it is running as. */
  id?: string;
}

let caseSeq = 0;

/** A private PATH directory: the real utilities, plus only the fakes asked for. */
function makeCase(opts: BinOpts = {}): { bin: string; dir: string; argLog: string } {
  const dir = join(root, `case-${++caseSeq}`);
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, target] of Object.entries(realUtil)) {
    symlinkSync(target, join(bin, name));
  }
  const argLog = join(dir, "args.log");
  for (const name of ["journalctl", "systemctl", "kubectl", "id"] as const) {
    const body = opts[name];
    if (body === undefined) continue;
    const file = join(bin, name);
    // A fake may shadow one of BASE_UTILS (`id`), whose symlink is already here —
    // writing through it would edit the real binary's path target.
    rmSync(file, { force: true });
    writeFileSync(file, `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(argLog)}\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return { bin, dir, argLog };
}

function run(script: string, args: string[], bin: string) {
  const r = spawnSync("/bin/bash", [script, ...args], {
    encoding: "utf8",
    env: { PATH: bin, HOME: root, LC_ALL: "C" },
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Value of a `key:` line from the report header. */
function header(stdout: string, key: string): string | undefined {
  const line = stdout.split("\n").find((l) => l.startsWith(`${key}:`));
  return line?.slice(key.length + 1).trim();
}

/** Log lines only — what sits between the first and the last `---` separator. */
function body(stdout: string): string[] {
  const lines = stdout.split("\n");
  const first = lines.indexOf("---");
  const last = lines.lastIndexOf("---");
  if (first < 0 || last <= first) return [];
  return lines.slice(first + 1, last).filter((l) => l !== "");
}

/** Every `status:` line. There must never be more than one. */
function statusLines(stdout: string): string[] {
  return stdout.split("\n").filter((l) => l.startsWith("status:"));
}

/** The last non-empty line, which the contract says is always the verdict. */
function lastLine(stdout: string): string {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  return lines[lines.length - 1] ?? "";
}

const THREE_LINES = [
  "Aug 18 14:20:01 node kubelet[1]: pod aaa started",
  "Aug 18 14:20:02 node kubelet[1]: pod bbb started",
  "Aug 18 14:20:03 node kubelet[1]: literal a|b marker",
];

const JOURNAL_OK = `printf '%s\\n' ${THREE_LINES.map((l) => JSON.stringify(l)).join(" ")}`;
const SYSTEMCTL_KNOWN = `[[ "$1" == "list-unit-files" ]] && echo "kubelet.service enabled enabled"; exit 0`;

describe("get-node-logs.sh — argument handling", () => {
  it("rejects an unknown option instead of printing help and succeeding", () => {
    // The old script exited 0 here, so `--node` (which it never supported) read
    // as a successful run that found nothing.
    const { bin } = makeCase({ journalctl: JOURNAL_OK });
    const r = run(NODE_LOGS, ["--node", "n1", "--unit", "kubelet"], bin);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown option: --node");
  });

  it("requires a source", () => {
    const { bin } = makeCase({ journalctl: JOURNAL_OK });
    expect(run(NODE_LOGS, ["--tail", "5"], bin).code).toBe(2);
  });

  it("refuses --list-boots mixed with a query it would silently drop", () => {
    const { bin } = makeCase({ journalctl: JOURNAL_OK });
    const r = run(NODE_LOGS, ["--list-boots", "--unit", "kubelet", "--grep", "oom"], bin);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("takes no other arguments");
  });

  it("refuses --until without --since so the default window cannot invert it", () => {
    const { bin } = makeCase({ journalctl: JOURNAL_OK });
    const r = run(NODE_LOGS, ["--unit", "kubelet", "--until", "2026-08-18T07:00:00Z"], bin);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--until requires an explicit --since");
  });

  it("rejects mixing --grep and --grep-fixed", () => {
    const { bin } = makeCase({ journalctl: JOURNAL_OK });
    const r = run(NODE_LOGS, ["--unit", "kubelet", "--grep", "a", "--grep-fixed", "b"], bin);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cannot be combined");
  });

  it("rejects a non-positive --tail", () => {
    const { bin } = makeCase({ journalctl: JOURNAL_OK });
    expect(run(NODE_LOGS, ["--unit", "kubelet", "--tail", "0"], bin).code).toBe(2);
  });
});

describe("get-node-logs.sh — source availability", () => {
  it("says journalctl is missing (exit 3) rather than reporting no logs", () => {
    const { bin } = makeCase({}); // no journalctl on PATH
    const r = run(NODE_LOGS, ["--unit", "kubelet"], bin);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("journalctl is not available");
    expect(r.stdout).not.toContain("No logs found");
  });

  it("reports a failing journalctl as source_error (exit 5) with its stderr intact", () => {
    const { bin } = makeCase({
      journalctl: `echo "Failed to add match: Invalid argument" >&2; exit 1`,
      systemctl: SYSTEMCTL_KNOWN,
    });
    const r = run(NODE_LOGS, ["--unit", "kubelet"], bin);
    expect(r.code).toBe(5);
    expect(header(r.stdout, "status")).toContain("source_error");
    // stderr must NOT have been folded into stdout and then filtered away.
    expect(r.stderr).toContain("Failed to add match");
    // A failed source produces zero lines, so the report must not ALSO claim
    // no_match: one run, one verdict, and the verdict is the one that explains
    // why the output is empty.
    expect(statusLines(r.stdout)).toHaveLength(1);
    expect(r.stdout).not.toContain("no_match");
  });

  it("notes a unit systemd does not know, and suggests the names that exist", () => {
    const { bin } = makeCase({
      journalctl: `exit 0`,
      systemctl: `[[ "$1" == "list-unit-files" && "$3" != "" ]] && exit 0
if [[ "$1" == "list-unit-files" && "$#" -eq 2 ]]; then echo "containerd.service enabled enabled"; fi
exit 0`,
    });
    const r = run(NODE_LOGS, ["--unit", "containerdd"], bin);
    expect(r.stdout).toContain("is not a known systemd unit");
    expect(r.stdout).toContain("similar: containerd.service");
    expect(header(r.stdout, "status")).toBe("no_match");
    expect(r.code).toBe(0);
  });

  it("says so when it cannot confirm the unit exists", () => {
    const { bin } = makeCase({ journalctl: JOURNAL_OK }); // no systemctl
    const r = run(NODE_LOGS, ["--unit", "kubelet"], bin);
    expect(r.stdout).toContain("systemctl unavailable");
  });

  it("separates 'systemctl cannot answer' from 'no such unit'", () => {
    // Observed on a real host: the D-Bus system bus was unreachable, systemctl
    // exited non-zero with no output, and reading that as an answer produced a
    // note claiming docker.service did not exist on a host that runs it.
    const { bin } = makeCase({
      journalctl: JOURNAL_OK,
      systemctl: `echo "Failed to connect to bus: Connection refused" >&2; exit 1`,
    });
    const r = run(NODE_LOGS, ["--unit", "docker"], bin);
    expect(r.stdout).toContain("no unit inventory");
    expect(r.stdout).not.toContain("is not a known systemd unit");
  });

  it("still calls out a wrong unit name when systemctl works", () => {
    // The counterpart of the case above, and the reason it must be told apart:
    // a per-unit `list-unit-files -- <name>` exits 1 for an unmatched pattern
    // TOO, so keying off its exit code explained a real typo away as "systemctl
    // could not answer" — verified against a live node where the unit inventory
    // listed kubelet.service and the query named kubelettt.
    const { bin } = makeCase({
      journalctl: `exit 0`,
      systemctl: `printf '%s\\n' "kubelet.service enabled enabled" "containerd.service enabled enabled"; exit 0`,
    });
    const r = run(NODE_LOGS, ["--unit", "kubelettt"], bin);
    expect(r.stdout).toContain("unit 'kubelettt' is not a known systemd unit");
    expect(r.stdout).toContain("similar: kubelet.service");
  });

  it("warns when this account cannot read the system journal at all", () => {
    // Over SSH as an ordinary account journalctl shows only that user's own
    // messages and still exits 0 — observed on a real host. An empty result there
    // is a permission artifact, so it must not read as "the unit logged nothing".
    const { bin } = makeCase({
      journalctl: `exit 0`,
      systemctl: SYSTEMCTL_KNOWN,
      id: `[[ "$1" == "-u" ]] && echo 1000; [[ "$1" == "-nG" ]] && echo "users docker"; [[ "$1" == "-un" ]] && echo appuser; exit 0`,
    });
    const r = run(NODE_LOGS, ["--unit", "kubelet"], bin);
    expect(r.stdout).toContain("not in 'adm' or 'systemd-journal'");
    expect(r.stdout).toContain("cannot read the system journal");
    expect(lastLine(r.stdout)).toContain("no_match");
  });

  it("stays quiet about privileges when running as root", () => {
    const { bin } = makeCase({
      journalctl: JOURNAL_OK,
      systemctl: SYSTEMCTL_KNOWN,
      id: `[[ "$1" == "-u" ]] && echo 0; [[ "$1" == "-nG" ]] && echo "root"; exit 0`,
    });
    const r = run(NODE_LOGS, ["--unit", "kubelet"], bin);
    expect(r.stdout).not.toContain("systemd-journal");
  });

  it("does not count journalctl's '-- No entries --' placeholder as a log line", () => {
    // Real journalctl output for an empty query. Counting it made an empty
    // journal report scanned=1, matched=1, status=ok — with the placeholder as
    // the evidence.
    const { bin } = makeCase({ journalctl: `echo "-- No entries --"`, systemctl: SYSTEMCTL_KNOWN });
    const r = run(NODE_LOGS, ["--unit", "kubelet"], bin);
    expect(header(r.stdout, "scanned")).toBe("0 line(s) from the source");
    expect(lastLine(r.stdout)).toContain("no_match");
    expect(r.stdout).not.toContain("-- No entries --");
  });

  it("keeps '-- Reboot --' — that one is real evidence", () => {
    const { bin } = makeCase({
      journalctl: `printf '%s\\n' "-- Reboot --" "Aug 18 14:20:01 node kubelet[1]: started"`,
      systemctl: SYSTEMCTL_KNOWN,
    });
    const r = run(NODE_LOGS, ["--unit", "kubelet"], bin);
    expect(header(r.stdout, "scanned")).toBe("2 line(s) from the source");
    expect(body(r.stdout)).toContain("-- Reboot --");
  });
});

describe("get-node-logs.sh — filtering", () => {
  it("treats --grep as an ERE, so a|b means a OR b", () => {
    // The regression this whole rewrite starts from: `grep -i` read `|` as a
    // literal, returned nothing, and exited 0.
    const { bin } = makeCase({ journalctl: JOURNAL_OK, systemctl: SYSTEMCTL_KNOWN });
    const r = run(NODE_LOGS, ["--unit", "kubelet", "--grep", "aaa|bbb"], bin);
    expect(r.code).toBe(0);
    expect(header(r.stdout, "status")).toBe("ok");
    expect(header(r.stdout, "matched")).toBe("2 line(s)");
    expect(body(r.stdout)).toHaveLength(2);
  });

  it("ORs repeated --grep patterns in one pass", () => {
    const { bin } = makeCase({ journalctl: JOURNAL_OK, systemctl: SYSTEMCTL_KNOWN });
    const r = run(NODE_LOGS, ["--unit", "kubelet", "--grep", "aaa", "--grep", "bbb"], bin);
    expect(header(r.stdout, "matched")).toBe("2 line(s)");
    expect(header(r.stdout, "filter")).toContain("ERE");
    // One journalctl invocation for both patterns.
    expect(header(r.stdout, "scanned")).toBe("3 line(s) from the source");
  });

  it("matches --grep-fixed literally", () => {
    const { bin } = makeCase({ journalctl: JOURNAL_OK, systemctl: SYSTEMCTL_KNOWN });
    const hit = run(NODE_LOGS, ["--unit", "kubelet", "--grep-fixed", "a|b"], bin);
    expect(header(hit.stdout, "matched")).toBe("1 line(s)");
    expect(header(hit.stdout, "filter")).toContain("fixed string");
    const miss = run(NODE_LOGS, ["--unit", "kubelet", "--grep-fixed", "aaa|bbb"], bin);
    expect(header(miss.stdout, "status")).toBe("no_match");
  });

  it("reports no_match as bounded non-evidence, still exiting 0", () => {
    const { bin } = makeCase({ journalctl: JOURNAL_OK, systemctl: SYSTEMCTL_KNOWN });
    const r = run(NODE_LOGS, ["--unit", "kubelet", "--grep", "nothing-here"], bin);
    expect(r.code).toBe(0);
    expect(header(r.stdout, "status")).toBe("no_match");
    expect(header(r.stdout, "scanned")).toBe("3 line(s) from the source");
    expect(r.stdout).toContain("bounded non-evidence");
  });

  it("reports an invalid ERE as filter_error instead of no_match", () => {
    // Nothing was searched, so "no match" would be a false statement about the node.
    const { bin } = makeCase({ journalctl: JOURNAL_OK, systemctl: SYSTEMCTL_KNOWN });
    const r = run(NODE_LOGS, ["--unit", "kubelet", "--grep", "kube(let"], bin);
    expect(r.code).toBe(2);
    expect(header(r.stdout, "status")).toContain("filter_error");
    expect(statusLines(r.stdout)).toHaveLength(1);
  });

  it("still blames the pattern when the dying filter takes the source down with it", () => {
    // On a real node this is the normal shape of an invalid pattern: grep exits
    // immediately, the pipe closes, and journalctl — still streaming megabytes —
    // dies of SIGPIPE (141). Judging the source first reported "the log source
    // failed, see stderr", i.e. blamed the node for the caller's regex. A few
    // lines of fake output never reproduce it (they fit in the pipe buffer), so
    // this fake writes more than the buffer can hold.
    const { bin } = makeCase({
      journalctl: `awk 'BEGIN{for(i=0;i<200000;i++) print "Aug 18 14:20:01 node kubelet[1]: filler line", i}'`,
      systemctl: SYSTEMCTL_KNOWN,
    });
    const r = run(NODE_LOGS, ["--unit", "kubelet", "--grep", "kube(let"], bin);
    expect(header(r.stdout, "status")).toContain("filter_error");
    expect(r.stdout).not.toContain("source_error");
    expect(r.code).toBe(2);
  });

  it("keeps only the last --tail lines but counts every match", () => {
    const { bin } = makeCase({
      journalctl: `for i in $(awk 'BEGIN{for(i=1;i<=500;i++) print i}'); do echo "line $i match"; done`,
      systemctl: SYSTEMCTL_KNOWN,
    });
    const r = run(NODE_LOGS, ["--unit", "kubelet", "--grep", "match", "--tail", "10"], bin);
    expect(header(r.stdout, "matched")).toBe("500 line(s) (showing the last 10)");
    const lines = body(r.stdout);
    expect(lines).toHaveLength(10);
    expect(lines[9]).toBe("line 500 match");
  });
});

describe("the status contract", () => {
  // One rule for the model to follow — "read the last line" — has to hold for
  // every outcome, not just the happy path, or it is not a rule.
  it("ends every report with the single status line, whatever the outcome", () => {
    const ok = makeCase({ journalctl: JOURNAL_OK, systemctl: SYSTEMCTL_KNOWN });
    const failing = makeCase({ journalctl: `echo boom >&2; exit 1`, systemctl: SYSTEMCTL_KNOWN });
    const cases: Array<[string, string[], string]> = [
      ["ok", ["--unit", "kubelet"], ok.bin],
      ["no_match", ["--unit", "kubelet", "--grep", "zzz"], ok.bin],
      ["filter_error", ["--unit", "kubelet", "--grep", "kube(let"], ok.bin],
      ["source_error", ["--unit", "kubelet"], failing.bin],
    ];
    for (const [expected, args, bin] of cases) {
      const r = run(NODE_LOGS, args, bin);
      expect(statusLines(r.stdout), `${expected}: exactly one status line`).toHaveLength(1);
      expect(lastLine(r.stdout), `${expected}: status is last`).toContain(`status:`);
      expect(lastLine(r.stdout)).toContain(expected);
    }
  });

  it("also ends the tier-3 report with the status line on every path", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    for (const [expected, args] of [
      ["ok", ["--node", "n1", "--file", "syslog"]],
      ["ok", ["--node", "n1", "--list"]],
      ["no_match", ["--node", "n1", "--file", "syslog", "--grep", "zzz"]],
      ["not_found", ["--node", "n1", "--file", "messages"]],
      ["forbidden", ["--node", "n1", "--file", "forbidden"]],
      ["not_a_log_file", ["--node", "n1", "--file", "pods"]],
      ["query_unsupported", ["--node", "n1", "--query", "kubelet"]],
    ] as Array<[string, string[]]>) {
      const r = run(VIA_API, args, bin);
      expect(statusLines(r.stdout), `${expected}: exactly one status line`).toHaveLength(1);
      expect(lastLine(r.stdout), `${expected}: status is last`).toContain(expected);
    }
  });
});

describe("get-node-logs.sh — time window", () => {
  it("converts an RFC3339 window into something journalctl accepts", () => {
    const { bin, argLog } = makeCase({ journalctl: JOURNAL_OK, systemctl: SYSTEMCTL_KNOWN });
    const r = run(
      NODE_LOGS,
      ["--unit", "kubelet", "--since", "2026-08-18T06:00:00Z", "--until", "2026-08-18T07:00:00Z"],
      bin,
    );
    expect(r.code).toBe(0);
    const args = spawnSync("/bin/cat", [argLog], { encoding: "utf8" }).stdout;
    // journalctl rejects the T/Z form outright, so it must have been converted.
    expect(args).toMatch(/--since @17\d+/);
    expect(args).toMatch(/--until @17\d+/);
    // and the header must echo both the input and what was actually queried
    expect(header(r.stdout, "window")).toContain("2026-08-18T06:00:00Z");
    expect(header(r.stdout, "window")).toContain("journalctl: @");
  });

  it("passes journalctl-native values through untouched", () => {
    const { bin, argLog } = makeCase({ journalctl: JOURNAL_OK, systemctl: SYSTEMCTL_KNOWN });
    run(NODE_LOGS, ["--unit", "kubelet", "--since", "30m ago"], bin);
    expect(spawnSync("/bin/cat", [argLog], { encoding: "utf8" }).stdout).toContain("--since 30m ago");
  });

  it("marks the default window as defaulted", () => {
    const { bin } = makeCase({ journalctl: JOURNAL_OK, systemctl: SYSTEMCTL_KNOWN });
    const r = run(NODE_LOGS, ["--unit", "kubelet"], bin);
    expect(header(r.stdout, "window")).toContain("[--since defaulted]");
  });

  it("drops the default --since when --boot bounds the window instead", () => {
    // A default hour on top of -b would silently clip the boot to its last hour.
    const { bin, argLog } = makeCase({ journalctl: JOURNAL_OK, systemctl: SYSTEMCTL_KNOWN });
    const r = run(NODE_LOGS, ["--unit", "kubelet", "--boot", "0"], bin);
    const args = spawnSync("/bin/cat", [argLog], { encoding: "utf8" }).stdout;
    expect(args).toContain("-b 0");
    expect(args).not.toContain("--since");
    expect(header(r.stdout, "boot")).toBe("0");
  });

  it("rejects an RFC3339 value it cannot convert", () => {
    const { bin } = makeCase({ journalctl: JOURNAL_OK, systemctl: SYSTEMCTL_KNOWN });
    const r = run(NODE_LOGS, ["--unit", "kubelet", "--since", "2026-13-45T99:00:00Z"], bin);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("could not convert RFC3339");
  });
});

describe("get-node-logs.sh — file sources", () => {
  function withLogFiles(): { bin: string; base: string } {
    const { bin, dir } = makeCase({});
    const base = join(dir, "messages");
    writeFileSync(base, "live line one\nlive line two\n");
    writeFileSync(`${base}.1`, "rotation one\n");
    writeFileSync(join(dir, "plain.log"), "only line\n");
    const gz = join(dir, "messages.2");
    writeFileSync(gz, "rotation two\n");
    spawnSync("/bin/sh", ["-c", `gzip -f ${JSON.stringify(gz)}`]);
    return { bin, base };
  }

  it("exits 4 when the file does not exist", () => {
    const { bin, dir } = makeCase({});
    const r = run(NODE_LOGS, ["--file", join(dir, "nope.log")], bin);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("does not exist");
  });

  it("reads a plain file and counts it", () => {
    const { bin, base } = withLogFiles();
    const r = run(NODE_LOGS, ["--file", base], bin);
    expect(r.code).toBe(0);
    expect(header(r.stdout, "scanned")).toBe("2 line(s) from the source");
    expect(body(r.stdout)).toEqual(["live line one", "live line two"]);
  });

  it("reads numeric rotations oldest first with --include-rotated", () => {
    const { bin, base } = withLogFiles();
    const r = run(NODE_LOGS, ["--file", base, "--include-rotated"], bin);
    expect(header(r.stdout, "scanned")).toBe("4 line(s) from the source");
    expect(body(r.stdout)).toEqual(["rotation two", "rotation one", "live line one", "live line two"]);
  });

  it("errors on a file that has neither a base nor a rotation, even after a good one", () => {
    // Judged per requested file: an earlier readable file must not make a later
    // missing one look like it was covered.
    const { bin, base } = withLogFiles();
    const r = run(NODE_LOGS, ["--file", base, "--file", `${base}-gone`, "--include-rotated"], bin);
    expect(r.code).toBe(4);
    expect(r.stderr).toContain("no rotation of it does either");
  });

  it("clamps an unbounded --tail and says it did", () => {
    const { bin, base } = withLogFiles();
    const r = run(NODE_LOGS, ["--file", base, "--tail", "999999"], bin);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--tail clamped to 20000 (requested 999999)");
  });

  it("states that --since cannot filter a file instead of ignoring it silently", () => {
    const { bin, base } = withLogFiles();
    const r = run(NODE_LOGS, ["--file", base, "--since", "1h ago"], bin);
    expect(header(r.stdout, "window")).toContain("IGNORED for file sources");
  });

  it("refuses --boot for a file source", () => {
    const { bin, base } = withLogFiles();
    expect(run(NODE_LOGS, ["--file", base, "--boot", "0"], bin).code).toBe(2);
  });
});

// ── tier 3: the kubelet log endpoint ──────────────────────────────────

/**
 * A fake kubectl serving the shapes a real kubelet log endpoint returns. The
 * HTML-directory-listing case is the important one: a kubelet without the
 * NodeLogQuery feature answers a journald query with the /var/log INDEX and
 * HTTP 200, so a script that trusts the body reports HTML as log content.
 */
const KUBECTL_FAKE = `
path="$3"
case "$path" in
  */logs/?query=*)      printf '<pre>\\n<a href="syslog">syslog</a>\\n</pre>\\n' ;;
  */logs/)              printf '<pre>\\n<a href="syslog">syslog</a>\\n<a href="messages">messages</a>\\n<a href="pods/">pods/</a>\\n</pre>\\n' ;;
  */logs/syslog)        printf '%s\\n' "Aug 18 14:20:01 node kubelet[1]: pod aaa started" "Aug 18 14:20:02 node containerd[1]: pod bbb started" ;;
  */logs/syslog.1)      printf '%s\\n' "Aug 18 13:00:00 node kubelet[1]: older rotation line" ;;
  */logs/pods)          printf '<pre>\\n<a href="x/">x/</a>\\n</pre>\\n' ;;
  */logs/forbidden)     echo 'Error from server (Forbidden): nodes "n1" is forbidden' >&2; exit 1 ;;
  *)                    echo 'Error from server (NotFound): the server could not find the requested resource' >&2; exit 1 ;;
esac
`;

describe("get-node-logs-via-api.sh", () => {
  it("validates the node name before it reaches a URL", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    const r = run(VIA_API, ["--node", "n1/../../secrets", "--file", "syslog"], bin);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid node name");
  });

  it("rejects absolute paths and traversal in a log path", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    expect(run(VIA_API, ["--node", "n1", "--file", "/var/log/syslog"], bin).code).toBe(2);
    expect(run(VIA_API, ["--node", "n1", "--file", "../../etc/shadow"], bin).code).toBe(2);
  });

  it("reports NodeLogQuery being off instead of counting the HTML index as logs", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    const r = run(VIA_API, ["--node", "n1", "--query", "kubelet"], bin);
    expect(r.code).toBe(3);
    expect(header(r.stdout, "status")).toBe("query_unsupported");
    expect(r.stdout).toContain("NodeLogQuery");
    expect(r.stdout).not.toContain("<a href=");
  });

  it("lists /var/log by parsing the index", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    const r = run(VIA_API, ["--node", "n1", "--list"], bin);
    expect(r.code).toBe(0);
    expect(body(r.stdout)).toContain("syslog");
    expect(body(r.stdout)).toContain("pods/");
  });

  it("reads a file, counts it, and filters with an ERE", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    const r = run(VIA_API, ["--node", "n1", "--file", "syslog", "--grep", "aaa|bbb"], bin);
    expect(r.code).toBe(0);
    expect(header(r.stdout, "status")).toBe("ok");
    expect(header(r.stdout, "matched")).toBe("2 line(s)");
  });

  it("does not mistake log CONTENT for an API error", () => {
    // Classification reads kubectl's exit code and stderr, never the body — a
    // syslog full of "error:" and the word forbidden must still read as logs.
    const { bin } = makeCase({
      kubectl: `path="$3"
case "$path" in
  */logs/syslog) printf '%s\\n' "Aug 18 14:20:01 node app[1]: error: connection forbidden" "Aug 18 14:20:02 node app[1]: Error from server (NotFound): upstream said so" ;;
  *) echo 'Error from server (NotFound)' >&2; exit 1 ;;
esac`,
    });
    const r = run(VIA_API, ["--node", "n1", "--file", "syslog"], bin);
    expect(r.code).toBe(0);
    expect(lastLine(r.stdout)).toContain("ok");
    expect(header(r.stdout, "matched")).toBe("2 line(s)");
  });

  it("reads the rotations when the live file was rotated away, and says so", () => {
    const { bin } = makeCase({
      kubectl: `path="$3"
case "$path" in
  */logs/)         printf '<pre>\\n<a href="syslog.1">syslog.1</a>\\n</pre>\\n' ;;
  */logs/syslog.1) printf '%s\\n' "Aug 18 13:00:00 node kubelet[1]: rotation only line" ;;
  *) echo 'Error from server (NotFound): the server could not find the requested resource' >&2; exit 1 ;;
esac`,
    });
    const r = run(VIA_API, ["--node", "n1", "--file", "syslog", "--include-rotated"], bin);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("itself is absent");
    expect(header(r.stdout, "scanned")).toBe("1 line(s) transferred");
    expect(lastLine(r.stdout)).toContain("ok");
  });

  it("rejects flags a mode cannot honour instead of ignoring them", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    expect(run(VIA_API, ["--node", "n1", "--query", "kubelet", "--include-rotated"], bin).code).toBe(2);
    expect(run(VIA_API, ["--node", "n1", "--list", "--grep", "syslog"], bin).code).toBe(2);
    expect(run(VIA_API, ["--node", "n1", "--list", "--head-bytes", "10"], bin).code).toBe(2);
  });

  it("says the file is absent (exit 4) rather than reporting no logs", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    const r = run(VIA_API, ["--node", "n1", "--file", "messages"], bin);
    expect(r.code).toBe(4);
    expect(header(r.stdout, "status")).toBe("not_found");
  });

  it("distinguishes an RBAC refusal (exit 6)", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    const r = run(VIA_API, ["--node", "n1", "--file", "forbidden"], bin);
    expect(r.code).toBe(6);
    expect(header(r.stdout, "status")).toBe("forbidden");
  });

  it("calls a directory a directory (exit 3)", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    const r = run(VIA_API, ["--node", "n1", "--file", "pods"], bin);
    expect(r.code).toBe(3);
    expect(header(r.stdout, "status")).toBe("not_a_log_file");
  });

  it("finds rotations from one directory listing, oldest first", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE + `\n` });
    // The fake index above does not advertise syslog.1, so nothing extra is read;
    // an index that does advertise it must be picked up.
    const withRotation = makeCase({
      kubectl: KUBECTL_FAKE.replace(
        '<a href="messages">messages</a>',
        '<a href="messages">messages</a>\\n<a href="syslog.1">syslog.1</a>',
      ),
    });
    const plain = run(VIA_API, ["--node", "n1", "--file", "syslog", "--include-rotated"], bin);
    expect(header(plain.stdout, "scanned")).toBe("2 line(s) transferred");

    const r = run(VIA_API, ["--node", "n1", "--file", "syslog", "--include-rotated"], withRotation.bin);
    expect(header(r.stdout, "scanned")).toBe("3 line(s) transferred");
    expect(body(r.stdout)[0]).toContain("older rotation line");
  });

  it("refuses a time window on a file read, where it would be a lie", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    const r = run(VIA_API, ["--node", "n1", "--file", "syslog", "--since", "2026-08-18T06:00:00Z"], bin);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--since/--until only work with --query");
  });

  it("warns that --head-bytes keeps the oldest end of the file", () => {
    const { bin } = makeCase({ kubectl: KUBECTL_FAKE });
    const r = run(VIA_API, ["--node", "n1", "--file", "syslog", "--head-bytes", "64"], bin);
    expect(r.stdout).toContain("OLDEST part of the file");
  });

  it("passes the window to the kubelet in RFC3339 when the query path is used", () => {
    const { bin, argLog } = makeCase({
      // Answer the query with log lines so the window reaches a real fetch.
      kubectl: `path="$3"\ncase "$path" in\n  */logs/?query=*) printf '%s\\n' "Aug 18 14:20:01 node kubelet[1]: query line" ;;\n  *) echo 'Error from server (NotFound)' >&2; exit 1 ;;\nesac`,
    });
    const r = run(VIA_API, ["--node", "n1", "--query", "kubelet", "--since", "@1755500000"], bin);
    expect(r.code).toBe(0);
    const args = spawnSync("/bin/cat", [argLog], { encoding: "utf8" }).stdout;
    expect(args).toMatch(/sinceTime=20\d\d-\d\d-\d\dT\d\d%3A\d\d%3A\d\dZ/);
  });
});
