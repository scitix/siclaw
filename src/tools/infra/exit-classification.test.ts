import { describe, it, expect } from "vitest";
import { classifyExit } from "./exit-classification.js";

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
        expect(j.annotation).toContain("never ran the command");
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
