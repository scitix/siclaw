/** Disposable container integration and startup measurements. Never supplies production credentials. */
import assert from "node:assert/strict";
import * as k8s from "@kubernetes/client-node";
import { loadScriptSandboxConfig } from "../../src/script-sandbox/config.js";
import { ScriptSandboxPool } from "../../src/script-sandbox/pool.js";
import { ReadyScriptSandboxProvider } from "../../src/script-sandbox/ready-provider.js";
import { ScriptSandboxService } from "../../src/script-sandbox/service.js";
import { DockerScriptSandboxProvider } from "../../src/gateway/script-sandbox/docker-provider.js";
import { K8sScriptSandboxProvider } from "../../src/gateway/script-sandbox/k8s-provider.js";

const config = loadScriptSandboxConfig({ ...process.env, SICLAW_SCRIPT_SANDBOX_ENABLED: "true",
  SICLAW_SCRIPT_SANDBOX_PROVIDER: process.env.SICLAW_SCRIPT_SANDBOX_PROVIDER ?? "docker",
  SICLAW_SCRIPT_SANDBOX_NAMESPACE: "siclaw-script-smoke", SICLAW_SCRIPT_SANDBOX_NETWORK_ISOLATION: "true",
  SICLAW_SCRIPT_SANDBOX_WARM_POOL_SIZE: "1" });
const kc = new k8s.KubeConfig();
if (config.provider === "k8s") {
  const context = process.env.SICLAW_SCRIPT_SMOKE_KUBE_CONTEXT;
  assert(context?.startsWith("kind-"), "Set an explicit disposable kind context for smoke tests");
  kc.loadFromDefault(); kc.setCurrentContext(context);
  assert(kc.getCurrentCluster(), "Kind context is unavailable");
}
const provider = new ReadyScriptSandboxProvider(config.provider === "docker" ? new DockerScriptSandboxProvider(config) : new K8sScriptSandboxProvider(config, kc));
const pool = new ScriptSandboxPool(provider, config);
const service = new ScriptSandboxService(config, pool, {
  authorize: async () => {},
  authorizeResult: async () => {},
  call: async (_p, _scope, call) => {
    if (call.tool === "test.large") return { rows: Array(40_000).fill("节点🐍") };
    assert.equal(call.tool, "test.echo"); return call.arguments;
  },
});
const principal = { agentId: "smoke", userId: "fixture", boxId: "fixture", sessionId: "fixture" };
const code = `import os, socket, subprocess, ctypes, platform
from siclaw import call, call_to_file
import json
from concurrent.futures import ThreadPoolExecutor
with ThreadPoolExecutor(max_workers=10) as pool:
    results = list(pool.map(lambda i: call("test.echo", {"index": i}), range(70)))
assert results == [{"index": i} for i in range(70)]
info = call_to_file("test.large", {}, "data.json")
assert json.load(open(info["path"]))["rows"] == ["节点🐍"] * 40_000
assert call("test.echo", {"unicode": "🐍" * 30_000}) == {"unicode": "🐍" * 30_000}
assert call("test.echo", {"ok": True}) == {"ok": True}
assert not os.path.exists("/var/run/secrets/kubernetes.io/serviceaccount/token")
assert not os.path.exists("sentinel")
open("sentinel", "w").write("one-use")
for family in (socket.AF_INET, socket.AF_INET6, socket.AF_UNIX):
    try:
        socket.socket(family)
        raise AssertionError("socket creation escaped isolation")
    except PermissionError:
        pass
# Raw syscalls through ctypes must not bypass Python's socket checks.
libc = ctypes.CDLL(None, use_errno=True)
numbers = {"x86_64": (41, 425, 101, 438), "aarch64": (198, 425, 117, 438)}[platform.machine()]
for number in numbers:
    assert libc.syscall(number, 0, 0, 0, 0, 0, 0) == -1
    assert ctypes.get_errno() == 1
subprocess.run(["/bin/bash", "-c", 'echo child-ok'], check=True)
print("isolated-ok")
`;
try {
  const cold = await service.run({ language: "python", code }, { ...principal });
  assert.equal(cold.status, "completed", JSON.stringify(cold)); assert.match(cold.stdout, /isolated-ok/);
  await pool.waitForWarmup();
  const warm = await service.run({ language: "python", code }, { ...principal });
  assert.equal(warm.status, "completed", JSON.stringify(warm)); assert.equal(warm.warm, true);
  const standard = await service.run({ language: "python", code: "import socket; s=socket.socket(); s.close(); print('standard-ok')", network_isolation: false }, { ...principal });
  assert.equal(standard.status, "completed", JSON.stringify(standard)); assert.equal(standard.network_isolation, false);
  const shell = await service.run({ language: "shell", code: "siclaw-tool test.echo '{\"shell\":true}'" }, { ...principal });
  assert.equal(shell.status, "completed", JSON.stringify(shell)); assert.match(shell.stdout, /shell/);
  const shellFile = await service.run({ language: "shell", code: `set -e
siclaw-tool --output data.json test.large '{}' > receipt.json
python3 -c 'import json; assert len(json.load(open("data.json"))["rows"]) == 40000; print("shell-file-ok")'
` }, { ...principal });
  assert.equal(shellFile.status, "completed", JSON.stringify(shellFile)); assert.equal(shellFile.stdout, "shell-file-ok\n");
  const timeout = await service.run({ language: "python", code: "import time; time.sleep(10)", timeout_seconds: 1 }, { ...principal });
  assert.equal(timeout.status, "timed_out");
  const cancellation = new AbortController();
  const timer = setTimeout(() => cancellation.abort(), 500);
  try {
    const cancelled = await service.run({ language: "python", code: "import time; time.sleep(10)" }, { ...principal }, cancellation.signal);
    assert.equal(cancelled.status, "cancelled");
  } finally { clearTimeout(timer); }
  console.log(JSON.stringify({ provider: config.provider, cold_startup_ms: cold.startup_ms, warm_startup_ms: warm.startup_ms,
    cold_total_ms: cold.duration_ms, warm_total_ms: warm.duration_ms, note: "Image already built/loaded; registry pull time excluded. Repeat for p50/p95." }));
} finally {
  await service.shutdown();
  if (config.provider === "k8s") {
    const core = kc.makeApiClient(k8s.CoreV1Api);
    const deadline = Date.now() + 15_000;
    // This smoke test owns its explicitly selected disposable Kind namespace.
    // Deleting a Job without body.propagationPolicy silently orphans its Pods.
    for (;;) {
      const pods = await core.listNamespacedPod({ namespace: config.namespace, labelSelector: "siclaw.io/component=script-runner" });
      if (!pods.items.length) break;
      assert(Date.now() < deadline, "Script runner Pods were not removed after shutdown");
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}
