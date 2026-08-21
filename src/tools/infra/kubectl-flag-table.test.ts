import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { kubectlSubcommand } from "./kubectl-sanitize.js";

/**
 * `FLAGS_WITH_VALUE` decides where a kubectl SUBCOMMAND is, so an error in it is a security error in
 * either direction — and both have now happened:
 *
 *   a MISSING value flag   hands the flag's value back as the verb.
 *                          `kubectl --as get delete pod victim` read as subcommand `get`, and `delete`
 *                          was never examined.
 *   a WRONG boolean entry  swallows the verb. `--warnings-as-errors` takes no argument, so listing it
 *                          made `kubectl --warnings-as-errors delete get pod victim` read as `get` while
 *                          real kubectl runs the delete. The same entry also refused plain
 *                          `--warnings-as-errors get pods` for naming subcommand `pods`.
 *
 * The table was maintained by hand and by memory across three rounds of fixes, which is why both errors
 * are in it. kubectl states the answer itself — `kubectl options` prints every global flag with its
 * default, and a default of `false`/`true` means boolean — so this test compares the table against a
 * snapshot of that output instead of against a list retyped here.
 *
 * The snapshot goes stale when kubectl is upgraded. That is the intended failure: a new global flag
 * SHOULD break this test and be classified deliberately. Refresh with
 *
 *     kubectl options > src/tools/infra/testdata/kubectl-options.txt
 *
 * The reader is exercised through `kubectlSubcommand` rather than by importing the table, because the
 * table is module-private and the observable property is where the verb is found.
 */

const optionsText = readFileSync(
  resolve(import.meta.dirname, "testdata/kubectl-options.txt"), "utf8",
);

/** Parse `kubectl options` into its two classes. Lines read `  --flag=default: description`. */
function parseOptions() {
  const booleans: string[] = [];
  const values: string[] = [];
  for (const m of optionsText.matchAll(/^\s+(?:-(\w), )?(--[a-z0-9-]+)=([^\s:]*)/gm)) {
    const [, short, flag, rawDefault] = m;
    const isBoolean = ["false", "true"].includes(rawDefault.replace(/:$/, ""));
    (isBoolean ? booleans : values).push(flag);
    if (short && !isBoolean) values.push(`-${short}`);
  }
  return { booleans, values };
}

const { booleans, values } = parseOptions();

describe("the kubectl flag table matches what kubectl says", () => {
  it("parsed a plausible snapshot", () => {
    // Guard against a silently empty parse making every assertion below vacuous.
    expect(values.length).toBeGreaterThan(20);
    expect(booleans.length).toBeGreaterThan(2);
    expect(values).toContain("--namespace");
    expect(booleans).toContain("--warnings-as-errors");
  });

  it("every value flag hides its value from the subcommand reader", () => {
    // `kubectl <flag> get delete pod x`: the flag consumes `get`, so the verb the read-only check must
    // see is `delete`. A flag missing from the table stops at `get` instead — which is exactly how
    // `--as get delete pod victim` got through.
    const leaked = values.filter((f) => kubectlSubcommand([f, "get", "delete", "pod", "x"]) !== "delete");
    expect(leaked, "these value flags are missing from FLAGS_WITH_VALUE").toEqual([]);
  });

  it("no boolean flag consumes the word after it", () => {
    // If a boolean is wrongly in the table, the real verb is swallowed. `delete` must survive as the
    // subcommand — that is what makes the read-only check see it.
    const swallowing = booleans.filter((f) => kubectlSubcommand([f, "delete", "pod", "x"]) !== "delete");
    expect(swallowing, "these boolean flags are wrongly listed in FLAGS_WITH_VALUE").toEqual([]);
  });

  it("and a boolean flag does not break an ordinary read", () => {
    // The usability half of the same defect: `--warnings-as-errors get pods` was refused for naming
    // subcommand `pods`.
    for (const f of booleans) {
      expect(kubectlSubcommand([f, "get", "pods"]), f).toBe("get");
    }
  });

  it("handles the --flag=value form for every value flag", () => {
    // `--namespace=x` carries its value inline, so the next word IS the subcommand.
    for (const f of values) {
      if (!f.startsWith("--")) continue;
      expect(kubectlSubcommand([`${f}=somevalue`, "delete", "pod", "x"]), f).toBe("delete");
    }
  });
});
