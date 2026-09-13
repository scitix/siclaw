import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { assertPrivateFileHasNoLinks } from "./private-file-guard.js";
it("rejects symlink ancestors and hardlinks before writes can reach skills or credentials", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "private-path-")));
  try {
    fs.mkdirSync(path.join(root, "files")); fs.mkdirSync(path.join(root, "skills"));
    const skill = path.join(root, "skills", "SKILL.md"); fs.writeFileSync(skill, "trusted");
    fs.symlinkSync(path.join(root, "skills"), path.join(root, "files", "alias"));
    expect(() => assertPrivateFileHasNoLinks(path.join(root, "files", "alias", "SKILL.md"))).toThrow(/links/);
    expect(() => assertPrivateFileHasNoLinks(path.join(root, "files", "alias", "new-script.py"))).toThrow(/links/);
    fs.linkSync(skill, path.join(root, "files", "hardlink"));
    expect(() => assertPrivateFileHasNoLinks(path.join(root, "files", "hardlink"))).toThrow(/links/);
    expect(() => assertPrivateFileHasNoLinks(path.join(root, "files", "new.txt"))).not.toThrow();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.each([0, 1000, 2000])("checks file and ancestor permissions for trusted Linux UID %i", (trustedUid) => {
  const target = "/app/data/files/report.txt";
  let changedPath = "", uid = 0, mode = 0o755;
  vi.stubGlobal("process", { platform: "linux", getuid: () => trustedUid, env: { SICLAW_WORKSPACE_MODE: "remote" } });
  const stat = vi.spyOn(fs, "lstatSync").mockImplementation((p) => ({
    uid: p === changedPath ? uid : 0, mode: p === changedPath ? mode : 0o755,
    nlink: 1, isSymbolicLink: () => false, isFile: () => p === target,
  }) as fs.Stats);
  try {
    expect(() => assertPrivateFileHasNoLinks(target)).not.toThrow();
    changedPath = "/app/data/files"; uid = trustedUid; mode = 0o2770;
    expect(() => assertPrivateFileHasNoLinks(target)).toThrow(/trusted owner/);
    mode = 0o2750;
    expect(() => assertPrivateFileHasNoLinks(target)).not.toThrow();
    changedPath = target; uid = 1001; mode = 0o600;
    expect(() => assertPrivateFileHasNoLinks(target)).toThrow(/trusted owner/);
    changedPath = "/app/data"; uid = 1001; mode = 0o700;
    expect(() => assertPrivateFileHasNoLinks(target)).toThrow(/trusted owner/);
    changedPath = "/"; uid = 0; mode = 0o1777;
    expect(() => assertPrivateFileHasNoLinks(target)).toThrow(/trusted owner/);
    changedPath = target; uid = trustedUid; mode = 0o602;
    expect(() => assertPrivateFileHasNoLinks(target)).toThrow(/trusted owner/);
  } finally { stat.mockRestore(); vi.unstubAllGlobals(); }
});

it.each([undefined, -1, NaN])("refuses remote Linux access when the process UID is unavailable or invalid: %s", (uid) => {
  vi.stubGlobal("process", { platform: "linux", getuid: uid === undefined ? undefined : () => uid,
    env: { SICLAW_WORKSPACE_MODE: "remote" } });
  try { expect(() => assertPrivateFileHasNoLinks("/app/files/new.txt")).toThrow(/process UID/); }
  finally { vi.unstubAllGlobals(); }
});
