import { beforeEach, expect, it } from "vitest";
import { getOrCreateLedger, resetLedgers } from "../core/task-ledger.js";
import { restoreTaskLedgerFromHistory } from "./task-ledger-recovery.js";
beforeEach(resetLedgers);
const upsert = (id: string, session = "s") => ({ metadata: { kind: "task_event", taskListId: session, action: "upsert", task: { id, subject: "Check nodes", description: "All nodes", status: "in_progress", blockedBy: [] } } });
it("restores plan IDs and status on another runtime without touching another session", () => {
  getOrCreateLedger("other").create({ subject: "Other", description: "Other" });
  expect(restoreTaskLedgerFromHistory("s", [upsert("5"), upsert("99", "other")])).toBe(true);
  expect(getOrCreateLedger("s").get("5")?.status).toBe("in_progress");
  expect(getOrCreateLedger("s").get("99")).toBeUndefined();
  expect(getOrCreateLedger("other").size).toBe(1);
  expect(getOrCreateLedger("s").create({ subject: "Next", description: "Next" }).id).toBe("6");
});
it("replays resets and deletes and keeps the ID high-water mark", () => {
  restoreTaskLedgerFromHistory("s", [upsert("10"), { metadata: { kind: "task_event", taskListId: "s", action: "reset" } }, upsert("11"), { metadata: { kind: "task_event", taskListId: "s", action: "delete", taskId: "11" } }]);
  expect(getOrCreateLedger("s").size).toBe(0);
  expect(getOrCreateLedger("s").create({ subject: "New", description: "New" }).id).toBe("12");
});
it("does not erase a local plan when history has no valid plan events", () => {
  getOrCreateLedger("s").create({ subject: "Keep", description: "Keep" });
  expect(restoreTaskLedgerFromHistory("s", [{ metadata: "bad json" }])).toBe(false);
  expect(getOrCreateLedger("s").size).toBe(1);
});

it("recovers the last nonblank title from legacy snapshots without mutating history", () => {
  const created = upsert("7");
  const completed = { metadata: { ...created.metadata, task: { ...created.metadata.task, subject: " \t", status: "completed" } } };
  const messages = [created, { metadata: JSON.stringify(completed.metadata) }];
  const before = JSON.stringify(messages);
  restoreTaskLedgerFromHistory("s", messages);
  expect(getOrCreateLedger("s").get("7")).toMatchObject({ subject: "Check nodes", status: "completed" });
  expect(JSON.stringify(messages)).toBe(before);
});

it("does not recover a title from a deleted or reset plan", () => {
  for (const boundary of [{ action: "delete", taskId: "7" }, { action: "reset" }]) {
    const blank = upsert("7");
    blank.metadata.task.subject = "";
    restoreTaskLedgerFromHistory("s", [upsert("7"), { metadata: { kind: "task_event", taskListId: "s", ...boundary } }, blank]);
    expect(getOrCreateLedger("s").get("7")?.subject).toBe("");
  }
});
