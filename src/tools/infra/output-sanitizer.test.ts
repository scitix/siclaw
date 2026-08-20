import { kubectlSubcommand, crictlSubcommand } from "./kubectl-sanitize.js";
import { argsNameSecrets } from "./command-sets.js";
import { detectSensitiveResource } from "./kubectl-sanitize.js";
import { describe, it, expect } from "vitest";
import { analyzeOutput, applySanitizer, type OutputAction, redactSensitiveContent } from "./output-sanitizer.js";

// ── analyzeOutput ────────────────────────────────────────────────────

describe("analyzeOutput", () => {
  describe("kubectl rules", () => {
    // Secret
    it("returns sanitize for get secret -o json", () => {
      const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-o", "json"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for get secret -o yaml (line-level redaction)", () => {
      const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-o", "yaml"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for get secret -o=yaml", () => {
      const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-o=yaml"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for get secret -oyaml", () => {
      const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-oyaml"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns null for get secret (default table)", () => {
      expect(analyzeOutput("kubectl", ["get", "secret", "-A"])).toBeNull();
    });

    it("returns null for get secret -o wide", () => {
      expect(analyzeOutput("kubectl", ["get", "secret", "-o", "wide"])).toBeNull();
    });

    it("returns null for get secret -o name", () => {
      expect(analyzeOutput("kubectl", ["get", "secret", "-o", "name"])).toBeNull();
    });

    // jsonpath/go-template → line-level sanitization
    it("returns sanitize for get secret -o jsonpath", () => {
      const action = analyzeOutput("kubectl", ["get", "secret", "-o", "jsonpath={.data}"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    // ConfigMap
    it("returns sanitize for get configmap -o json", () => {
      const action = analyzeOutput("kubectl", ["get", "configmap", "my-cm", "-o", "json"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for get cm -o json", () => {
      const action = analyzeOutput("kubectl", ["get", "cm", "my-cm", "-o", "json"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    // Pod
    it("returns sanitize for get pod -o json", () => {
      const action = analyzeOutput("kubectl", ["get", "pod", "my-pod", "-o", "json"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for get pods -o yaml (line-level redaction)", () => {
      const action = analyzeOutput("kubectl", ["get", "pods", "-A", "-o", "yaml"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    // Non-sensitive resources
    it("returns null for get deployment -o json", () => {
      expect(analyzeOutput("kubectl", ["get", "deployment", "-o", "json"])).toBeNull();
    });

    it("returns null for get svc -o yaml", () => {
      expect(analyzeOutput("kubectl", ["get", "svc", "-o", "yaml"])).toBeNull();
    });

    // describe: sanitize configmap/pod, null for secret (shows byte counts only)
    it("returns null for describe secret (safe — shows byte counts)", () => {
      expect(analyzeOutput("kubectl", ["describe", "secret", "my-secret"])).toBeNull();
    });

    it("returns sanitize for describe configmap", () => {
      const action = analyzeOutput("kubectl", ["describe", "configmap", "my-cm"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for describe pod", () => {
      const action = analyzeOutput("kubectl", ["describe", "pod", "my-pod"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    // Other subcommands
    it("returns null for logs", () => {
      expect(analyzeOutput("kubectl", ["logs", "my-pod"])).toBeNull();
    });

    it("returns null for version", () => {
      expect(analyzeOutput("kubectl", ["version"])).toBeNull();
    });

    // Flags interspersed
    it("handles flags before resource type", () => {
      const action = analyzeOutput("kubectl", ["get", "-n", "kube-system", "secret", "-o", "json"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });
  });

  describe("file-reading commands", () => {
    it("returns sanitize for cat", () => {
      const action = analyzeOutput("cat", ["/etc/config"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for head", () => {
      const action = analyzeOutput("head", ["-20", "/var/log/app.log"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for grep", () => {
      const action = analyzeOutput("grep", ["pattern", "/etc/config"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });
  });

  describe("env/printenv commands", () => {
    it("returns sanitize for env", () => {
      const action = analyzeOutput("env", []);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for printenv", () => {
      const action = analyzeOutput("printenv", []);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });
  });

  describe("crictl commands", () => {
    it("returns sanitize for crictl inspect", () => {
      const action = analyzeOutput("crictl", ["inspect", "abc123"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns sanitize for crictl inspecti", () => {
      const action = analyzeOutput("crictl", ["inspecti", "img123"]);
      expect(action).not.toBeNull();
      expect(action!.type).toBe("sanitize");
    });

    it("returns null for crictl ps", () => {
      expect(analyzeOutput("crictl", ["ps"])).toBeNull();
    });

    it("returns null for crictl logs", () => {
      expect(analyzeOutput("crictl", ["logs", "abc123"])).toBeNull();
    });
  });

  describe("unregistered commands", () => {
    it("returns null for unknown binary", () => {
      expect(analyzeOutput("some-tool", ["arg1"])).toBeNull();
    });

    it("returns null for ls", () => {
      expect(analyzeOutput("ls", ["/tmp"])).toBeNull();
    });
  });
});

// ── applySanitizer ───────────────────────────────────────────────────

describe("applySanitizer", () => {
  it("returns original output when action is null", () => {
    expect(applySanitizer("raw output", null)).toBe("raw output");
  });

  it("applies sanitize function for sanitize action", () => {
    const action: OutputAction = {
      type: "sanitize",
      sanitize: (o) => o.replace(/secret/g, "***"),
    };
    expect(applySanitizer("my secret data", action)).toBe("my *** data");
  });

  it("returns original output when sanitize is identity", () => {
    const action: OutputAction = {
      type: "sanitize",
      sanitize: (o) => o,
    };
    expect(applySanitizer("output", action)).toBe("output");
  });
});

// ── Integration: kubectl sanitize via framework ──────────────────────

describe("kubectl sanitize via framework", () => {
  it("sanitizes Secret JSON output end-to-end", () => {
    const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-o", "json"]);
    expect(action).not.toBeNull();

    const secretJson = JSON.stringify({
      kind: "Secret",
      metadata: { name: "my-secret" },
      data: { password: "cGFzc3dvcmQ=" },
    });

    const result = applySanitizer(secretJson, action);
    expect(result).toContain("**REDACTED**");
    expect(result).not.toContain("cGFzc3dvcmQ=");
    expect(result).toContain("my-secret"); // metadata preserved
  });

  it("sanitizes ConfigMap JSON output end-to-end", () => {
    const action = analyzeOutput("kubectl", ["get", "configmap", "my-cm", "-o", "json"]);
    expect(action).not.toBeNull();

    const cmJson = JSON.stringify({
      kind: "ConfigMap",
      data: {
        "db.password": "secret123",
        "log.level": "debug",
      },
    });

    const result = applySanitizer(cmJson, action);
    expect(result).toContain("**REDACTED**"); // db.password redacted
    expect(result).toContain("debug");        // log.level preserved
  });

  it("sanitizes Secret YAML output via line-level redaction", () => {
    const action = analyzeOutput("kubectl", ["get", "secret", "my-secret", "-o", "yaml"]);
    expect(action).not.toBeNull();
    expect(action!.type).toBe("sanitize");

    const yamlOutput = "apiVersion: v1\nkind: Secret\ndata:\n  password: cGFzc3dvcmQ=\n  username: YWRtaW4=";
    const result = applySanitizer(yamlOutput, action);
    expect(result).toContain("**REDACTED**"); // password key matches
    expect(result).toContain("username"); // username key doesn't match sensitive patterns
  });
});

// ── Integration: file-reading sanitize ──────────────────────────────

describe("file-reading content sanitization", () => {
  it("redacts JWT tokens in file output", () => {
    const action = analyzeOutput("cat", ["/app/config"]);
    const output = "normal line\ntoken: eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig\nmore data";
    const result = applySanitizer(output, action);
    expect(result).toContain("**REDACTED**");
    expect(result).not.toContain("eyJhbGci");
    expect(result).toContain("normal line");
    expect(result).toContain("more data");
  });

  it("redacts PEM private keys", () => {
    const action = analyzeOutput("cat", ["/app/cert"]);
    const output = "-----BEGIN RSA PRIVATE KEY-----\nMIIE...";
    const result = applySanitizer(output, action);
    expect(result).toContain("**REDACTED**");
  });

  it("redacts KEY=VALUE with sensitive key name", () => {
    const action = analyzeOutput("grep", ["password", "/etc/config"]);
    const output = "DB_PASSWORD=secret123\nDB_HOST=localhost";
    const result = applySanitizer(output, action);
    expect(result).toContain("DB_PASSWORD=**REDACTED**");
    expect(result).toContain("DB_HOST=localhost");
  });

  it("redacts an Authorization header without touching authorization-mode", () => {
    const action = analyzeOutput("cat", ["/app/config.yaml"]);
    const output = [
      "    authorization-mode: Node,RBAC",
      "    headers:",
      "      Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def",
    ].join("\n");
    const result = applySanitizer(output, action);
    // apiserver flags are diagnostic, not credentials.
    expect(result).toContain("authorization-mode: Node,RBAC");
    expect(result).toContain("      Authorization: **REDACTED**");
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("redacts YAML-style key: value with sensitive key name", () => {
    const action = analyzeOutput("cat", ["/app/config.yaml"]);
    const output = "database:\n  password: mysecret\n  host: localhost";
    const result = applySanitizer(output, action);
    expect(result).toContain("password: **REDACTED**");
    expect(result).toContain("host: localhost");
  });

  it("leaves non-sensitive output unchanged", () => {
    const action = analyzeOutput("cat", ["/etc/os-release"]);
    const output = "NAME=Ubuntu\nVERSION=22.04";
    const result = applySanitizer(output, action);
    expect(result).toBe(output); // no redaction warning appended
  });
});

// ── Integration: env/printenv sanitize ──────────────────────────────

describe("env/printenv output sanitization", () => {
  it("redacts sensitive env vars by key name", () => {
    const action = analyzeOutput("env", []);
    const output = "PATH=/usr/bin\nDB_PASSWORD=secret123\nHOME=/root\nAPI_KEY=sk-abc123";
    const result = applySanitizer(output, action);
    expect(result).toContain("DB_PASSWORD=**REDACTED**");
    expect(result).toContain("API_KEY=**REDACTED**");
    expect(result).toContain("PATH=/usr/bin");
    expect(result).toContain("HOME=/root");
  });

  it("redacts env vars with JWT values", () => {
    const action = analyzeOutput("printenv", []);
    const output = "AUTH_HEADER=eyJhbGciOiJSUzI1NiJ9.payload.sig";
    const result = applySanitizer(output, action);
    expect(result).toContain("AUTH_HEADER=**REDACTED**");
  });

  it("leaves non-sensitive env vars unchanged", () => {
    const action = analyzeOutput("env", []);
    const output = "PATH=/usr/bin\nHOME=/root\nSHELL=/bin/bash";
    const result = applySanitizer(output, action);
    expect(result).toBe(output);
  });
});

// ── Integration: crictl inspect sanitize ────────────────────────────

describe("crictl inspect output sanitization", () => {
  it("redacts containerd-style envs (KEY=VALUE strings)", () => {
    const action = analyzeOutput("crictl", ["inspect", "abc123"]);
    const json = JSON.stringify({
      info: {
        config: {
          envs: ["PATH=/usr/bin", "DB_PASSWORD=secret123", "HOME=/root"],
        },
      },
    });
    const result = applySanitizer(json, action);
    expect(result).toContain("DB_PASSWORD=**REDACTED**");
    expect(result).toContain("PATH=/usr/bin");
    expect(result).toContain("HOME=/root");
  });

  it("suppresses output on JSON parse failure", () => {
    const action = analyzeOutput("crictl", ["inspect", "abc123"]);
    const result = applySanitizer("not json {{{", action);
    expect(result).toContain("Failed to parse");
    expect(result).not.toContain("not json");
  });

  it("handles missing envs gracefully", () => {
    const action = analyzeOutput("crictl", ["inspect", "abc123"]);
    const json = JSON.stringify({ info: { config: {} } });
    const result = applySanitizer(json, action);
    expect(result).not.toContain("REDACTED");
  });
});

describe("a cross-line redactor is not line-safe", () => {
  // `redactSensitiveContent` routes through `redactDocument`, which carries state across lines so the
  // BODY of a PEM key, a YAML block scalar and a mapping nested under a sensitive key are redacted
  // along with the marker line that introduces them. The streaming sanitizer calls a line-safe action
  // once per batch of complete lines with NO state between calls, so a secret split across two batches
  // had its BEGIN line redacted and its body written to the task output verbatim — with the redaction
  // notice attached, which is worse than no claim.
  //
  // `lineSafe: false` makes the fail-closed guard in SanitizingLineBuffer refuse to background these
  // instead. The commands that matter for background monitoring are unaffected: `kubectl logs -f`,
  // `journalctl -f` and `tcpdump` resolve to no sanitizer at all.
  it("marks the file-reading commands as not streamable", () => {
    for (const cmd of ["cat", "head", "tail", "grep", "egrep", "fgrep", "strings", "zcat", "zgrep"]) {
      const action = analyzeOutput(cmd, ["/var/log/x"]);
      expect(action, cmd).not.toBeNull();
      expect(action!.lineSafe, cmd).toBe(false);
    }
  });

  it("marks kubectl's non-JSON and describe paths as not streamable", () => {
    expect(analyzeOutput("kubectl", ["get", "cm", "-o", "yaml"])!.lineSafe).toBe(false);
    expect(analyzeOutput("kubectl", ["describe", "cm", "x"])!.lineSafe).toBe(false);
  });

  it("leaves the background workhorses alone", () => {
    // No sanitizer resolves for these, so `lineSafe` never enters the picture and they stay
    // backgroundable — which is what keeps this change from costing log monitoring.
    expect(analyzeOutput("kubectl", ["logs", "mypod", "-f"])).toBeNull();
    expect(analyzeOutput("journalctl", ["-u", "kubelet", "-f"])).toBeNull();
    expect(analyzeOutput("tcpdump", ["-i", "eth0"])).toBeNull();
  });

  it("demonstrates why: a PEM split across two batches leaks its body per-line", () => {
    // The reason the declaration had to change, shown rather than asserted in prose.
    const pem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA1234567890LEAKED",
      "-----END RSA PRIVATE KEY-----",
    ];
    const wholeDocument = redactSensitiveContent(pem.join("\n"));
    expect(wholeDocument).not.toContain("MIIEowIBAAKCAQEA");

    const perBatch = pem.map((line) => redactSensitiveContent(line)).join("\n");
    expect(perBatch).toContain("MIIEowIBAAKCAQEA");   // ← what streaming would have written
  });
});

describe("one reading of a kubectl command, for the validator and the sanitizer alike", () => {
  const CANARY = "c3VwZXItc2VjcmV0";
  const secretJson = JSON.stringify({ kind: "Secret", metadata: { name: "demo" }, data: { password: CANARY } });
  const sanitized = (args: string[]) => {
    const action = analyzeOutput("kubectl", args);
    return action ? applySanitizer(secretJson, action) : secretJson;
  };

  it("sees past a global flag placed before the verb", () => {
    // The rule took the first non-dash argument as the subcommand, so `kubectl -n default get secret …`
    // read as subcommand "default", no rule matched, and the Secret came back verbatim. A global flag
    // before the verb is ordinary kubectl usage, and the flag-arity table needed to see past it already
    // existed in this file — used by detectSensitiveResource and not by this.
    for (const args of [["-n", "default", "get", "secret", "demo", "-o", "json"],
                        ["--context", "prod", "get", "secret", "demo", "-o", "json"],
                        ["--kubeconfig", "/tmp/kc", "get", "secret", "demo", "-o", "json"],
                        ["get", "secret", "demo", "-o", "json"]]) {
      expect(sanitized(args), args.join(" ")).not.toContain(CANARY);
    }
  });

  it("normalises a typed resource name the way the validator does", () => {
    // kubectl accepts `type.version[.group]`, with a TRAILING dot for a core resource. The validator
    // learned that and permitted `-o json` for it — which is permitted BECAUSE the structural sanitizer
    // redacts `data` — while this side still split only on `/`, so no sanitizer attached at all. Both now
    // call the same normaliser, and a test below pins that they agree.
    for (const resource of ["secret", "secrets", "secret.v1.", "secrets.", "secrets.v1.", "secret/demo"]) {
      expect(sanitized(["get", resource, "demo", "-o", "json"]), resource).not.toContain(CANARY);
    }
  });

  it("the validator and the sanitizer agree about what names a Secret", () => {
    // The guard against this pair drifting again. Anything the validator treats as a Secret read must
    // also attach a sanitizer, or `-o json` is permitted on the strength of redaction that never runs.
    for (const resource of ["secret", "secrets", "secret.v1.", "secrets.", "secret/demo", "pod,secret",
                            "secret,pod", "pod,secret/demo"]) {
      const args = ["get", resource, "demo", "-o", "json"];
      const namedByValidator = argsNameSecrets(args, "get");
      const seenBySanitizer = detectSensitiveResource(args) === "secret"
        || analyzeOutput("kubectl", args) !== null;
      expect(seenBySanitizer, `${resource}: validator=${namedByValidator}`).toBe(namedByValidator);
    }
  });
});

describe("env and printenv output the redactor could not key on", () => {
  const NUL = String.fromCharCode(0);
  const out = (bin: string, args: string[], payload: string) => {
    const action = analyzeOutput(bin, args);
    return action ? applySanitizer(payload, action) : payload;
  };

  it("redacts a bare value when the NAME was in the argv", () => {
    // `printenv PASSWORD` prints the value ALONE — no `KEY=` for a line redactor to match, so it came
    // back verbatim. The name is only in the arguments, and the whole output is that one value.
    expect(out("printenv", ["PASSWORD"], "super-secret")).not.toContain("super-secret");
    expect(out("printenv", ["API_KEY"], "abc123")).not.toContain("abc123");
    // A harmless name is untouched.
    expect(out("printenv", ["HOME"], "/root")).toContain("/root");
  });

  it("splits on NUL when the caller asked for NUL", () => {
    // `-0` separates records with NUL. Splitting on newlines left the whole thing as one record whose
    // first KEY= decided everything, so the second half kept its secret.
    const payload = `SAFE=x${NUL}API_KEY=zzz`;
    for (const bin of ["env", "printenv"]) {
      const r = out(bin, ["-0"], payload);
      expect(r, bin).not.toContain("zzz");
      expect(r, bin).toContain("SAFE=x");
    }
    // And it is no longer claimed to be streamable per line, because it has no lines.
    expect(analyzeOutput("env", ["-0"])?.lineSafe).toBe(false);
    expect(analyzeOutput("env", [])?.lineSafe).toBe(true);
  });

  it("redacts a multi-line value to its end", () => {
    // A value may span lines. Per-line redaction masked the first line and let the rest through.
    const r = out("env", [], "PASSWORD=first-line\nSECOND-LINE-SECRET\nSAFE=ok");
    expect(r).not.toContain("SECOND-LINE-SECRET");
    expect(r, "and the next record survives").toContain("SAFE=ok");
  });
});

describe("there is ONE reader for a command's subcommand", () => {
  it("nobody scans for the first non-dash argument by hand", async () => {
    // This shape was written SIX times: `args.find(a => !a.startsWith("-"))`. Every copy had the same
    // defect — a value-taking global flag before the verb hands back the flag's VALUE as the subcommand —
    // and each copy failed differently: no sanitizer for a Secret read, no sanitizer for a crictl
    // inspect, no Secret-into-pipe guard. Two of them I wrote myself, one of those in the very commit
    // that consolidated the others.
    //
    // Anything needing a subcommand goes through subcommandSkippingFlagValues with its own arity table.
    // The remaining hand-rolled scan is dcgmi's, whose miss is fail-CLOSED (an unrecognised subcommand
    // is refused), so it cannot leak — it is listed explicitly rather than silently tolerated.
    const { readFileSync, globSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const root = resolve(import.meta.dirname, "../../..");
    const ALLOWED = new Set(["src/tools/infra/command-sets.ts"]);   // validateDcgmi, fail-closed
    const offenders: string[] = [];
    for (const f of globSync("src/tools/**/*.ts", { cwd: root })) {
      if (f.endsWith(".test.ts") || ALLOWED.has(f)) continue;
      const code = readFileSync(resolve(root, f), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/\.find\(\s*\(\s*a(?:rg)?\s*(?:,\s*\w+\s*)?\)\s*=>[^)]*!\s*a(?:rg)?\.startsWith\("-"\)/.test(code)) {
        offenders.push(f);
      }
    }
    expect(offenders, "these scan for a subcommand by hand instead of using the shared reader").toEqual([]);
  });

  it("skips the values of value-taking flags, for kubectl and crictl alike", () => {
    expect(kubectlSubcommand(["-n", "default", "get", "secret"])).toBe("get");
    expect(kubectlSubcommand(["--context", "prod", "get", "pods"])).toBe("get");
    expect(kubectlSubcommand(["--namespace=x", "get", "pods"]), "inline value consumes nothing").toBe("get");
    expect(kubectlSubcommand(["get", "pods"])).toBe("get");
    expect(crictlSubcommand(["-r", "/run/x.sock", "inspect", "abc"])).toBe("inspect");
    expect(crictlSubcommand(["--runtime-endpoint", "unix:///y", "inspectp", "abc"])).toBe("inspectp");
    expect(crictlSubcommand(["inspect", "abc"])).toBe("inspect");
  });

  it("attaches the crictl inspect sanitizer behind a global flag", () => {
    // Not in the review — found by asking whether the kubectl bug generalised. `crictl -r <sock> inspect`
    // returned the container's environment, credentials included, with no sanitizer.
    const CANARY = "SECRET-ENV-CANARY";
    const payload = JSON.stringify({ info: { config: { envs: [{ key: "API_KEY", value: CANARY }] } } });
    for (const args of [["inspect", "abc"], ["-r", "/run/x.sock", "inspect", "abc"],
                        ["--runtime-endpoint", "unix:///y", "inspectp", "abc"]]) {
      const action = analyzeOutput("crictl", args);
      expect(action, args.join(" ")).not.toBeNull();
      expect(applySanitizer(payload, action!), args.join(" ")).not.toContain(CANARY);
    }
  });
});
