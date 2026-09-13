import { describe, expect, it, vi } from "vitest";
import { ScriptResultTransfer, SCRIPT_FILE_RESULT_BYTES, SCRIPT_RUN_FILE_BYTES } from "./result-transfer.js";
import { createHash } from "node:crypto";

describe("live-run result transfer", () => {
  it("keeps every chunk small and reauthorizes reads without changing UTF-8 bytes", async () => {
    const transfer = new ScriptResultTransfer(); const authorize = vi.fn(async () => {});
    const value = { text: "节点🐍".repeat(40_000) };
    const info = transfer.open(value, authorize); const chunks: Buffer[] = []; let offset = 0;
    while (offset < info.bytes) {
      const reply = await transfer.read({ transfer_id: info.transfer_id, offset }, new AbortController().signal);
      expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(128 * 1024);
      chunks.push(Buffer.from(reply.data, "base64")); offset = reply.next_offset;
      expect(reply.done).toBe(offset === info.bytes);
    }
    expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(value);
    expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(info.sha256);
    expect(authorize).toHaveBeenCalledTimes(chunks.length);
    await expect(transfer.read({ transfer_id: info.transfer_id, offset: 0 }, new AbortController().signal)).rejects.toThrow();
  });

  it("denies other runs, arbitrary paths and skipped/replayed offsets", async () => {
    const t = new ScriptResultTransfer(); const a = vi.fn(async () => {});
    const info = t.open({ text: "x".repeat(100_000) }, a); const signal = new AbortController().signal;
    await expect(new ScriptResultTransfer().read({ transfer_id: info.transfer_id, offset: 0 }, signal)).rejects.toThrow();
    for (const args of [{ transfer_id: "other", offset: 0 }, { transfer_id: info.transfer_id, offset: 1 }, { transfer_id: info.transfer_id, offset: 0, path: "/etc/shadow" }]) {
      await expect(t.read(args, signal)).rejects.toThrow();
    }
    expect(a).not.toHaveBeenCalled();
    await t.read({ transfer_id: info.transfer_id, offset: 0 }, signal);
    await expect(t.read({ transfer_id: info.transfer_id, offset: 0 }, signal)).rejects.toThrow();
    t.discard({ transfer_id: info.transfer_id });
    await expect(t.read({ transfer_id: info.transfer_id, offset: 49152 }, signal)).rejects.toThrow();
  });

  it("separates ten concurrent files and rejects concurrent reads of the same offset", async () => {
    const t = new ScriptResultTransfer();
    let finish!: () => void;
    const blocked = t.open({ file: "blocked" }, () => new Promise<void>(r => { finish = r; }));
    const files = Array.from({ length: 9 }, (_, i) => t.open({ file: i }, async () => {}));
    expect(() => t.open({}, async () => {})).toThrow();
    const signal = new AbortController().signal;
    const pending = t.read({ transfer_id: blocked.transfer_id, offset: 0 }, signal);
    await expect(t.read({ transfer_id: blocked.transfer_id, offset: 0 }, signal)).rejects.toThrow();
    const results = await Promise.all(files.map(f => t.read({ transfer_id: f.transfer_id, offset: 0 }, signal)));
    expect(results.map(r => JSON.parse(Buffer.from(r.data, "base64").toString()).file)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    finish(); expect((await pending).done).toBe(true);
  });

  it("refuses to release a chunk after revocation or a close during authorization", async () => {
    const t = new ScriptResultTransfer();
    const denied = t.open({}, async () => { throw new Error("revoked"); });
    await expect(t.read({ transfer_id: denied.transfer_id, offset: 0 }, new AbortController().signal)).rejects.toThrow("revoked");
    t.discard({ transfer_id: denied.transfer_id });
    let finish!: () => void;
    const info = t.open({}, () => new Promise<void>(resolve => { finish = resolve; }));
    const read = t.read({ transfer_id: info.transfer_id, offset: 0 }, new AbortController().signal);
    t.close(); finish(); await expect(read).rejects.toThrow("Inactive");
    expect(() => t.open({}, async () => {})).toThrow();
  });

  it("bounds both each file and cumulative admitted data without refund on discard", () => {
    const t = new ScriptResultTransfer(); const authorize = async () => {};
    expect(() => t.open("x".repeat(SCRIPT_FILE_RESULT_BYTES), authorize)).toThrow();
    for (let i = 0; i < SCRIPT_RUN_FILE_BYTES / SCRIPT_FILE_RESULT_BYTES; i++) {
      const info = t.open("x".repeat(SCRIPT_FILE_RESULT_BYTES - 2), authorize);
      t.discard({ transfer_id: info.transfer_id });
    }
    expect(() => t.open("", authorize)).toThrow();
  });
});
