/**
 * Unit tests for command-validator.ts — the 6-pass validation pipeline.
 *
 * Per docs/design/security.md §4, every blocked command category must be
 * exercised; per docs/design/sanitization.md this file implements the
 * pre-execution "blocking" half of the two-strategy design.
 */
import { describe, it, expect } from "vitest";
import {
  extractCommands,
  extractPipeline,
  validateShellOperators,
  getContextCommands,
  validateCommand,
} from "./command-validator.js";
import { CONTAINER_SENSITIVE_PATHS } from "./command-sets.js";

// ── extractCommands ───────────────────────────────────────────────────

describe("extractCommands", () => {
  it("returns a single command for bare input", () => {
    expect(extractCommands("ls -la")).toEqual(["ls -la"]);
  });

  it("splits on | (pipe)", () => {
    expect(extractCommands("cat a | grep b | wc -l")).toEqual([
      "cat a", "grep b", "wc -l",
    ]);
  });

  it("splits on && and ||", () => {
    expect(extractCommands("a && b || c")).toEqual(["a", "b", "c"]);
  });

  it("splits on ; and single &", () => {
    expect(extractCommands("a ; b & c")).toEqual(["a", "b", "c"]);
  });

  it("keeps separators inside single and double quotes intact", () => {
    expect(extractCommands('echo "a | b ; c" ; ls')).toEqual([
      'echo "a | b ; c"', "ls",
    ]);
    expect(extractCommands("echo 'a | b' | wc")).toEqual([
      "echo 'a | b'", "wc",
    ]);
  });

  it("does not split inside subshells ( ... )", () => {
    expect(extractCommands("(a | b) && c")).toEqual(["(a | b)", "c"]);
  });

  it("preserves fd redirection &N after >", () => {
    expect(extractCommands("cmd 2>&1")).toEqual(["cmd 2>&1"]);
  });

  it("honours backslash-escaped separators outside quotes (find -exec \\;)", () => {
    const result = extractCommands("find . -name x \\; echo done");
    // \; is escaped, does not split
    expect(result).toEqual(["find . -name x \\; echo done"]);
  });

  it("returns empty array for empty input", () => {
    expect(extractCommands("")).toEqual([]);
  });

  it("trims whitespace around extracted commands", () => {
    expect(extractCommands("  ls  |  wc  ")).toEqual(["ls", "wc"]);
  });
});

// ── extractPipeline ───────────────────────────────────────────────────

describe("extractPipeline", () => {
  it("marks only commands after | as piped", () => {
    const p = extractPipeline("ls | grep x | wc");
    expect(p).toEqual([
      { command: "ls", piped: false },
      { command: "grep x", piped: true, sep: "|" },
      { command: "wc", piped: true, sep: "|" },
    ]);
  });

  it("does not mark commands after && as piped", () => {
    const p = extractPipeline("a && b");
    expect(p.map(s => s.piped)).toEqual([false, false]);
  });

  it("does not mark commands after || as piped", () => {
    const p = extractPipeline("a || b");
    expect(p.map(s => s.piped)).toEqual([false, false]);
  });

  it("does not mark commands after ; as piped", () => {
    const p = extractPipeline("a ; b");
    expect(p.map(s => s.piped)).toEqual([false, false]);
  });

  it("preserves > & fd redirection", () => {
    const p = extractPipeline("cmd 2>&1 | grep x");
    expect(p).toEqual([
      { command: "cmd 2>&1", piped: false },
      { command: "grep x", piped: true, sep: "|" },
    ]);
  });
});

// ── validateShellOperators ─────────────────────────────────────────────

describe("validateShellOperators", () => {
  it("returns null for a plain command", () => {
    expect(validateShellOperators("ls -la")).toBeNull();
  });

  it("blocks newline characters (smuggling past whitelist)", () => {
    const err = validateShellOperators("ls\nrm -rf /");
    expect(err).not.toBeNull();
    expect(err).toContain("Newline");
  });

  it("blocks carriage return characters", () => {
    expect(validateShellOperators("ls\rmalicious")).not.toBeNull();
  });

  it("blocks backticks even inside quotes", () => {
    expect(validateShellOperators("echo `whoami`")).not.toBeNull();
    expect(validateShellOperators('echo "`whoami`"')).not.toBeNull();
  });

  it("blocks $( ) command substitution even inside quotes", () => {
    expect(validateShellOperators("echo $(whoami)")).not.toBeNull();
    expect(validateShellOperators('echo "$(whoami)"')).not.toBeNull();
  });

  it("blocks <() process substitution", () => {
    expect(validateShellOperators("diff <(cat a) <(cat b)")).not.toBeNull();
  });

  it("blocks bare input redirection <", () => {
    expect(validateShellOperators("cat < file")).not.toBeNull();
  });

  it("blocks >() process substitution", () => {
    expect(validateShellOperators("tee >(cat)")).not.toBeNull();
  });

  it("blocks > output redirection to a file", () => {
    expect(validateShellOperators("ls > out.txt")).not.toBeNull();
  });

  it("blocks >> append redirection", () => {
    expect(validateShellOperators("ls >> out.txt")).not.toBeNull();
  });

  it("allows > /dev/null", () => {
    expect(validateShellOperators("ls > /dev/null")).toBeNull();
    expect(validateShellOperators("ls 2> /dev/null")).toBeNull();
  });

  it("allows fd duplication (e.g. 2>&1, >&2)", () => {
    expect(validateShellOperators("ls 2>&1")).toBeNull();
    expect(validateShellOperators("echo err >&2")).toBeNull();
  });
});

// ── getContextCommands ─────────────────────────────────────────────────

describe("getContextCommands", () => {
  it("returns a non-empty set for each exec context", () => {
    for (const ctx of ["local", "node", "pod", "host"] as const) {
      expect(getContextCommands(ctx).size).toBeGreaterThan(0);
    }
  });

  it("does NOT include kubectl in the local context (injected via extraAllowed)", () => {
    expect(getContextCommands("local").has("kubectl")).toBe(false);
  });

  it("excludes explicitly excluded binaries from every context", () => {
    // per security.md §4.5
    for (const ctx of ["local", "node", "pod"] as const) {
      const cmds = getContextCommands(ctx);
      expect(cmds.has("sed")).toBe(false);
      expect(cmds.has("awk")).toBe(false);
      expect(cmds.has("gawk")).toBe(false);
      expect(cmds.has("nc")).toBe(false);
      expect(cmds.has("netcat")).toBe(false);
      expect(cmds.has("ncat")).toBe(false);
      expect(cmds.has("wget")).toBe(false);
      expect(cmds.has("bash")).toBe(false);
      expect(cmds.has("bc")).toBe(false);
    }
  });
});

// ── validateCommand — happy path and rejections ────────────────────────

describe("validateCommand — empty input", () => {
  it("rejects empty string", () => {
    expect(validateCommand("")).toBe("Command must not be empty.");
  });

  it("rejects whitespace-only input", () => {
    expect(validateCommand("   ")).toBe("Command must not be empty.");
  });
});

describe("validateCommand — shell operator blocking (Pass 1)", () => {
  it("blocks $()", () => {
    expect(validateCommand("echo $(id)")).not.toBeNull();
  });

  it("blocks backticks", () => {
    expect(validateCommand("echo `id`")).not.toBeNull();
  });

  it("blocks > file redirection", () => {
    expect(validateCommand("ls > /tmp/out")).not.toBeNull();
  });

  it("blocks <() process substitution", () => {
    expect(validateCommand("diff <(a) <(b)")).not.toBeNull();
  });

  it("blocks newlines used to smuggle commands", () => {
    expect(validateCommand("ls\nrm -rf /")).not.toBeNull();
  });
});

describe("validateCommand — context whitelist (Pass 3)", () => {
  it("allows grep in a pipeline under local context", () => {
    // "echo hi | grep h" — both echo and grep are in local context
    expect(validateCommand("echo hi | grep h", { context: "local" })).toBeNull();
  });

  it("blocks commands outside the context whitelist", () => {
    // `docker` isn't in any whitelist
    const err = validateCommand("docker ps", { context: "node" });
    expect(err).not.toBeNull();
    expect(err).toContain("Blocked");
    expect(err).toContain("docker");
  });

  it("honours extraAllowed for extra commands (e.g. kubectl in local)", () => {
    expect(validateCommand("kubectl get pods", {
      context: "local",
      extraAllowed: new Set(["kubectl"]),
    })).toBeNull();
  });

  it("honours isAllowed callback for skill scripts", () => {
    const err = validateCommand("my-skill-script --opt", {
      context: "local",
      isAllowed: (cmd) => cmd.startsWith("my-skill-script"),
    });
    expect(err).toBeNull();
  });

  it("returns the allowed-list in the error payload", () => {
    const err = validateCommand("unknown-binary", { context: "node" });
    expect(err).not.toBeNull();
    const parsed = JSON.parse(err!);
    expect(Array.isArray(parsed.allowed)).toBe(true);
    expect(parsed.allowed.length).toBeGreaterThan(0);
  });
});

describe("validateCommand — explicitly excluded binaries", () => {
  // security.md §4.5
  const blocked = ["sed", "awk", "gawk", "bc", "nc", "netcat", "ncat", "wget", "bash", "sh"];
  for (const b of blocked) {
    it(`blocks "${b}" across local/node/pod contexts`, () => {
      for (const ctx of ["local", "node", "pod"] as const) {
        const err = validateCommand(`${b} something`, { context: ctx });
        expect(err).not.toBeNull();
      }
    });
  }
});

describe("validateCommand — pipelineValidators (Pass 4)", () => {
  it("runs pipeline validators and returns their error", () => {
    const err = validateCommand("echo hi | grep x", {
      context: "local",
      pipelineValidators: [(_cmds) => "custom pipeline error"],
    });
    expect(err).toBe("custom pipeline error");
  });

  it("passes when pipeline validators return null", () => {
    expect(validateCommand("echo hi", {
      context: "local",
      pipelineValidators: [() => null],
    })).toBeNull();
  });
});

describe("validateCommand — blockPipeline option", () => {
  it("rejects pipelines when blockPipeline=true", () => {
    const err = validateCommand("echo hi | grep h", {
      context: "local",
      blockPipeline: true,
    });
    expect(err).not.toBeNull();
    expect(err).toContain("Pipes");
  });

  it("allows single commands when blockPipeline=true", () => {
    expect(validateCommand("echo hi", {
      context: "local",
      blockPipeline: true,
    })).toBeNull();
  });

  it("rejects chained commands (&&) when blockPipeline=true", () => {
    expect(validateCommand("echo hi && echo bye", {
      context: "local",
      blockPipeline: true,
    })).not.toBeNull();
  });
});

describe("validateCommand — sensitive path patterns (Pass 6)", () => {
  // security.md §4.2 — use the real pattern set
  const patterns = CONTAINER_SENSITIVE_PATHS;

  const blocked = [
    "cat /var/run/secrets/kubernetes.io/serviceaccount/token",
    "cat /run/secrets/x/pw",
    "cat /proc/1/environ",
    "cat /proc/42/cmdline",
    "cat /proc/1/mem",
    "cat /proc/1/maps",
    "cat /proc/1/smaps",
    "cat /proc/kcore",
    "cat /etc/shadow",
    "cat /etc/gshadow",
    "cat /etc/master.passwd",
    "cat /root/.ssh/id_rsa",
    "cat id_rsa",
    "cat id_ed25519",
    "cat id_ecdsa",
    "cat /etc/ssl/server.key",
    "cat cert.p12",
    "cat ks.pfx",
    "cat ks.jks",
    "cat /root/.aws/credentials",
    "cat /root/.gcp/key.json",
    "cat /root/.azure/cfg",
    "cat /root/.docker/config.json",
    "cat /etc/kubernetes/pki/ca.crt",
    "cat /etc/kubernetes/admin.conf",
    "cat /var/lib/kubelet/pki/kubelet-client.crt",
    "cat /var/lib/etcd/snap/db",
    "cat ~/.bash_history",
    "cat ~/.zsh_history",
    "cat ~/.mysql_history",
    "cat ~/.psql_history",
    "cat ~/.node_repl_history",
  ];

  for (const cmd of blocked) {
    it(`blocks: ${cmd}`, () => {
      const err = validateCommand(cmd, {
        context: "node",
        sensitivePathPatterns: patterns,
      });
      expect(err).not.toBeNull();
      // Asserted on the machine-readable discriminator, not on the prose: the refusal text now names
      // what matched and what to do instead, and a phrase assertion would only restate whatever
      // wording it happens to have.
      expect(JSON.parse(err as string).rejected_by).toBe("sensitive_path");
    });
  }

  it("passes harmless paths when sensitive patterns are enabled", () => {
    expect(validateCommand("cat /etc/os-release", {
      context: "node",
      sensitivePathPatterns: patterns,
    })).toBeNull();
  });

  it("checks all pipeline segments, not just the first", () => {
    const err = validateCommand("echo hi | cat /etc/shadow", {
      context: "node",
      sensitivePathPatterns: patterns,
    });
    expect(err).not.toBeNull();
    expect(JSON.parse(err as string).rejected_by).toBe("sensitive_path");
  });
});

describe("validateCommand — restrictions wiring (Pass 5)", () => {
  // These are covered in depth by command-sets.test.ts; spot-check that
  // validateCommand actually invokes the per-command restriction engine.
  it("blocks curl -d (data flag — exfiltration)", () => {
    const err = validateCommand("curl -d foo=bar http://x", { context: "node" });
    expect(err).not.toBeNull();
  });

  it("blocks env <cmd> (command execution via env)", () => {
    const err = validateCommand("env ls", { context: "node" });
    expect(err).not.toBeNull();
    expect(err).toContain("env");
  });

  it("blocks sort -o (output-to-file restriction)", () => {
    const err = validateCommand("sort -o /tmp/x file", { context: "node" });
    expect(err).not.toBeNull();
  });
});

describe("validateCommand — happy paths", () => {
  it("accepts basic diagnostic pipeline in local context", () => {
    expect(validateCommand("echo hello | grep h | wc -l", { context: "local" })).toBeNull();
  });

  it("accepts ip addr show in node context", () => {
    expect(validateCommand("ip addr show", { context: "node" })).toBeNull();
  });

  it("accepts ps aux in node context", () => {
    expect(validateCommand("ps aux", { context: "node" })).toBeNull();
  });
});

describe("a sensitive-path refusal says what matched and what to do instead", () => {
  const node = { context: "node" as const, sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS };
  const refusal = (cmd: string) => JSON.parse(validateCommand(cmd, node) as string);

  it("names the matched text and the rule, instead of a bare denial", () => {
    // "Accessing sensitive paths is not allowed" told the agent nothing: not which argument, not
    // whether the command itself was the problem. The usual response was to try another command and
    // be refused again.
    const r = refusal("cat /etc/kubernetes/pki/ca.key");
    expect(r.matched).toBe(".key");
    expect(r.rejected_by).toBe("sensitive_path");
    expect(r.hint).toContain(".crt");
  });

  it("gives advice that fits the kind of secret", () => {
    expect(refusal("cat /root/.ssh/id_rsa").hint).toContain("host_exec");
    expect(refusal("cat /var/run/secrets/kubernetes.io/serviceaccount/token").hint).toContain("mounted");
    expect(refusal("cat /proc/1/environ").hint).toContain("ps");
    expect(refusal("cat /etc/shadow").hint).toContain("getent");
    expect(refusal("cat /root/.aws/credentials").hint).toContain("image-pull");
  });

  it("still refuses — the hint is guidance, not a way through", () => {
    for (const cmd of ["cat /etc/shadow", "cat /root/.ssh/id_ed25519", "head /proc/1/environ"]) {
      expect(validateCommand(cmd, node)).not.toBeNull();
    }
  });
});

describe("refusals name what does work", () => {
  it("tells a rejected shell loop that semicolons are supported", () => {
    // Trace 026ab91c: `for … done` was refused with the whole allow-list, which reads as "we have never
    // heard of `for`"; the very next call used `cmd; cmd; cmd` successfully. The capability was there,
    // the guidance was not.
    const err = validateCommand("for p in a b c; do kubectl logs $p; done", {
      context: "local", sensitivePathPatterns: [], extraAllowed: new Set(["kubectl"]),
    }) ?? "";
    const parsed = JSON.parse(err);
    expect(parsed.shell_constructs_rejected, "keywords are separated from missing binaries").toContain("for");
    expect(parsed.hint).toMatch(/Semicolon-separated/);
  });

  it("names ps as the substitute for a blocked cmdline", () => {
    // node_exec b4d9c4b9: status and stack were permitted for the same PID while cmdline was refused,
    // with no alternative given. The asymmetry is deliberate — a command line carries credentials in its
    // arguments — so the refusal has to point somewhere.
    const err = validateCommand("cat /proc/1627110/cmdline", {
      context: "node", sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
    }) ?? "";
    expect(err).toContain("ps -p");
    expect(err).toContain("/proc/<pid>/status");
  });
});

describe("a sensitive-output source cannot feed a pipe", () => {
  const nd = { context: "node" as const, sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS };
  it("refuses env and printenv into a pipe", () => {
    // env output is redacted by matching `KEY=`, and that applies to the LAST stage. Measured leaking:
    // `printenv PASSWORD | cut -c1-` prints a bare value with no key at all, and
    // `env | grep PASSWORD | cut -d= -f2-` strips the key before anything sees it.
    for (const cmd of ["printenv PASSWORD | cut -c1-", "env | grep PASSWORD | cut -d= -f2-",
                       "env | grep PASSWORD", "printenv | grep KEY", "env | head -20"]) {
      expect(validateCommand(cmd, nd), cmd).not.toBeNull();
    }
  });

  it("names the alternative, because refusing the filter has a real cost", () => {
    const err = validateCommand("env | grep PASSWORD", nd) ?? "";
    expect(err).toMatch(/on its own/);
    expect(err, "and says the unpiped output is already redacted").toMatch(/redacted/);
  });

  it("leaves the unpiped forms and unrelated pipes alone", () => {
    for (const cmd of ["printenv PASSWORD", "printenv HOME", "env", "printenv",
                       "cat /etc/hosts | grep localhost", "ip -j addr | jq ."]) {
      expect(validateCommand(cmd, nd), cmd).toBeNull();
    }
  });
});

describe("a single quote is not escapable", () => {
  const nd = { context: "node" as const, sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS };
  it("closes on the next quote, so the second command is seen", () => {
    // bash gives a backslash NO special meaning inside `'…'`, so `echo 'x\'; cmd` is TWO commands —
    // confirmed by running a shell, which printed both. Three tokenizers here counted preceding
    // backslashes regardless of quote type and read it as one `echo`, so every downstream check saw only
    // that: the disallowed-command list, the kubectl verb rules, the redirection ban. It applies to
    // restricted_bash, node_exec and host_exec, which all hand the string to a shell.
    for (const cmd of ["echo 'x\\'; kubectl delete pod victim", "true 'x\\'; rm harmless",
                       "echo 'x\\'; echo hi > /tmp/out", "echo 'x\\'; ip link set eth0 down"]) {
      expect(extractCommands(cmd).length, cmd).toBe(2);
      expect(validateCommand(cmd, nd), cmd).not.toBeNull();
    }
  });

  it("still honours escapes where bash does", () => {
    // `"…"` and `$'…'` DO process a backslash, so the count still decides there — and a `;` inside any
    // quote is data, not a separator.
    expect(extractCommands('echo "a\\"; b"').length, "escaped quote inside double quotes").toBe(1);
    expect(extractCommands("grep 'a;b' /var/log/x").length).toBe(1);
    expect(extractCommands('grep "a;b" /var/log/x').length).toBe(1);
    expect(validateCommand("grep 'a;b' /var/log/x", nd)).toBeNull();
  });
});
