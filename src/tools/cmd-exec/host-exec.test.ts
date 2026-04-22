import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../infra/ssh-client.js", () => ({
  acquireSshTarget: vi.fn(),
  sshExec: vi.fn(),
}));

import { createHostExecTool } from "./host-exec.js";
import { acquireSshTarget, sshExec } from "../infra/ssh-client.js";
import type { CredentialBroker } from "../../agentbox/credential-broker.js";

const fakeBroker = {} as CredentialBroker;
const tool = createHostExecTool({ credentialBroker: fakeBroker } as any);

beforeEach(() => {
  vi.mocked(acquireSshTarget).mockReset();
  vi.mocked(sshExec).mockReset();
});

describe("host_exec", () => {
  it("rejects invalid host name", async () => {
    const result = await tool.execute("id", { host: "bad name with spaces", command: "true" }, undefined, {} as any);
    const text = result.content[0].text as string;
    expect(text).toMatch(/Invalid|invalid/);
    expect((result.details as any).blocked).toBe(true);
  });

  it("rejects when command is blocked by preExecSecurity", async () => {
    const result = await tool.execute("id", { host: "h1", command: "rm -rf /" }, undefined, {} as any);
    expect((result.details as any).blocked).toBe(true);
    expect((result.details as any).reason).toBe("command_blocked");
  });

  it("returns acquire failure with reason=host_acquire_failed", async () => {
    vi.mocked(acquireSshTarget).mockRejectedValueOnce(new Error("Host \"h1\" not bound to this agent"));
    const result = await tool.execute("id", { host: "h1", command: "uptime" }, undefined, {} as any);
    expect((result.details as any).reason).toBe("host_acquire_failed");
    expect(result.content[0].text).toContain("not bound to this agent");
  });

  it("happy path: returns stdout when sshExec succeeds", async () => {
    vi.mocked(acquireSshTarget).mockResolvedValueOnce({
      host: "10.0.0.1", port: 22, username: "root",
      auth: { type: "key", privateKeyPath: "/tmp/h1.key" },
    });
    vi.mocked(sshExec).mockResolvedValueOnce({
      stdout: "load avg 0.5 0.4 0.3\n",
      stderr: "",
      exitCode: 0,
    });
    const result = await tool.execute("id", { host: "h1", command: "uptime" }, undefined, {} as any);
    expect(result.content[0].text).toContain("load avg 0.5");
    expect((result.details as any).exitCode).toBe(0);
    expect((result.details as any).host).toBe("h1");
    expect((result.details as any).error).toBeUndefined();
  });

  it("non-zero exit produces error=true with header", async () => {
    vi.mocked(acquireSshTarget).mockResolvedValueOnce({
      host: "10.0.0.1", port: 22, username: "root",
      auth: { type: "key", privateKeyPath: "/tmp/h1.key" },
    });
    vi.mocked(sshExec).mockResolvedValueOnce({
      stdout: "",
      stderr: "command not found",
      exitCode: 127,
    });
    const result = await tool.execute("id", { host: "h1", command: "cat /nope" }, undefined, {} as any);
    expect(result.content[0].text).toContain("Exit code: 127");
    expect((result.details as any).error).toBe(true);
  });

  it("signal-killed with stdout is NOT treated as error (mirrors node_exec)", async () => {
    vi.mocked(acquireSshTarget).mockResolvedValueOnce({
      host: "10.0.0.1", port: 22, username: "root",
      auth: { type: "key", privateKeyPath: "/tmp/h1.key" },
    });
    vi.mocked(sshExec).mockResolvedValueOnce({
      stdout: "partial output",
      stderr: "",
      exitCode: null,
      signal: "SIGTERM",
    });
    const result = await tool.execute("id", { host: "h1", command: "cat /var/log/messages" }, undefined, {} as any);
    expect((result.details as any).error).toBeUndefined();
    expect((result.details as any).signal).toBe("SIGTERM");
  });
});
