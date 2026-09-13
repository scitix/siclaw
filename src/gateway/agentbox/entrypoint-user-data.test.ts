import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

const file = resolve(import.meta.dirname, "../../../docker/agentbox-entrypoint.sh");
const entrypoint = readFileSync(file, "utf8");
const block = entrypoint.slice(entrypoint.indexOf("user_data_dir=/app/.siclaw/user-data"), entrypoint.indexOf("chown -R agentbox:agentbox /app/.siclaw/config"));
describe("pod-local workspace initialization", () => {
  it("is valid shell syntax", () => { expect(() => execFileSync("bash", ["-n", file])).not.toThrow(); });
  it("does not traverse old shared data or grant world write access", () => {
    expect(block).not.toMatch(/find|chown\s+-R|0777|\|\| true/);
    expect(block).toContain('chmod 0711 "$user_data_dir"');
  });
  it("shares files for reading in remote mode, preserving the trusted writer", () => {
    expect(block).toContain('chown agentbox:agentbox "$user_data_dir"');
    expect(block).toContain('chown agentbox:sandbox "$user_data_dir/files"');
    expect(block).toContain('chmod 2770 "$user_data_dir/files"');
    expect(block).toContain('chmod 2750 "$user_data_dir/files"');
  });
});
