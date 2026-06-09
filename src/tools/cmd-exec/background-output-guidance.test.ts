import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for the model-visible text of every background-capable tool.
//
// A backgrounded job's output must be consumed via the status-aware task_output(task_id) tool —
// NOT by reading the raw output_file path, which returns a hard ENOENT while a silent job has
// produced nothing yet (the bug this feature fixes) and bypasses status/exit-code/bounded-read.
// Two examples (node_exec / host_exec tcpdump flows) regressed to "read the/its output_file";
// this test fails if any background tool's source reintroduces that guidance.

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const TOOL_FILES = [
  "tools/cmd-exec/node-exec.ts",
  "tools/cmd-exec/host-exec.ts",
  "tools/cmd-exec/pod-exec.ts",
  "tools/cmd-exec/restricted-bash.ts",
  "tools/script-exec/node-script.ts",
  "tools/script-exec/host-script.ts",
  "tools/script-exec/pod-script.ts",
  "tools/script-exec/local-script.ts",
];

// "read the/its/your [raw] output_file" = telling the model to consume the raw path. The legit
// references — "a task_id and output_file", "not the raw output_file" — never put "read" before
// "output_file", so this pattern catches only the bad guidance.
const FORBIDDEN = /read\s+(the|its|your)(\s+raw)?\s+output_file/i;

describe("background tools steer the model to task_output, not the raw output_file", () => {
  for (const rel of TOOL_FILES) {
    it(`${rel}: no "read the output_file" guidance`, () => {
      const src = fs.readFileSync(path.join(srcRoot, rel), "utf8");
      expect(src).not.toMatch(FORBIDDEN);
    });

    it(`${rel}: references task_output`, () => {
      const src = fs.readFileSync(path.join(srcRoot, rel), "utf8");
      expect(src).toMatch(/task_output/);
    });
  }
});
