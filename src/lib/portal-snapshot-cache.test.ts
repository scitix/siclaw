import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createPortalSnapshotCache } from "./portal-snapshot-cache.js";
import { materializePortalCredentials } from "./portal-credential-materializer.js";
import { materializePortalSkills } from "./portal-skill-materializer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it("isolates concurrent snapshots and only cleans its own invocation", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "siclaw-snapshot-cache-test-"));
  dirs.push(cwd);
  const first = createPortalSnapshotCache(cwd);
  const second = createPortalSnapshotCache(cwd);
  expect(first.rootDir).not.toBe(second.rootDir);
  for (const [index, cache] of [first, second].entries()) {
    expect(fs.statSync(cache.rootDir).mode & 0o777).toBe(0o700);
    materializePortalSkills([{ name: "shared", specs: `skill ${index}`, scripts: [] }], path.join(cache.rootDir, "skills"));
    await materializePortalCredentials({ clusters: [], hosts: [{
      name: "shared", ip: "127.0.0.1", port: 22, username: "test", authType: "password", password: `fixture-${index}`,
    }] }, path.join(cache.rootDir, "credentials"));
  }
  const read = (cache: typeof first, file: string) => fs.readFileSync(path.join(cache.rootDir, file), "utf8");
  expect(read(first, "credentials/shared.password")).toBe("fixture-0");
  first.cleanup();
  first.cleanup();
  expect(fs.existsSync(first.rootDir)).toBe(false);
  expect(read(second, "credentials/shared.password")).toBe("fixture-1");
  expect(read(second, "skills/shared/SKILL.md")).toBe("skill 1");
  second.cleanup();
  expect(fs.existsSync(second.rootDir)).toBe(false);
});
