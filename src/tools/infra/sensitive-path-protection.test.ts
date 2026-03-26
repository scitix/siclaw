/**
 * E2E tests for container sensitive path protection.
 *
 * Verifies both pre-execution blocking (CONTAINER_SENSITIVE_PATHS via Pass 6)
 * and post-execution sanitization (output-sanitizer rules) across all exec
 * entry points: pod_exec, node_exec, kubectl exec, and validateCommand.
 */
import { describe, it, expect } from "vitest";
import { validateCommand } from "./command-validator.js";
import { CONTAINER_SENSITIVE_PATHS } from "./command-sets.js";
import { validateExecCommand } from "./command-sets.js";
import { createPodExecTool } from "../k8s-exec/pod-exec.js";
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
    "ls /proc/1/fd/",
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
    "cat /var/lib/kubelet/config.yaml",
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
  const contexts = ["pod", "node", "nsenter"] as const;
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
        expect(err).toContain("sensitive paths");
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

// ── Pre-execution: kubectl exec (validateExecCommand) ───────────────

describe("validateExecCommand blocks sensitive paths", () => {
  it("blocks cat /etc/shadow", () => {
    const err = validateExecCommand(["exec", "my-pod", "--", "cat", "/etc/shadow"]);
    expect(err).not.toBeNull();
    expect(err).toContain("sensitive paths");
  });

  it("blocks cat /var/run/secrets/...", () => {
    const err = validateExecCommand(["exec", "my-pod", "--", "cat", "/var/run/secrets/kubernetes.io/serviceaccount/token"]);
    expect(err).not.toBeNull();
  });

  it("blocks cat /proc/1/environ", () => {
    const err = validateExecCommand(["exec", "my-pod", "--", "cat", "/proc/1/environ"]);
    expect(err).not.toBeNull();
  });

  it("allows cat /etc/os-release", () => {
    const err = validateExecCommand(["exec", "my-pod", "--", "cat", "/etc/os-release"]);
    expect(err).toBeNull();
  });

  it("allows ip addr show", () => {
    const err = validateExecCommand(["exec", "my-pod", "--", "ip", "addr", "show"]);
    expect(err).toBeNull();
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
