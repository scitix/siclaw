import { describe, it, expect } from "vitest";
import { tailTruncationNote } from "./tail-truncation.js";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `log line ${i}`).join("\n");

describe("tailTruncationNote", () => {
  it("flags a window that came back at exactly the limit", () => {
    // "no logs in the window" and "the window was truncated" look identical in the output and call for
    // opposite next steps — the agent reads a truncated window as a complete answer.
    const note = tailTruncationNote("kubectl logs mypod --tail=5", lines(5));
    expect(note).toContain("tail_limit_reached");
    expect(note).toContain("--tail limit");
    expect(note).toContain("5");
  });

  it("accepts both --tail=N and --tail N", () => {
    expect(tailTruncationNote("kubectl logs mypod --tail 5", lines(5))).not.toBe("");
  });

  it("says nothing when the window was not filled — that is already the answer", () => {
    expect(tailTruncationNote("kubectl logs mypod --tail=500", lines(12))).toBe("");
    expect(tailTruncationNote("kubectl logs mypod --tail=500", "")).toBe("");
  });

  it("says nothing in a pipeline, where the line count is the LAST stage's", () => {
    // `kubectl logs --tail=5 | grep x` returning 5 lines says nothing about truncation, and asserting
    // it would be a note that lies — the failure mode this whole change set is about.
    for (const cmd of [
      "kubectl logs mypod --tail=5 | grep ERROR",
      "kubectl logs mypod --tail=5 | head -5",
      "kubectl logs mypod --tail=5 && echo done",
      "kubectl logs mypod --tail=5; echo done",
    ]) {
      expect(tailTruncationNote(cmd, lines(5)), cmd).toBe("");
    }
  });

  it("says nothing without an explicit positive --tail", () => {
    expect(tailTruncationNote("kubectl logs mypod", lines(5))).toBe("");
    expect(tailTruncationNote("kubectl logs mypod --tail=-1", lines(5))).toBe("");
    expect(tailTruncationNote("kubectl logs mypod --tail=0", lines(5))).toBe("");
    expect(tailTruncationNote("kubectl logs mypod --tail=abc", lines(5))).toBe("");
  });

  it("says nothing for a command that is not kubectl logs", () => {
    expect(tailTruncationNote("journalctl -u kubelet -n 5", lines(5))).toBe("");
    expect(tailTruncationNote("kubectl get pods --tail=5", lines(5))).toBe("");
  });

  it("does not assert truncation, because at exactly N it cannot be known", () => {
    // N lines existing and N+1 existing are indistinguishable from here. The note has to say "may".
    const note = tailTruncationNote("kubectl logs mypod --tail=3", lines(3));
    expect(note).toContain("may exist");
    expect(note).toContain("indistinguishable");
  });

  it("ignores a trailing newline when counting", () => {
    expect(tailTruncationNote("kubectl logs mypod --tail=3", lines(3) + "\n")).not.toBe("");
  });
});

describe("the note is only wired where the command it applies to can run", () => {
  it("is called only by tools whose whitelist admits kubectl", async () => {
    // The note fires for `kubectl logs --tail=N` and nothing else. `kubectl` is not in any context's
    // whitelist — restricted_bash adds it explicitly via `extraAllowed`. So a tool that does not pass
    // that set refuses the command before it runs, and the note there is unreachable.
    //
    // It was wired into node_exec, pod_exec and host_exec, where all three were dead. Nothing failed
    // when they were removed, which is why this test exists: the next person to add the call needs to
    // be told why it would do nothing.
    const { readFileSync, globSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const root = resolve(import.meta.dirname, "../../..");

    const callers: string[] = [];
    for (const f of globSync("src/tools/**/*.ts", { cwd: root })) {
      if (f.endsWith(".test.ts") || f.endsWith("tail-truncation.ts")) continue;
      const src = readFileSync(resolve(root, f), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/\btailTruncationNote\s*\(/.test(code)) callers.push(f);
    }
    expect(callers.length, "expected at least restricted_bash to use it").toBeGreaterThan(0);

    for (const f of callers) {
      const code = readFileSync(resolve(root, f), "utf8");
      expect(code, `${f} appends a --tail note but never whitelists kubectl, so the only command the `
        + `note applies to is refused before it runs — the note is dead there`)
        .toMatch(/extraAllowed[\s\S]{0,120}kubectl/);
    }
  });
});
