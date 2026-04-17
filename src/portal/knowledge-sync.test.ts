import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock dependencies before importing the module under test.
vi.mock("../gateway/db.js", () => ({
  getDb: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  },
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("../shared/knowledge-package.js", () => ({
  validateKnowledgePackage: vi.fn(),
}));

import { getDb } from "../gateway/db.js";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { validateKnowledgePackage } from "../shared/knowledge-package.js";
import { syncBuiltinKnowledge } from "./knowledge-sync.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncBuiltinKnowledge", () => {
  it("skips when DB already has repos", async () => {
    const query = vi.fn().mockResolvedValueOnce([[{ c: 3 }], []]);
    (getDb as any).mockReturnValue({ query });

    await syncBuiltinKnowledge();

    expect(query).toHaveBeenCalledTimes(1);
    expect(fs.existsSync).not.toHaveBeenCalled();
  });

  it("skips when baseline directory does not exist", async () => {
    const query = vi.fn().mockResolvedValueOnce([[{ c: 0 }], []]);
    (getDb as any).mockReturnValue({ query });
    (fs.existsSync as any).mockReturnValue(false);

    await syncBuiltinKnowledge();

    expect(fs.existsSync).toHaveBeenCalled();
    expect(fs.readdirSync).not.toHaveBeenCalled();
  });

  it("skips when baseline directory has no markdown files", async () => {
    const query = vi.fn().mockResolvedValueOnce([[{ c: 0 }], []]);
    (getDb as any).mockReturnValue({ query });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readdirSync as any).mockReturnValue(["README", "notes.txt"]);

    await syncBuiltinKnowledge();

    expect(execFileSync).not.toHaveBeenCalled();
  });

  it("returns early when tar.gz creation fails", async () => {
    const query = vi.fn().mockResolvedValueOnce([[{ c: 0 }], []]);
    (getDb as any).mockReturnValue({ query });
    (fs.existsSync as any).mockReturnValue(true);
    (fs.readdirSync as any).mockReturnValue(["one.md", "two.md"]);
    (execFileSync as any).mockImplementationOnce(() => {
      throw new Error("tar not found");
    });

    await syncBuiltinKnowledge();

    // The validateKnowledgePackage should never be called because tar failed
    expect(validateKnowledgePackage).not.toHaveBeenCalled();
    // Only the initial count query ran
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("imports baseline on empty DB with valid markdown files", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([[{ c: 0 }], []])  // repos count
      .mockResolvedValueOnce([undefined, []])    // insert repo
      .mockResolvedValueOnce([undefined, []]);   // insert version
    (getDb as any).mockReturnValue({ query });

    (fs.existsSync as any).mockReturnValue(true);
    (fs.readdirSync as any).mockReturnValue(["a.md", "b.md"]);
    (execFileSync as any).mockReturnValueOnce(Buffer.alloc(0));
    const fakeTar = Buffer.from("fake-tar-bytes");
    (fs.readFileSync as any).mockReturnValue(fakeTar);
    (validateKnowledgePackage as any).mockReturnValue({ sha256: "abc123", fileCount: 2 });

    await syncBuiltinKnowledge();

    // Verify tar was created and cleaned up
    expect(execFileSync).toHaveBeenCalledWith(
      "tar",
      expect.arrayContaining(["czf"]),
      expect.objectContaining({ stdio: "pipe" }),
    );
    expect(fs.unlinkSync).toHaveBeenCalled();

    // Verify DB inserts
    expect(query).toHaveBeenCalledTimes(3);
    // insert repos call - check SQL text
    expect(query.mock.calls[1][0]).toContain("INSERT INTO knowledge_repos");
    // insert versions call - check param values
    const versionParams = query.mock.calls[2][1];
    expect(versionParams).toContain(fakeTar);
    expect(versionParams).toContain("abc123");
    expect(versionParams).toContain(2);  // fileCount
    expect(versionParams).toContain("system");
  });
});
