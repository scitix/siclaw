/**
 * Deterministic subprocess fixture for a host's live storage integration test.
 * Run npm run build first. The parent supplies an isolated directory and identity
 * in SICLAW_RESTART_PROBE and implements WORKSPACE_RPC over stdin/stdout. No
 * credentials enter this worker. This exercises the actual session manager and
 * Pi SDK, but uses fixture messages: it does not call a model or test HTTP auth.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const config = JSON.parse(process.env.SICLAW_RESTART_PROBE);
const { directory, sessionId, spaceId, userId, marker, stage } = config;
assert(["seed", "resume", "verify", "pending", "verify-pending"].includes(stage));
assert.equal(fs.readdirSync(directory).length, 0, "each worker needs fresh local storage");
process.chdir(fs.realpathSync(directory));
process.env.SICLAW_WORKSPACE_MODE = "remote";
process.env.SICLAW_PRIVATE_SESSION_ID = sessionId;
process.env.SICLAW_PRIVATE_SPACE_ID = spaceId;
process.env.SICLAW_PRIVATE_USER_ID = userId;
process.env.SICLAW_USER_DATA_DIR = ".siclaw/user-data";
process.env.SICLAW_MEMORY_ENABLED = "false";
fs.mkdirSync(".siclaw/user-data", { recursive: true });
fs.chmodSync(".siclaw", 0o555);

const replies = readline.createInterface({ input: process.stdin });
const pending = new Map();
let sequence = 0;
replies.on("line", line => {
  const response = JSON.parse(line);
  const waiter = pending.get(response.id);
  pending.delete(response.id);
  if (response.error) waiter.reject(new Error(response.error));
  else waiter.resolve(response.result);
});
const exchange = request => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  process.stdout.write(`WORKSPACE_RPC ${JSON.stringify({ id, request })}\n`);
});

const { AgentBoxSessionManager } = await import("../../dist/agentbox/session.js");
const { privateWorkspaceRoots } = await import("../../dist/shared/private-workspace-paths.js");
const { capturePiSession } = await import("../../dist/agentbox/pi-session-snapshot.js");
const { getOrCreateLedger } = await import("../../dist/core/task-ledger.js");
const { initMemoryDb } = await import("../../dist/memory/schema.js");
const manager = new AgentBoxSessionManager();
manager.gatewayClient = { exchange };
const roots = privateWorkspaceRoots(process.cwd(), ".siclaw/user-data");
const write = (name, value) => {
  const file = path.join(roots.files, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
const read = name => JSON.parse(fs.readFileSync(path.join(roots.files, name), "utf8"));
const assistant = text => ({
  role: "assistant", content: [{ type: "text", text }], api: "openai-completions",
  provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 2,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

try {
  assert.equal(await manager.ensureSessionContext(sessionId), stage !== "seed");
  // Internal persistence entry points, deliberately without creating an LLM brain.
  const pi = manager.openPiManager(sessionId, manager.getSessionDir(sessionId));
  if (stage === "seed") {
    pi.appendModelChange("fixture", "fixture");
    pi.appendThinkingLevelChange("high");
    pi.appendMessage({ role: "user", content: `Session marker: ${marker}`, timestamp: 1 });
    const active = pi.appendMessage(assistant("Fixture first reply"));
    pi.appendMessage({ role: "user", content: "Inactive branch; must not enter context", timestamp: 3 });
    pi.branch(active);
    write("expected.json", { snapshot: capturePiSession(sessionId, pi), context: pi.buildSessionContext() });
    manager.recordAcceptedTurn(sessionId, "turn-one");
    getOrCreateLedger(sessionId).create({ subject: "Verify recovery", description: marker });
    const router = { cooldowns: { "fixture/other": 12345 }, attempts: [], activeCandidateKey: "fixture/fixture", activeCandidateSource: "user" };
    manager.persistModelRouteState(sessionId, router);
    write("router.json", router);
    for (const prefix of ["reports", "traces", "tasks", "archive"]) {
      fs.mkdirSync(roots[prefix], { recursive: true });
      fs.writeFileSync(path.join(roots[prefix], "probe.txt"), marker);
    }
    fs.mkdirSync(roots.memory, { recursive: true });
    const db = initMemoryDb(path.join(roots.memory, ".memory.db"));
    db.prepare("INSERT INTO investigations (id,question,created_at,feedback_note) VALUES (?,?,?,?)")
      .run("probe", marker, 1, "verified feedback");
    db.close();
    await manager.checkpointPrivateWorkspace(true);
  } else {
    const expected = read("expected.json");
    assert.deepEqual(pi.getEntries(), expected.snapshot.entries);
    assert.equal(pi.getLeafId(), expected.snapshot.activeLeafId);
    assert.deepEqual(pi.buildSessionContext(), expected.context);
    assert.equal(pi.getHeader().cwd, process.cwd());
    assert.equal(path.basename(pi.getSessionFile()), "checkpoint.jsonl");
    assert(manager.hasAcceptedTurn(sessionId, "turn-one"));
    manager.rehydrateLedger(sessionId);
    assert.equal(getOrCreateLedger(sessionId).get("1").description, marker);
    assert.deepEqual(JSON.parse(JSON.stringify(manager.loadModelRouteState(sessionId))), read("router.json"));
    for (const prefix of ["reports", "traces", "tasks", "archive"]) {
      assert.equal(fs.readFileSync(path.join(roots[prefix], "probe.txt"), "utf8"), marker);
    }
    const db = initMemoryDb(path.join(roots.memory, ".memory.db"));
    assert.equal(db.prepare("SELECT question FROM investigations WHERE id='probe'").get().question, marker);
    assert.equal(db.prepare("SELECT feedback_note FROM investigations WHERE id='probe'").get().feedback_note, "verified feedback");
    db.close();
    if (stage === "resume") {
      const count = pi.buildSessionContext().messages.length;
      pi.appendMessage({ role: "user", content: "What was my session marker?", timestamp: 4 });
      assert.equal(pi.buildSessionContext().messages.length, count + 1);
      assert(JSON.stringify(pi.buildSessionContext().messages).includes(marker));
      assert(!JSON.stringify(pi.buildSessionContext().messages).includes("Inactive branch"));
      write("expected.json", { snapshot: capturePiSession(sessionId, pi), context: pi.buildSessionContext() });
      manager.recordAcceptedTurn(sessionId, "turn-two");
      await manager.checkpointPrivateWorkspace(true);
    } else if (stage === "pending") {
      await manager.preparePrivateTurn(sessionId, { turnId: "unfinished", text: "Unfinished fixture turn" });
    } else if (stage === "verify-pending") {
      assert(manager.hasUncertainPrivateTurn(sessionId));
      await assert.rejects(manager.preparePrivateTurn(sessionId, { turnId: "must-not-replay" }), /uncertain/);
    } else {
      assert(manager.hasAcceptedTurn(sessionId, "turn-two"));
      assert(!manager.hasUncertainPrivateTurn(sessionId));
    }
  }
  assert.deepEqual(fs.readdirSync(".siclaw"), ["user-data"]);
  process.stdout.write(`WORKSPACE_RESULT ${JSON.stringify({ stage, pid: process.pid, messages: pi.buildSessionContext().messages.length, entries: pi.getEntries().length })}\n`);
} finally {
  await manager.privateWorkspace?.close();
  fs.chmodSync(".siclaw", 0o700);
  replies.close();
}
// Imported runtime modules may keep maintenance timers alive. The lease is
// released above; ending this worker is the boundary the parent is testing.
process.exit(0);
