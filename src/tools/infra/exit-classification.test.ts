import { describe, it, expect } from "vitest";
import { classifyExit } from "./exit-classification.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCommand } from "./command-validator.js";

describe("classifyExit", () => {
  it("treats exit 0 as success with nothing appended", () => {
    const j = classifyExit({ command: "uptime", exitCode: 0, stdout: "up 3 days" });
    expect(j).toEqual({ exitClass: "success", isError: false, annotation: "" });
  });

  it("does not call a no-match an error", () => {
    // `details.error` drives the Trace outcome, so marking this an error painted a normal
    // "nothing matched" red — the single most misleading case in the retro feedback.
    for (const cmd of ["grep kubelet /var/log/x", "pgrep -f nvidia", "test -f /etc/foo"]) {
      const j = classifyExit({ command: cmd, exitCode: 1, stdout: "" });
      expect(j.exitClass).toBe("no_match");
      expect(j.isError).toBe(false);
      expect(j.annotation).toContain("not a failure");
    }
  });

  it("reads the exit code off the LAST pipeline segment", () => {
    // The shell reports the last segment's status, so that is the command whose exit 1 means
    // "matched nothing".
    const piped = classifyExit({ command: "journalctl -u kubelet | grep -i error", exitCode: 1, stdout: "" });
    expect(piped.exitClass).toBe("no_match");
    // A pipeline ENDING in something else keeps the generic class, rather than inheriting grep's.
    const notGrep = classifyExit({ command: "grep -i error /var/log/x | wc -l", exitCode: 1, stdout: "" });
    expect(notGrep.exitClass).toBe("target_reported_failure");
  });

  it("keeps diff/cmp generic instead of calling a difference a no-match", () => {
    // Their exit 1 means "differences found" — a finding the caller reads out of the body. Labelling
    // it "no_match" would be more wrong than leaving it generic.
    expect(classifyExit({ command: "diff a b", exitCode: 1, stdout: "1c1" }).exitClass)
      .toBe("target_reported_failure");
  });

  it("names 127 as a missing dependency, and says something different for the AgentBox", () => {
    const onNode = classifyExit({ command: "jq .", exitCode: 127, stdout: "", context: "node" });
    expect(onNode.exitClass).toBe("dependency_missing");
    expect(onNode.isError).toBe(true);
    expect(onNode.annotation).toContain("admission policy");
    expect(onNode.annotation).toContain("do not retry");

    // In the AgentBox the whitelist IS an availability promise (enforced at build time), so telling
    // the agent to "use a different command" would send it chasing a bug in our own image.
    const local = classifyExit({ command: "yq .", exitCode: 127, stdout: "", context: "local" });
    expect(local.exitClass).toBe("dependency_missing");
    expect(local.annotation).toContain("AgentBox image");
    expect(local.annotation).not.toContain("admission policy");
  });

  it("separates 126 from 127", () => {
    const j = classifyExit({ command: "/opt/x", exitCode: 126, stdout: "" });
    expect(j.exitClass).toBe("not_executable");
    expect(j.isError).toBe(true);
  });

  it("attributes an ordinary non-zero exit to the target, not to the exec path", () => {
    const j = classifyExit({ command: "systemctl is-active kubelet", exitCode: 3, stdout: "inactive" });
    expect(j.exitClass).toBe("target_reported_failure");
    expect(j.isError).toBe(true);
    expect(j.annotation).toContain("target's own answer");
  });

  it("does not report a spawn failure as the target's answer", () => {
    // execFile rejects with a STRING code when the process never started. Reporting ENOENT as an
    // exit code claimed the target ran the command and answered, which it did not.
    const j = classifyExit({ command: "kubectl exec ...", exitCode: "ENOENT", stdout: "" });
    expect(j.exitClass).toBe("channel_error");
    expect(j.isError).toBe(true);
    expect(j.annotation).toContain("never");
    expect(j.annotation).not.toContain("exit code");
  });

  describe("a dead channel vs a command that ran and failed", () => {
    // This is the distinction that matters most: `kubectl exec` reports its OWN failures through the
    // same exit status it uses to relay the remote command's, so without stderr the two are identical.
    const channel = [
      "error: unable to upgrade connection: container not found (\"app\")",
      "error dialing backend: dial tcp 10.0.0.1:10250: connect: connection refused",
      "Error from server (NotFound): pods \"gone-abc\" not found",
      "The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?",
      "Unable to connect to the server: net/http: TLS handshake timeout",
      "error: You must be logged in to the server (Unauthorized)",
    ];
    for (const stderr of channel) {
      it(`calls a channel failure a channel failure: ${stderr.slice(0, 34)}…`, () => {
        const j = classifyExit({ command: "cat /etc/hosts", exitCode: 1, stdout: "", stderr });
        expect(j.exitClass).toBe("channel_error");
        expect(j.isError).toBe(true);
        expect(j.annotation).toMatch(/never ran|could not be reached/);
      });
    }

    it("does not call it a channel failure when the command produced output", () => {
      // A command of the agent's own that prints "error:" must not be mistaken for a dead channel;
      // a channel that failed produces no command output at all.
      const j = classifyExit({
        command: "cat /var/log/x", exitCode: 1,
        stdout: "Error from server: this text is in the FILE being printed",
        stderr: "Error from server (NotFound): pods \"x\" not found",
      });
      expect(j.exitClass).toBe("target_reported_failure");
    });

    it("reads the runtime's missing-binary error as a dependency, not a dead channel", () => {
      // This stderr matches a channel marker too; the specific reading has to win, or "the node lacks
      // jq" is reported as "the connection broke" and the agent retries forever.
      const j = classifyExit({
        command: "jq .", exitCode: 1, stdout: "",
        stderr: "error: Internal error occurred: error executing command in container: failed to exec in container: "
          + "failed to start exec: OCI runtime exec failed: exec failed: unable to start container process: "
          + "exec: \"jq\": executable file not found in $PATH",
      });
      expect(j.exitClass).toBe("dependency_missing");
      expect(j.annotation).toContain("cannot make the target have it");
    });

    it("does not treat kubectl relaying a remote exit as a channel failure", () => {
      // "command terminated with exit code N" means the command DID run — the opposite.
      const j = classifyExit({
        command: "systemctl is-active kubelet", exitCode: 3, stdout: "",
        stderr: "command terminated with exit code 3",
      });
      expect(j.exitClass).toBe("target_reported_failure");
      expect(j.annotation).toContain("target's own answer");
    });

    it("still sees a no-match through an empty stderr", () => {
      const j = classifyExit({ command: "grep oom /var/log/x", exitCode: 1, stdout: "", stderr: "" });
      expect(j.exitClass).toBe("no_match");
      expect(j.isError).toBe(false);
    });
  });

  it("keeps partial output from a signalled command as a result", () => {
    const withOutput = classifyExit({ command: "tcpdump -i eth0", exitCode: null, stdout: "packets", signal: "SIGTERM" });
    expect(withOutput.exitClass).toBe("interrupted");
    expect(withOutput.isError).toBe(false);
    expect(withOutput.annotation).toContain("partial");
    expect(withOutput.annotation).toContain("SIGTERM");

    const withNothing = classifyExit({ command: "tcpdump -i eth0", exitCode: null, stdout: "" });
    expect(withNothing.exitClass).toBe("interrupted");
    expect(withNothing.isError).toBe(true);
  });

  it("every non-success class states what it is in the text", () => {
    // details is stripped before the model sees a tool result, so a class that only appears there
    // cannot be acted on.
    const cases = [
      classifyExit({ command: "grep x", exitCode: 1, stdout: "" }),
      classifyExit({ command: "jq .", exitCode: 127, stdout: "" }),
      classifyExit({ command: "x", exitCode: 126, stdout: "" }),
      classifyExit({ command: "x", exitCode: 5, stdout: "" }),
      classifyExit({ command: "x", exitCode: "ENOENT", stdout: "" }),
      classifyExit({ command: "x", exitCode: null, stdout: "" }),
    ];
    for (const j of cases) {
      expect(j.annotation).not.toBe("");
      expect(j.annotation).toContain(j.exitClass === "interrupted" ? "interrupted" : j.exitClass);
    }
  });
});

describe("which leg broke is a separate question from whose failure it was", () => {
  // The channel markers were all kubectl's, so the leg BETWEEN the channel and the target — `nsenter`
  // for node_exec, `ip netns exec` for host_exec — had none. All three strings below were classified
  // `target_reported_failure`, whose annotation tells the agent "that is the target's own answer", for
  // a command the target never saw.
  //
  // Captured from a real privileged pod on the test cluster, not written from memory.
  const REAL = {
    nsMissing: "nsenter: cannot open /proc/999999/ns/ipc: No such file or directory\ncommand terminated with exit code 1",
    nsDenied: "nsenter: cannot open /proc/1/ns/mnt: Permission denied\ncommand terminated with exit code 1",
    netnsGone: 'Cannot open network namespace "no-such-netns": No such file or directory',
    transport: "error dialing backend: EOF",
    realFailure: "command terminated with exit code 3",
    notFound: "sh: 1: definitely-not-a-binary: not found\ncommand terminated with exit code 127",
  };

  it("separates the namespace-entry leg from the transport", () => {
    for (const [label, stderr, exitCode] of [
      ["nsenter: target ns gone", REAL.nsMissing, 1],
      ["nsenter: permission denied", REAL.nsDenied, 1],
      ["ip netns exec: netns gone", REAL.netnsGone, 255],
    ] as const) {
      const j = classifyExit({ command: "uptime", exitCode, stdout: "", stderr, context: "node" });
      expect(j.exitClass, label).toBe("channel_error");
      expect(j.channelLeg, label).toBe("namespace_entry");
      // The agent never sees details, so the distinction has to be in the text.
      expect(j.annotation, label).toMatch(/namespace/i);
      expect(j.annotation, label).not.toMatch(/target's own answer/);
    }

    const t = classifyExit({ command: "uptime", exitCode: 1, stdout: "", stderr: REAL.transport, context: "pod" });
    expect(t.exitClass).toBe("channel_error");
    expect(t.channelLeg).toBe("transport");
  });

  it("still lets the target's own answer through as the target's", () => {
    // The point of the leg is to stop over-claiming, not to reclassify real failures.
    const j = classifyExit({ command: "sh -c 'exit 3'", exitCode: 3, stdout: "", stderr: REAL.realFailure, context: "node" });
    expect(j.exitClass).toBe("target_reported_failure");
    expect(j.channelLeg).toBeUndefined();

    // A binary missing INSIDE a successfully entered namespace is the target's environment, not a leg.
    const dep = classifyExit({ command: "definitely-not-a-binary", exitCode: 127, stdout: "", stderr: REAL.notFound, context: "node" });
    expect(dep.exitClass).toBe("dependency_missing");
    expect(dep.channelLeg).toBeUndefined();
  });

  it("does not fire when the command produced output", () => {
    // Same guard the transport markers have: with stdout present the command ran, whatever stderr says.
    const j = classifyExit({ command: "uptime", exitCode: 1, stdout: "load average: 0.1", stderr: REAL.nsMissing, context: "node" });
    expect(j.exitClass).not.toBe("channel_error");
  });

  it("cannot be triggered by a command the agent asked for", () => {
    // Both markers are unambiguous only because neither wrapper is reachable as a user command:
    // `nsenter` is in no whitelist, and `ip netns exec` is refused by the validator. If either becomes
    // reachable, a user command failing would be reported as our own leg breaking.
    const sets = readFileSync(resolve(import.meta.dirname, "command-sets.ts"), "utf8");
    expect(sets).not.toMatch(/^\s+nsenter:\s*\{/m);
    const opts = { context: "node" as const, sensitivePathPatterns: [] as RegExp[] };
    expect(validateCommand("ip netns exec myns sh -c 'echo hi'", opts)).not.toBeNull();
  });

  it("is surfaced by every tool that classifies an exit", () => {
    // The leg is only useful if it reaches details. Four tools call classifyExit; each must pass it on,
    // and a fifth added later must too.
    const root = resolve(import.meta.dirname, "../..");
    for (const f of ["tools/cmd-exec/pod-exec.ts", "tools/cmd-exec/node-exec.ts",
                     "tools/cmd-exec/host-exec.ts", "tools/cmd-exec/restricted-bash.ts"]) {
      const src = readFileSync(resolve(root, f), "utf8");
      if (!/\bclassifyExit\s*\(/.test(src)) continue;
      expect(src, `${f} classifies an exit but drops channelLeg`).toMatch(/channel_leg:\s*judgment\.channelLeg/);
    }
  });
});

describe("an API answer is not a transport failure", () => {
  // `/^Error from server/` matched every API reply, so `kubectl get pvc missing` returning NotFound was
  // classified channel_error — whose annotation says the target never ran the command. The API server
  // answered; that is the most informative reply a kubectl call can get. Three reviews reported the
  // NotFound being counted as a tool failure; the class made it worse by naming the wrong cause.
  const err = (reason: string) => `Error from server (${reason}): the thing was not agreeable`;

  it("treats a decision by the server as the target's answer", () => {
    // NotFound is asserted separately: it is an existence ANSWER and now classifies as `no_match`
    // (isError false), which is a later, deliberate change — see "treats a NotFound on a named object as
    // the result". The rest are refusals or rejections, so they stay the target's reported failure.
    for (const reason of ["Forbidden", "AlreadyExists", "Conflict", "Invalid", "BadRequest"]) {
      const j = classifyExit({ command: "kubectl get pvc x", exitCode: 1, stdout: "", stderr: err(reason), context: "local" });
      expect(j.exitClass, reason).toBe("target_reported_failure");
      expect(j.channelLeg, reason).toBeUndefined();
    }
  });

  it("keeps the reasons that mean the request reached no decision", () => {
    for (const reason of ["Timeout", "InternalError", "ServiceUnavailable"]) {
      const j = classifyExit({ command: "kubectl get pods", exitCode: 1, stdout: "", stderr: err(reason), context: "local" });
      expect(j.exitClass, reason).toBe("channel_error");
    }
    for (const stderr of ["Error from server: etcdserver: request timed out",
                          "Error from server: dial tcp 10.0.0.1:6443: i/o timeout"]) {
      expect(classifyExit({ command: "kubectl get pods", exitCode: 1, stdout: "", stderr, context: "local" }).exitClass).toBe("channel_error");
    }
  });

  it("reads the SAME string as a channel failure when kubectl is the transport", () => {
    // One string, two meanings, separated only by context: running kubectl AS the command, NotFound is
    // an answer about a resource; running it as the transport for pod_exec, it means the pod we tried to
    // enter is gone, so the command never ran.
    for (const context of ["pod", "node", "host"]) {
      const j = classifyExit({ command: "uptime", exitCode: 1, stdout: "", stderr: err("NotFound"), context });
      expect(j.exitClass, context).toBe("channel_error");
      expect(j.channelLeg, context).toBe("transport");
    }
  });
});

describe("a capture ceiling is not a failure to start", () => {
  it("says the command RAN and its output is a prefix", () => {
    // `err.code` is the string ERR_CHILD_PROCESS_STDIO_MAXBUFFER, which the string-code branch read as
    // "the command could not be started, so the target never ran it" — the opposite of what happened,
    // over a partial prefix that then read as a complete answer. A review reported exactly that false
    // negative: a search over truncated output returning "No matches found".
    for (const opts of [
      { exitCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" as never, stderr: "" },
      { exitCode: 1, stderr: "stdout maxBuffer length exceeded" },
    ]) {
      const j = classifyExit({ command: "strings /opt/app/bin", stdout: "prefix", ...opts, context: "pod" });
      expect(j.exitClass).toBe("output_truncated");
      expect(j.isError, "it IS a failed call — the answer is incomplete").toBe(true);
      expect(j.annotation).toMatch(/RAN|proves nothing/);
      expect(j.annotation, "must not claim the command never started").not.toMatch(/never ran|could not be started/);
    }
  });

  it("leaves a real spawn failure alone", () => {
    const j = classifyExit({ command: "x", exitCode: "ENOENT" as never, stdout: "", stderr: "", context: "pod" });
    expect(j.exitClass).toBe("channel_error");
  });
});

describe("the negative half of an existence check", () => {
  it("treats ps and findmnt exit 1 as no match", () => {
    for (const command of ["ps -p 12345", "findmnt /nope", "ps -p 1 | grep x"]) {
      const j = classifyExit({ command, exitCode: 1, stdout: "", stderr: "", context: "node" });
      expect(j.exitClass, command).toBe("no_match");
      expect(j.isError, command).toBe(false);
    }
  });

  it("does NOT extend that to a target reporting a problem", () => {
    // Two reviews asked for nvidia-smi and curl to be included. They are the opposite case: those exit
    // non-zero because the target found something — an ECC fault, a failed TLS verification — and that is
    // a finding, not an empty result. `target_reported_failure` already says it is the target's own
    // answer rather than a transport fault, which is the distinction those reviews actually wanted.
    for (const [command, code] of [["nvidia-smi -q", 1], ["curl --fail https://x", 60]] as const) {
      const j = classifyExit({ command, exitCode: code, stdout: "", stderr: "", context: "node" });
      expect(j.exitClass, command).toBe("target_reported_failure");
      expect(j.isError, command).toBe(true);
    }
  });
});

describe("answers the API gave, and commands the client refused", () => {
  // Read from the traces behind the findings, not from the finding text.
  it("treats a NotFound on a named object as the result", () => {
    // Trace baf4b39b: the identical `kubectl get pvc … -o wide` ran at 18:00:58, 18:02:20 and 18:04:09.
    // Reporting the answer as a tool failure is what paid for the two extra calls.
    const j = classifyExit({
      command: "kubectl get pvc data-vol-1 -n team-ns -o wide",
      exitCode: 1, stdout: "",
      stderr: 'Error from server (NotFound): persistentvolumeclaims "data-vol-1" not found',
      context: "local",
    });
    expect(j.exitClass).toBe("no_match");
    expect(j.isError).toBe(false);
    expect(j.annotation, "and says re-running will not change it").toMatch(/same answer|SUCCEEDED/);
  });

  it("still reads the same string as a dead channel when kubectl is the transport", () => {
    // The context split matters more now that `local` NotFound is a success: for pod_exec the same text
    // means the pod we tried to enter is gone, and the command never ran.
    for (const context of ["pod", "node", "host"]) {
      const j = classifyExit({ command: "uptime", exitCode: 1, stdout: "",
        stderr: 'Error from server (NotFound): pods "gone" not found', context });
      expect(j.exitClass, context).toBe("channel_error");
    }
  });

  it("does not call a Forbidden a no-match", () => {
    // Only NotFound is an existence answer. Forbidden means the question was refused, not answered.
    const j = classifyExit({ command: "kubectl get secret x", exitCode: 1, stdout: "",
      stderr: "Error from server (Forbidden): secrets is forbidden", context: "local" });
    expect(j.exitClass).toBe("target_reported_failure");
  });

  it("separates a client-side flag rejection from the target's answer", () => {
    // Traces f5375aa8 / 10a4e8e8: `--sort-by` on `kubectl events` and `--until-time` on `kubectl logs`
    // were rejected by the CLIENT, reported as ordinary errors, and retried identically.
    for (const stderr of ["error: unknown flag: --sort-by\nSee 'kubectl events --help' for usage.",
                          "error: unknown flag: --until-time"]) {
      const j = classifyExit({ command: "kubectl events --sort-by=x", exitCode: 1, stdout: "", stderr, context: "local" });
      expect(j.exitClass).toBe("invalid_arguments");
      expect(j.annotation, "must say not to retry unchanged").toMatch(/retrying it unchanged|never reached/);
    }
  });

  it("says the timeout was ours, and what it cannot tell apart", () => {
    // Trace d95259e5: two node-proxy/logs timeouts reported only `(no output) [exit code: unknown]`.
    const j = classifyExit({ command: "kubectl logs x --tail=500000", exitCode: null, stdout: "",
      stderr: "", signal: "SIGKILL", context: "local" });
    expect(j.exitClass).toBe("interrupted");
    expect(j.annotation).toMatch(/tool's timeout/);
    expect(j.annotation, "and does not pretend to know which layer was slow").toMatch(/cannot tell/);
  });
});

describe("a printer the client does not have is a client rejection", () => {
  it("classifies it with the flag rejections, not as the target's failure", () => {
    // Four findings are `kubectl events -o wide` / `-o custom-columns`: `events` supports neither, the
    // client says so before contacting the server, and it was reported as the target's own failure.
    const j = classifyExit({
      command: "kubectl events --for node/x -o custom-columns=A:.a", exitCode: 1, stdout: "",
      stderr: 'error: unable to match a printer suitable for the output format "custom-columns"',
      context: "local",
    });
    expect(j.exitClass).toBe("invalid_arguments");
    expect(j.annotation, "and names the subcommand that does support it").toMatch(/kubectl get events/);
  });

  it("leaves a real target failure alone", () => {
    const j = classifyExit({ command: "kubectl get pods", exitCode: 1, stdout: "",
      stderr: "Error from server (Forbidden): pods is forbidden", context: "local" });
    expect(j.exitClass).toBe("target_reported_failure");
  });
});

describe("a filter that matched nothing is not an upstream failure", () => {
  const C = (command: string, pipeStatuses: number[], stdout = "", stderr = "") =>
    classifyExit({ command, exitCode: 0, stdout, stderr, context: "local", pipeStatuses });

  it("reads a middle-stage grep exit 1 as the result it is", () => {
    // The single most reported defect in the backlog — 25 findings name `pipeline_upstream_failed`.
    // Its annotation told the agent "an empty result means the EARLIER stage failed, not that nothing
    // matched", which for a no-match grep is exactly backwards.
    const j = C("kubectl logs pod-x | grep -E 'error|fail' | tail -20", [0, 1, 0]);
    expect(j.exitClass).toBe("no_match");
    expect(j.isError, "a no-match must not redden the trace").toBe(false);
    expect(j.annotation).toMatch(/matched nothing/);
    expect(j.annotation, "must say re-running changes nothing").toMatch(/same thing|same answer/i);
  });

  it("covers the counting shape too", () => {
    expect(C("kubectl get pods -A | grep foo | wc -l", [0, 1, 0], "0\n").exitClass).toBe("no_match");
  });

  it("still reports a real upstream failure", () => {
    // The false success this whole mechanism exists to remove: kubectl exits 1, jq exits 0.
    const j = C("kubectl get pods | jq .", [1, 0], "", "Error from server");
    expect(j.exitClass).toBe("pipeline_upstream_failed");
    expect(j.isError).toBe(true);
  });

  it("does not mistake a failing filter for an empty one", () => {
    // grep exits 2 on a bad regex or an unreadable file. Only 1 means "no match".
    expect(C("kubectl logs p | grep -E '[' | tail -1", [0, 2, 0]).exitClass).toBe("pipeline_upstream_failed");
  });

  it("recognises the filter through a prefix or an absolute path", () => {
    // `label()` used a bare whitespace split, which would have missed both of these and made the
    // relaxation silently inert.
    expect(C("kubectl logs p | LC_ALL=C grep -c x | tail -1", [0, 1, 0]).exitClass).toBe("no_match");
    expect(C("kubectl logs p | /bin/grep -c x | tail -1", [0, 1, 0]).exitClass).toBe("no_match");
  });

  it("withholds the relaxation when no stage can be attributed at all", () => {
    // `||` makes two three-stage pipelines equally plausible owners of the statuses, so nothing can
    // be named — and the relaxation must therefore not fire, even though a `grep` is visibly in the
    // text. The previous version of this test used a command that ALIGNS successfully, so this
    // branch had no coverage.
    const cmd = "kubectl logs p | grep zzz | tail -1 || echo a | cat | cat";
    const j = C(cmd, [0, 1, 0]);
    expect(j.exitClass).toBe("pipeline_upstream_failed");
    expect(j.isError).toBe(true);
    expect(j.annotation, "must not name a command it cannot attribute").not.toMatch(/\(grep\)|\(echo\)/);
    expect(j.annotation).toMatch(/could not be determined/);
  });

  it("still relaxes when the quoted pipe no longer misleads the splitter", () => {
    // Safety, not tidiness: with the old text split, the quoted `|` below put `grep` at subscript 1,
    // so relaxing without alignment would downgrade kubectl's real failure to `no_match`.
    const cmd = `echo "a | grep -v x" | kubectl get pods | jq .items`;
    const j = C(cmd, [0, 1, 0], "", "Error from server (NotFound)");
    expect(j.exitClass, "kubectl's failure must survive").toBe("pipeline_upstream_failed");
    expect(j.isError).toBe(true);
  });
});

describe("a degraded annotation states only what it observed", () => {
  const C = (command: string, pipeStatuses: number[]) =>
    classifyExit({ command, exitCode: 0, stdout: "", stderr: "", context: "local", pipeStatuses });

  it("names `&&`/`||` only when the command actually has one", () => {
    // Alignment fails two ways: two candidates fit (which needs a conditional), or none does. The
    // second is reachable with no `&&`/`||` anywhere, and asserting one there is its own untruth.
    expect(C("a; b | c", [1, 0, 0]).annotation).toMatch(/could not be determined/);
    expect(C("a; b | c", [1, 0, 0]).annotation).not.toMatch(/&&/);
    expect(C("false | true || echo x | true", [1, 0]).annotation).toMatch(/chains pipelines/);
  });

  it("does not claim every other stage exited 0 when one was SIGPIPE'd", () => {
    // `… | cat | head -3 | grep zzz | wc -l` gives [141,141,0,1,0] and lands in the no_match branch.
    // The verdict is right — the closure was deliberate — but the supporting clause was not.
    const j = C("seq 1 200000 | cat | head -3 | grep zzz | wc -l", [141, 141, 0, 1, 0]);
    expect(j.exitClass).toBe("no_match");
    expect(j.isError).toBe(false);
    expect(j.annotation).not.toMatch(/every other stage exited 0/);
    expect(j.annotation, "the closure should be named, not hidden").toMatch(/SIGPIPE/);
  });
});

describe("a missing metric is not a missing object", () => {
  const top = (stderr: string) =>
    classifyExit({ command: "kubectl top node css1-g65", exitCode: 1, stdout: "", stderr, context: "local" });

  it("does not claim the node does not exist", () => {
    // A trace read this node successfully from the API moments earlier, then `top` reported
    // "this object does not exist".
    const j = top('Error from server (NotFound): nodemetrics.metrics.k8s.io "css1-g65" not found');
    expect(j.exitClass).toBe("target_reported_failure");
    expect(j.annotation, "one message, two causes — it must not pick one").toMatch(/may not exist/i);
    expect(j.annotation, "must give the discriminating call").toMatch(/kubectl get node/);
  });

  it("covers the plural resource spelling, which is the commonest form", () => {
    // Enumerating `nodemetrics`/`podmetrics` missed this one entirely.
    const j = top("Error from server (NotFound): the server could not find the requested resource (get nodes.metrics.k8s.io)");
    expect(j.exitClass).toBe("target_reported_failure");
  });

  it("separates the metrics API being down from a name with no sample", () => {
    const j = top("Error from server (ServiceUnavailable): the server is currently unable to handle the request (get nodes.metrics.k8s.io)");
    expect(j.exitClass).toBe("target_reported_failure");
    expect(j.annotation).toMatch(/metrics-server/);
    expect(j.annotation, "the cluster is reachable — do not send the agent re-resolving it").toMatch(/reachable/i);
  });

  it("is checked before the channel markers, or it would be dead code", () => {
    // `Error from server (ServiceUnavailable)` is in CHANNEL_ERROR_MARKERS with no context guard, so
    // anything placed after that check never runs. Before this, `kubectl top` against a cluster with
    // no metrics-server was reported as "the target never ran the command".
    const j = top("Error from server (ServiceUnavailable): the server is currently unable to handle the request (get nodes.metrics.k8s.io)");
    expect(j.exitClass).not.toBe("channel_error");
    expect(j.channelLeg).toBeUndefined();
  });

  it("leaves non-metrics answers exactly as they were", () => {
    expect(top('Error from server (NotFound): pods "x" not found').exitClass).toBe("no_match");
    const su = classifyExit({ command: "kubectl get pods", exitCode: 1, stdout: "", context: "local",
      stderr: "Error from server (ServiceUnavailable): the server is currently unable to handle the request" });
    expect(su.exitClass, "a real transport failure is still one").toBe("channel_error");
  });
});
