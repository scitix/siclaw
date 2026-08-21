/**
 * E2E tests for container sensitive path protection.
 *
 * Verifies both pre-execution blocking (CONTAINER_SENSITIVE_PATHS via Pass 6)
 * and post-execution sanitization (output-sanitizer rules) across all exec
 * entry points: pod_exec, node_exec, and validateCommand.
 */
import { describe, it, expect } from "vitest";
import { validateCommand, globToPathRegExp } from "./command-validator.js";
import { CONTAINER_SENSITIVE_PATHS, SENSITIVE_PATH_EXAMPLES, getContextAllowedSet } from "./command-sets.js";

import { createPodExecTool } from "../cmd-exec/pod-exec.js";
import { analyzeOutput, applySanitizer } from "./output-sanitizer.js";

// ── Pre-execution: CONTAINER_SENSITIVE_PATHS pattern coverage ────────

describe("CONTAINER_SENSITIVE_PATHS pattern matching", () => {
  const blocked = [
    // K8s SA token & mounted secrets
    "cat /var/run/secrets/kubernetes.io/serviceaccount/token",
    "cat /run/secrets/my-secret/password",
    // Process info
    "cat /proc/1/environ",
    "cat /proc/42/cmdline",
    "cat /proc/1/fd/3",
    "strings /proc/1/mem",
    "cat /proc/1/maps",
    "cat /proc/1/smaps",
    "cat /proc/kcore",
    // System credentials
    "cat /etc/shadow",
    "cat /etc/gshadow",
    "cat /etc/master.passwd",
    // SSH
    "cat /root/.ssh/id_rsa",
    "cat /home/user/.ssh/authorized_keys",
    "cat id_rsa",
    "cat id_ed25519",
    "cat id_ecdsa",
    // TLS key material
    "cat /etc/ssl/server.key",
    "cat cert.p12",
    "cat keystore.pfx",
    "cat store.jks",
    // Cloud credentials
    "cat /root/.aws/credentials",
    "cat /home/user/.gcp/key.json",
    "cat /root/.azure/config",
    "cat /root/.docker/config.json",
    // K8s control plane
    "cat /etc/kubernetes/pki/ca.crt",
    "cat /etc/kubernetes/admin.conf",
    "cat /var/lib/kubelet/pki/kubelet-client.crt",
    "cat /var/lib/kubelet/pods/abc/volumes/kubernetes.io~secret/token/ca.crt",
    "cat /var/lib/etcd/member/snap/db",
    // Shell/DB history
    "cat ~/.bash_history",
    "cat ~/.zsh_history",
    "cat ~/.mysql_history",
    "cat ~/.psql_history",
    "cat ~/.node_repl_history",
  ];

  for (const cmd of blocked) {
    it(`blocks: ${cmd}`, () => {
      expect(CONTAINER_SENSITIVE_PATHS.some((re) => re.test(cmd))).toBe(true);
    });
  }

  const allowed = [
    "cat /etc/os-release",
    "cat /etc/resolv.conf",
    "ls /tmp",
    "ps aux",
    "ip addr show",
    "cat /etc/hostname",
    "cat /proc/cpuinfo",
    "cat /proc/meminfo",
    "ls /proc/net/",
    "cat /etc/ssl/certs/ca-bundle.pem",  // .pem is not blocked
    "cat /app/config.yaml",
    "df -h",
  ];

  for (const cmd of allowed) {
    it(`allows: ${cmd}`, () => {
      expect(CONTAINER_SENSITIVE_PATHS.some((re) => re.test(cmd))).toBe(false);
    });
  }
});

// ── Pre-execution: validateCommand (Pass 6) integration ─────────────

describe("validateCommand blocks sensitive paths in all contexts", () => {
  const contexts = ["pod", "node"] as const;
  const sensitiveCmds = [
    "cat /etc/shadow",
    "cat /var/run/secrets/kubernetes.io/serviceaccount/token",
    "cat /proc/1/environ",
    "head /root/.ssh/id_rsa",
    "ls /root/.aws/credentials",
    "grep password /proc/1/cmdline",
  ];

  for (const ctx of contexts) {
    for (const cmd of sensitiveCmds) {
      it(`[${ctx}] blocks: ${cmd}`, () => {
        const err = validateCommand(cmd, {
          context: ctx,
          sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
        });
        expect(err).not.toBeNull();
        // The discriminator, not the prose — the refusal now names the matched text and an
        // alternative, and a phrase assertion would break on any rewording of it.
        expect(JSON.parse(err as string).rejected_by).toBe("sensitive_path");
      });
    }
  }

  // Verify legitimate commands still pass
  for (const ctx of contexts) {
    it(`[${ctx}] allows: cat /etc/os-release`, () => {
      const err = validateCommand("cat /etc/os-release", {
        context: ctx,
        sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
      });
      expect(err).toBeNull();
    });
  }
});

// ── Pre-execution: Pass 6 gate removed (all commands checked) ───────

describe("Pass 6 checks all commands, not just FILE_READING_CMDS", () => {
  it("blocks ls with sensitive path", () => {
    const err = validateCommand("ls /var/run/secrets/", {
      context: "node",
      sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
    });
    expect(err).not.toBeNull();
  });

  it("blocks find with sensitive path", () => {
    const err = validateCommand("find /root/.ssh/ -type f", {
      context: "node",
      sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
    });
    expect(err).not.toBeNull();
  });

  it("blocks stat with sensitive path", () => {
    const err = validateCommand("stat /etc/shadow", {
      context: "node",
      sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
    });
    expect(err).not.toBeNull();
  });

  it("blocks echo with sensitive path", () => {
    const err = validateCommand("echo /var/run/secrets/token", {
      context: "node",
      sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS,
    });
    expect(err).not.toBeNull();
  });
});

// ── Pre-execution: pod_exec tool integration ────────────────────────

describe("pod_exec tool blocks sensitive paths", () => {
  const tool = createPodExecTool();

  it("blocks cat /etc/shadow", async () => {
    const result = await tool.execute(
      "test-id",
      { pod: "my-pod", command: "cat /etc/shadow" },
      undefined,
      {} as any,
    );
    expect((result.details as any).blocked).toBe(true);
    expect((result.details as any).reason).toBe("command_blocked");
  });

  it("blocks cat /var/run/secrets/...", async () => {
    const result = await tool.execute(
      "test-id",
      { pod: "my-pod", command: "cat /var/run/secrets/kubernetes.io/serviceaccount/token" },
      undefined,
      {} as any,
    );
    expect((result.details as any).blocked).toBe(true);
  });

  it("blocks cat /proc/1/environ", async () => {
    const result = await tool.execute(
      "test-id",
      { pod: "my-pod", command: "cat /proc/1/environ" },
      undefined,
      {} as any,
    );
    expect((result.details as any).blocked).toBe(true);
  });
});

// ── Post-execution: output sanitizer e2e ────────────────────────────

describe("output sanitizer e2e: file-reading commands", () => {
  it("redacts JWT in cat output", () => {
    const action = analyzeOutput("cat", ["/app/config"]);
    expect(action).not.toBeNull();
    const output = "config_line=hello\nauth_token=eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig\nnormal=data";
    const result = applySanitizer(output, action);
    expect(result).toContain("auth_token=**REDACTED**");
    expect(result).toContain("config_line=hello");
    expect(result).toContain("normal=data");
    expect(result).not.toContain("eyJhbG");
  });

  it("redacts PEM private key in cat output", () => {
    const action = analyzeOutput("cat", ["/app/cert"]);
    const output = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...";
    const result = applySanitizer(output, action);
    expect(result).toContain("**REDACTED**");
    expect(result).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("redacts connection string in grep output", () => {
    const action = analyzeOutput("grep", ["db", "/app/config"]);
    const output = "db_url=postgresql://user:password@host:5432/db";
    const result = applySanitizer(output, action);
    expect(result).toContain("**REDACTED**");
    expect(result).not.toContain("password@");
  });
});

describe("output sanitizer e2e: env/printenv", () => {
  it("redacts sensitive env vars, preserves safe ones", () => {
    const action = analyzeOutput("env", []);
    const output = [
      "PATH=/usr/bin:/bin",
      "HOME=/root",
      "DB_PASSWORD=super_secret_123",
      "API_KEY=sk-live-abc123",
      "SHELL=/bin/bash",
      "SECRET_TOKEN=mytoken",
    ].join("\n");
    const result = applySanitizer(output, action);
    expect(result).toContain("PATH=/usr/bin:/bin");
    expect(result).toContain("HOME=/root");
    expect(result).toContain("SHELL=/bin/bash");
    expect(result).toContain("DB_PASSWORD=**REDACTED**");
    expect(result).toContain("API_KEY=**REDACTED**");
    expect(result).toContain("SECRET_TOKEN=**REDACTED**");
    expect(result).not.toContain("super_secret_123");
    expect(result).not.toContain("sk-live-abc123");
    expect(result).not.toContain("mytoken");
  });

  it("redacts env var with JWT value even if key is not sensitive", () => {
    const action = analyzeOutput("printenv", []);
    const output = "MY_CUSTOM_VAR=eyJhbGciOiJSUzI1NiJ9.payload.sig";
    const result = applySanitizer(output, action);
    expect(result).toContain("MY_CUSTOM_VAR=**REDACTED**");
  });
});

describe("output sanitizer e2e: crictl inspect", () => {
  it("redacts containerd-style envs", () => {
    const action = analyzeOutput("crictl", ["inspect", "abc123"]);
    expect(action).not.toBeNull();
    const json = JSON.stringify({
      info: {
        config: {
          envs: [
            "PATH=/usr/bin",
            "DB_PASSWORD=secret123",
            "API_KEY=sk-live-abc",
            "HOME=/root",
          ],
        },
      },
    });
    const result = applySanitizer(json, action);
    const parsed = JSON.parse(result.split("\n\n⚠️")[0]);
    expect(parsed.info.config.envs).toContain("PATH=/usr/bin");
    expect(parsed.info.config.envs).toContain("HOME=/root");
    expect(parsed.info.config.envs).toContain("DB_PASSWORD=**REDACTED**");
    expect(parsed.info.config.envs).toContain("API_KEY=**REDACTED**");
  });

  it("suppresses output on JSON parse failure", () => {
    const action = analyzeOutput("crictl", ["inspect", "abc123"]);
    const result = applySanitizer("not valid json {{{", action);
    expect(result).toContain("Failed to parse");
    expect(result).not.toContain("not valid json");
  });

  it("does not sanitize crictl ps", () => {
    const action = analyzeOutput("crictl", ["ps"]);
    expect(action).toBeNull();
  });
});

describe("a sensitive path is refused however it is spelled, for every reader", () => {
  // What this actually guards — checked by reverting each part:
  //
  //   1. Quote stripping in the sensitive-path pass. Matching the raw command text alone let a single
  //      quote defeat every `$`-anchored pattern: `cat /etc/shadow` was refused, `cat "/etc/shadow"`
  //      was not, because the text the regex saw ended in `"`. 11 of 13 sensitive paths were reachable
  //      that way — /etc/{shadow,gshadow}, /proc/N/{environ,cmdline,maps}, /proc/kcore and every TLS key
  //      form (.key/.p12/.pfx/.jks). The two that held did so by accident: the unanchored `/.ssh/` rule
  //      happened to cover them. Reverting the fix brings 72 spellings back.
  //   2. Coverage of the pattern list itself — dropping a path from CONTAINER_SENSITIVE_PATHS fails here.
  //   3. That the pass stays COMMAND-AGNOSTIC. It screens any command carrying the path, which is why
  //      whitelisting a new reader does NOT open a hole — verified by moving `strings` into a category
  //      the local context admits, which changes nothing. That is worth pinning precisely because it is
  //      the property people assume is per-command and would "optimise" away.
  //
  // Defence in depth, not the primary control: children run as `sandbox`, which cannot read a
  // credential file at all. This is the layer that still holds when a command runs as the owner, and
  // the only layer that is a text decision — which is what makes a quote enough to defeat it.
  //
  // The command list is the whitelisted set that can print a file, derived by probing all 587
  // whitelisted commands across the four contexts. Only three did not refuse, and none reads a file:
  const NON_READERS = new Set([
    "printf",   // the path is a format string; it prints the literal
    "echo",     // likewise — a glob is expanded by the shell, so it can list names, never contents
    "curl",     // reads a file only via file:// / -T / -d @ / -K, each blocked separately
  ]);

  const CONTENT_PRINTERS = [
    "cat", "tac", "head", "tail", "nl", "od", "xxd", "hexdump", "strings", "base64", "base32", "basenc",
    "cut", "paste", "join", "comm", "diff", "cmp", "sort", "uniq", "shuf", "tr", "fold", "expand",
    "unexpand", "pr", "rev", "split", "csplit", "fmt", "column", "grep", "egrep", "fgrep", "zgrep",
    "sed", "awk", "perl", "tee", "jq", "yq", "wc", "look", "iconv", "zcat", "bzcat", "xzcat",
  ];

  // Literal paths only. A GLOB that expands to one of these — `cat /etc/*` reaching /etc/shadow — is a
  // real gap, but it predates this work (measured identical on the pre-PR tree) and closing it needs a
  // rule that does not also refuse `cat /etc/*release*`. Asserting it here would only pin the gap.
  //
  // The AgentBox's own credential tree is checked in `local` only, and that is not an oversight: in the
  // other three contexts the command runs inside the target container, on the node, or on a remote
  // host, where /app/.siclaw/credentials does not exist. Screening it there would refuse a path that
  // means nothing, and asserting it would pin behaviour the tool has no reason to have.
  const CONTAINER_PATHS = [
    "/etc/shadow",
    "/etc/kubernetes/admin.conf",
    "/root/.ssh/id_rsa",
    "/var/run/secrets/kubernetes.io/serviceaccount/token",
    "/var/lib/kubelet/pki/kubelet-client-current.pem",
  ];
  const AGENTBOX_PATHS = ["/app/.siclaw/credentials/clusters/x.kubeconfig"];

  it("refuses a literal sensitive operand in every context that admits the command", () => {
    const escaped: string[] = [];
    let checked = 0;
    for (const context of ["local", "pod", "node", "host"] as const) {
      const allowed = getContextAllowedSet(context);
      const opts = { context, sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS };
      const paths = context === "local" ? [...CONTAINER_PATHS, ...AGENTBOX_PATHS] : CONTAINER_PATHS;
      for (const c of new Set(CONTENT_PRINTERS)) {
        if (!allowed.has(c) || NON_READERS.has(c)) continue;
        for (const path of paths) {
          for (const p of [`${c} ${path}`, `${c} -- ${path}`, `${c} "${path}"`]) {
            checked++;
            if (validateCommand(p, opts) === null) escaped.push(`[${context}] ${p}`);
          }
        }
      }
    }
    expect(checked, "expected the whitelists to contain content-printing commands").toBeGreaterThan(200);
    expect(escaped, "these can print a file and do not screen the operand").toEqual([]);
  });
});

describe("a glob must not expand onto a sensitive path", () => {
  // `cat /etc/shadow` was refused and `cat /etc/*` was not — and the shell expands the second onto the
  // first. Screening the glob's literal prefix would have been the easy rule and the wrong one: it also
  // refuses `cat /etc/*release*`, which names no secret. So the glob is compiled to the regex of the
  // paths it can produce and tested against representative literals.
  const opts = { context: "pod" as const, sensitivePathPatterns: CONTAINER_SENSITIVE_PATHS };
  const refused = (cmd: string) => validateCommand(cmd, opts) !== null;

  it("refuses globs that can reach one", () => {
    for (const cmd of [
      "cat /etc/*", "cat /etc/kubernetes/*", "head /etc/*", "strings /etc/*",
      "cat /proc/*/environ", "cat /proc/1/fd/*", "cat /root/.ssh/*", "cat /var/run/secrets/*",
      "cat /var/lib/kubelet/pki/*", "cat /etc/ssl/private/*", "cat /root/.aws/*",
      "cat /etc/sh*", "cat /etc/?hadow", "cat /etc/[sg]hadow",   // every wildcard form
      "cat /etc/{shadow,hosts}",                                  // brace expansion
      'cat "/etc/*"',                                             // quoted — the glob still expands
      "cat /etc/**",
    ]) {
      expect(refused(cmd), cmd).toBe(true);
    }
  });

  it("names the file it would have reached", () => {
    const err = JSON.parse(validateCommand("cat /etc/*", opts) as string);
    expect(err.rejected_by).toBe("sensitive_path");
    expect(err.matched).toBe("/etc/*");
    expect(err.expands_onto).toMatch(/^\/etc\/g?shadow$|^\/etc\/master\.passwd$/);
    expect(err.hint, "the hint must be about the material, not about the glob").toBeTruthy();
  });

  it("leaves legitimate globs alone", () => {
    for (const cmd of [
      "cat /etc/*release*",          // the case a prefix rule would have broken
      "cat /etc/*.conf", "cat /etc/sysconfig/*", "ls /etc/kubernetes/manifests/*",
      "ls /proc/*/status", "cat /proc/*/status",
      "cat /var/log/*.log", "head /var/log/*", "ls /tmp/*",
      "cat /sys/class/net/*/mtu",
      // A wildcard at the start of a segment does not match a leading dot — confirmed by running a
      // shell, not recalled. Without that rule these are refused because the example list holds
      // /root/.bash_history and /root/.ssh/…, which the shell can never expand here.
      "ls /root/*", "ls /home/*",
    ]) {
      expect(refused(cmd), cmd).toBe(false);
    }
  });

  it("keeps the example list and the pattern list in step", () => {
    // The examples are what globs are tested against, so a pattern with no example leaves globs
    // unscreened for it — silently. Pinned in both directions.
    for (const re of CONTAINER_SENSITIVE_PATHS) {
      expect(
        SENSITIVE_PATH_EXAMPLES.some((e) => re.test(e)),
        `no example matches ${re} — globs are not screened for it`,
      ).toBe(true);
    }
    for (const example of SENSITIVE_PATH_EXAMPLES) {
      expect(
        CONTAINER_SENSITIVE_PATHS.some((re) => re.test(example)),
        `${example} is not matched by any pattern — a stale example widens the glob check`,
      ).toBe(true);
    }
  });

  it("compiles the glob semantics that matter", () => {
    // Asserted directly, because both are easy to get wrong in a way the payload tests above would
    // still pass by luck.
    expect(globToPathRegExp("/etc/*")!.test("/etc/shadow")).toBe(true);
    expect(globToPathRegExp("/etc/*")!.test("/etc/kubernetes/admin.conf"), "* must not cross /").toBe(false);
    expect(globToPathRegExp("/root/*")!.test("/root/.bash_history"), "* must not match a leading dot").toBe(false);
    expect(globToPathRegExp("/root/.*")!.test("/root/.bash_history"), "an explicit dot still matches").toBe(true);
    expect(globToPathRegExp("/etc/**")!.test("/etc/kubernetes/admin.conf"), "** crosses /").toBe(true);
    expect(globToPathRegExp("/etc/[")).not.toBeNull();   // an unterminated class must not throw
  });
});
