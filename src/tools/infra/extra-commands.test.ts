import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseExtraCommandsConfig,
  loadExtraCommands,
} from "./extra-commands.js";
import {
  setExtraCommands,
  getContextAllowedSet,
  validateCommandRestrictions,
} from "./command-sets.js";
import { validateCommand } from "./command-validator.js";

afterEach(() => {
  setExtraCommands({});
});

// ── parseExtraCommandsConfig (schema validation) ────────────────────

describe("parseExtraCommandsConfig", () => {
  const wrap = (commands: unknown) =>
    JSON.stringify({ version: 1, commands });

  it("accepts a maximal valid config", () => {
    const parsed = parseExtraCommandsConfig(wrap({
      iperf3: {
        category: "network",
        description: "site-specific throughput tool",
        allowedFlags: ["-c", "-p", "--json"],
      },
      mytool: {
        category: "hardware",
        blockedFlags: ["-w"],
        positionals: 2,
        requiredFlags: ["-b"],
      },
      vendorctl: {
        category: "services",
        allowedSubcommands: { position: 0, allowed: ["status", "show"] },
        positionals: "block",
      },
    }), "test.json");

    expect(Object.keys(parsed).sort()).toEqual(["iperf3", "mytool", "vendorctl"]);
    expect(parsed.iperf3).toEqual({ category: "network", allowedFlags: ["-c", "-p", "--json"] });
    expect(parsed.mytool.positionals).toBe(2);
    expect(parsed.vendorctl.allowedSubcommands).toEqual({ position: 0, allowed: ["status", "show"] });
  });

  it("accepts a bare entry (category only)", () => {
    const parsed = parseExtraCommandsConfig(wrap({ iperf3: { category: "network" } }), "t");
    expect(parsed.iperf3).toEqual({ category: "network" });
  });

  it('accepts positionals "allow", "block", and 0', () => {
    const parsed = parseExtraCommandsConfig(wrap({
      a1: { category: "network", positionals: "allow" },
      b2: { category: "network", positionals: "block" },
      c3: { category: "network", positionals: 0 },
    }), "t");
    expect(parsed.c3.positionals).toBe(0);
  });

  it("rejects invalid JSON", () => {
    expect(() => parseExtraCommandsConfig("{nope", "bad.json")).toThrow(/bad\.json/);
  });

  it("rejects a non-object root", () => {
    expect(() => parseExtraCommandsConfig("[]", "t")).toThrow(/object/i);
  });

  it("rejects a missing or wrong version", () => {
    expect(() => parseExtraCommandsConfig(JSON.stringify({ commands: {} }), "t")).toThrow(/version/i);
    expect(() => parseExtraCommandsConfig(JSON.stringify({ version: 2, commands: {} }), "t")).toThrow(/version/i);
  });

  it("rejects a missing commands object", () => {
    expect(() => parseExtraCommandsConfig(JSON.stringify({ version: 1 }), "t")).toThrow(/commands/i);
  });

  it("rejects invalid command names", () => {
    expect(() => parseExtraCommandsConfig(wrap({ "Bad": { category: "network" } }), "t")).toThrow(/name/i);
    expect(() => parseExtraCommandsConfig(wrap({ "a/b": { category: "network" } }), "t")).toThrow(/name/i);
    expect(() => parseExtraCommandsConfig(wrap({ "": { category: "network" } }), "t")).toThrow(/name/i);
  });

  it("rejects an unknown category", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "shiny" } }), "t")).toThrow(/category/i);
  });

  it("rejects a missing category", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: {} }), "t")).toThrow(/category/i);
  });

  it("rejects unknown keys, including validate", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", nope: 1 } }), "t")).toThrow(/nope/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", validate: "x" } }), "t")).toThrow(/validate/);
  });

  it("rejects flags that do not start with a dash", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", allowedFlags: ["c"] } }), "t")).toThrow(/-/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", blockedFlags: [""] } }), "t")).toThrow(/-/);
  });

  it("rejects non-array flag fields", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", allowedFlags: "-c" } }), "t")).toThrow(/allowedFlags/);
  });

  it("rejects invalid positionals values", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", positionals: "maybe" } }), "t")).toThrow(/positionals/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", positionals: -1 } }), "t")).toThrow(/positionals/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", positionals: 1.5 } }), "t")).toThrow(/positionals/);
  });

  it("rejects malformed allowedSubcommands", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", allowedSubcommands: { position: -1, allowed: ["a"] } } }), "t")).toThrow(/allowedSubcommands/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", allowedSubcommands: { position: 0, allowed: [] } } }), "t")).toThrow(/allowedSubcommands/);
    expect(() => parseExtraCommandsConfig(wrap({ x: { category: "network", allowedSubcommands: { allowed: ["a"] } } }), "t")).toThrow(/allowedSubcommands/);
  });

  it("rejects a non-object command entry", () => {
    expect(() => parseExtraCommandsConfig(wrap({ x: "network" }), "t")).toThrow(/object/i);
  });

  it("rejects intentionally excluded binaries (shells, interpreters, wrappers, exfil tools)", () => {
    for (const name of ["bash", "sh", "python3", "sed", "awk", "nc", "wget", "xargs", "timeout", "sudo", "nsenter", "ssh", "kubectl"]) {
      expect(() => parseExtraCommandsConfig(wrap({ [name]: { category: "general" } }), "t"))
        .toThrow(/cannot be whitelisted/i);
    }
  });

  it("rejects multi-call wrappers (busybox/toybox) that provide a shell", () => {
    for (const name of ["busybox", "toybox"]) {
      expect(() => parseExtraCommandsConfig(wrap({ [name]: { category: "general" } }), "t"))
        .toThrow(/cannot be whitelisted/i);
    }
  });

  it("rejects version-suffixed interpreter variants", () => {
    for (const name of ["python3.11", "python3.10", "python2.7", "node22", "node18", "perl5.36", "ruby3.2", "php8", "lua5.4", "bash5"]) {
      expect(() => parseExtraCommandsConfig(wrap({ [name]: { category: "general" } }), "t"))
        .toThrow(/cannot be whitelisted/i);
    }
  });

  it("does not over-block legitimate names that merely resemble an interpreter stem", () => {
    // iperf3 / sha256sum / show_gids / ib_write_bw end in or contain digits but are not
    // <interpreter><version> forms — they must remain configurable.
    for (const name of ["iperf3", "sha256sum", "show_gids", "ib_write_bw", "h5dump", "qperf"]) {
      expect(() => parseExtraCommandsConfig(wrap({ [name]: { category: "network" } }), "t")).not.toThrow();
    }
  });
});

// ── setExtraCommands (merge semantics) ──────────────────────────────

describe("setExtraCommands", () => {
  it("makes an extra command visible in matching contexts and invalidates the cache", () => {
    // Prime the cache first — registration must invalidate it.
    expect(getContextAllowedSet("node").has("iperf3")).toBe(false);
    expect(getContextAllowedSet("local").has("iperf3")).toBe(false);

    const result = setExtraCommands({ iperf3: { category: "network" } });
    expect(result.applied).toEqual(["iperf3"]);
    expect(result.skipped).toEqual([]);

    expect(getContextAllowedSet("node").has("iperf3")).toBe(true);
    expect(getContextAllowedSet("local").has("iperf3")).toBe(true);
  });

  it("respects context policies for the extra command's category", () => {
    setExtraCommands({ vendorcat: { category: "file" } });
    // "file" category is excluded from the local context policy
    expect(getContextAllowedSet("local").has("vendorcat")).toBe(false);
    expect(getContextAllowedSet("node").has("vendorcat")).toBe(true);
  });

  it("skips collisions with built-in commands and keeps built-in restrictions", () => {
    const result = setExtraCommands({
      curl: { category: "network" }, // would lift curl's method restrictions
      iperf3: { category: "network" },
    });
    expect(result.skipped).toEqual(["curl"]);
    expect(result.applied).toEqual(["iperf3"]);

    // Built-in curl validator still enforced
    const err = validateCommandRestrictions("curl -X POST http://example.com");
    expect(err).toContain("not allowed");
  });

  it("enforces declarative constraints on extra commands", () => {
    setExtraCommands({ iperf3: { category: "network", allowedFlags: ["-c", "-p"] } });
    expect(validateCommandRestrictions("iperf3 -c 10.0.0.1 -p 5201")).toBeNull();
    expect(validateCommandRestrictions("iperf3 -F /tmp/x")).toContain("not allowed");
  });

  it("replaces previous extras on each call", () => {
    setExtraCommands({ iperf3: { category: "network" } });
    setExtraCommands({ qperf: { category: "network" } });
    expect(getContextAllowedSet("node").has("iperf3")).toBe(false);
    expect(getContextAllowedSet("node").has("qperf")).toBe(true);
  });
});

// ── End-to-end through validateCommand ──────────────────────────────

describe("validateCommand with extra commands", () => {
  it("blocks an unregistered binary, allows it after registration", () => {
    expect(validateCommand("iperf3 -c 10.0.0.1", { context: "node" })).toContain("iperf3");
    setExtraCommands({ iperf3: { category: "network", allowedFlags: ["-c"] } });
    expect(validateCommand("iperf3 -c 10.0.0.1", { context: "node" })).toBeNull();
    expect(validateCommand("iperf3 -F /tmp/x", { context: "node" })).toContain("not allowed");
  });

  it("keeps category-based context exclusion for extras", () => {
    setExtraCommands({ vendorcat: { category: "file" } });
    expect(validateCommand("vendorcat /etc/hosts", { context: "local" })).toContain("vendorcat");
    expect(validateCommand("vendorcat /etc/hosts", { context: "node" })).toBeNull();
  });
});

// ── loadExtraCommands (file resolution) ─────────────────────────────

describe("loadExtraCommands", () => {
  let dir: string;
  const make = (content: string): string => {
    dir = mkdtempSync(join(tmpdir(), "siclaw-extra-"));
    const p = join(dir, "extra-commands.json");
    writeFileSync(p, content);
    return p;
  };

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("loads a valid file via explicit env path", () => {
    const p = make(JSON.stringify({ version: 1, commands: { iperf3: { category: "network" } } }));
    const loaded = loadExtraCommands({ envPath: p });
    expect(loaded).toEqual({ iperf3: { category: "network" } });
  });

  it("throws when the env path is set but the file is missing", () => {
    expect(() => loadExtraCommands({ envPath: "/nonexistent/extra.json" })).toThrow(/nonexistent/);
  });

  it("treats an empty env path as unset", () => {
    expect(loadExtraCommands({ envPath: "", defaultPath: "/nonexistent/extra.json" })).toBeNull();
  });

  it("returns null when only the default path is configured and absent", () => {
    expect(loadExtraCommands({ defaultPath: "/nonexistent/extra.json" })).toBeNull();
  });

  it("loads the default path when it exists", () => {
    const p = make(JSON.stringify({ version: 1, commands: { qperf: { category: "network" } } }));
    const loaded = loadExtraCommands({ defaultPath: p });
    expect(loaded).toEqual({ qperf: { category: "network" } });
  });

  it("throws on an invalid file even at the default path", () => {
    const p = make(JSON.stringify({ version: 1, commands: { curl2: { category: "bogus" } } }));
    expect(() => loadExtraCommands({ defaultPath: p })).toThrow(/category/);
  });
});
