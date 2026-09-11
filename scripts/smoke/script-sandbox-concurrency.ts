/** Native container proof: all 100 calls enter before any receives its reply. */
import assert from "node:assert/strict";
import { loadScriptSandboxConfig } from "../../src/script-sandbox/config.js";
import { ScriptSandboxService } from "../../src/script-sandbox/service.js";
import { ReadyScriptSandboxProvider } from "../../src/script-sandbox/ready-provider.js";
import { DockerScriptSandboxProvider } from "../../src/gateway/script-sandbox/docker-provider.js";

const config = loadScriptSandboxConfig({ ...process.env, SICLAW_SCRIPT_SANDBOX_ENABLED: "true",
  SICLAW_SCRIPT_SANDBOX_NETWORK_ISOLATION: "true", SICLAW_SCRIPT_SANDBOX_MAX_CONCURRENT_RUNS: "10" });
assert(config.image, "Supply a freshly built runner image");
let entered = 0;
let release!: () => void;
const barrier = new Promise<void>(resolve => { release = resolve; });
const service = new ScriptSandboxService(config, new ReadyScriptSandboxProvider(new DockerScriptSandboxProvider(config)), {
  authorize: async () => {},
  call: async (_, __, call, signal) => {
    assert.equal(call.tool, "test.echo");
    if (++entered === 100) release();
    await Promise.race([barrier, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))]);
    return call.arguments;
  },
});
const code = `from concurrent.futures import ThreadPoolExecutor
from siclaw import call
with ThreadPoolExecutor(max_workers=10) as pool:
    rows = list(pool.map(lambda i: call("test.echo", {"index": i}), range(10)))
assert rows == [{"index": i} for i in range(10)]
print("parallel-ok")
`;
try {
  const runs = Array.from({ length: 10 }, (_, i) => service.run({ language: "python", code }, {
    agentId: "fixture", boxId: "fixture", userId: `user-${i}`, sessionId: `session-${i}`,
  }));
  await assert.rejects(service.run({ language: "python", code }, {
    agentId: "fixture", boxId: "fixture", userId: "extra", sessionId: "extra",
  }), /busy/);
  const results = await Promise.all(runs);
  assert.equal(entered, 100);
  for (const result of results) {
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.stdout, "parallel-ok\n");
    assert.equal(result.tool_calls, 10);
  }
  console.log(JSON.stringify({ concurrent_containers: 10, simultaneous_sdk_calls: entered,
    startup_ms: results.map(r => r.startup_ms), statuses: results.map(r => r.status) }));
} finally { await service.shutdown(); }
