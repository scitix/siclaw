import type http from "node:http";
import { loadGatewayConfig } from "./gateway/config.js";
import { startGateway } from "./gateway/server.js";
import { AgentBoxManager, LocalSpawner, K8sSpawner, ProcessSpawner } from "./gateway/agentbox/index.js";
import { createChannelBridge } from "./gateway/plugins/channel-bridge.js";
import { ChannelStore } from "./gateway/channels/channel-store.js";
import { ChannelManager } from "./gateway/channels/channel-manager.js";
import { createChannelRpcMethods } from "./gateway/channels/channel-rpc.js";
import { ConfigRepository } from "./gateway/db/repositories/config-repo.js";
import { WorkspaceRepository } from "./gateway/db/repositories/workspace-repo.js";


// Parse arguments
const args = process.argv.slice(2);
const useK8s = args.includes("--k8s");
const useProcess = args.includes("--process");

// Load config
const config = loadGatewayConfig();
console.log(`[gateway] Config: port=${config.port}, host=${config.host}`);

// Create Spawner (selects K8s / Process / Local based on arguments)
const spawner = useK8s
  ? new K8sSpawner({
      namespace: process.env.SICLAW_K8S_NAMESPACE || "default",
      image: process.env.SICLAW_AGENTBOX_IMAGE || "siclaw-agentbox:latest",
      persistence: process.env.SICLAW_PERSISTENCE_ENABLED === "true"
        ? {
            enabled: true,
            storageClass: process.env.SICLAW_PERSISTENCE_STORAGE_CLASS || "",
            accessMode: process.env.SICLAW_PERSISTENCE_ACCESS_MODE || "ReadWriteMany",
            size: process.env.SICLAW_PERSISTENCE_SIZE || "1Gi",
          }
        : undefined,
    })
  : useProcess
    ? new ProcessSpawner()
    : new LocalSpawner(4000);

console.log(`[gateway] Using spawner: ${spawner.name}`);

// Create AgentBox Manager
const agentBoxManager = new AgentBoxManager(spawner, {
  namespace: process.env.SICLAW_K8S_NAMESPACE || "default",
});
agentBoxManager.startHealthCheck();

// Channel RPC + Manager are initialized after gateway starts (needs broadcast)

// Plugin HTTP handlers (dynamically loaded from overlay builds)
const extraHttpHandlers = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>();
try {
  const pluginPath = "./gateway/plugins/internal/index.js";
  const { createHandlers } = await import(pluginPath);
  for (const [k, v] of createHandlers()) extraHttpHandlers.set(k, v);
  console.log("[gateway] Internal plugin loaded");
} catch {
  // Internal plugin not available — running in open-source mode
}

// Start HTTP + WebSocket server
const gateway = await startGateway({
  config,
  agentBoxManager,
  spawner,
  extraHttpHandlers,
});

// --- Channel subsystem ---
// ChannelStore: persists channel configs to DB
const channelStore = new ChannelStore(gateway.db);
await channelStore.init();

// Repositories for channel bridge
const configRepo = gateway.db ? new ConfigRepository(gateway.db) : undefined;
const wsRepo = gateway.db ? new WorkspaceRepository(gateway.db) : undefined;

// Create channel bridge (routes through AgentBox pods, not in-process sessions)
const channelBridge = createChannelBridge(agentBoxManager, gateway.broadcast, gateway.userStore, configRepo, gateway.buildCredentialPayload, wsRepo);

// Auto-remember chatId from inbound messages for notifications
channelBridge.onInbound = (channelId, chatId) => {
  channelStore.setDefaultChatId(channelId, chatId);
};

// Create channel manager (with deps for bind command interception)
const channelManager = new ChannelManager(channelBridge, channelStore, {
  userStore: gateway.userStore,
  bindCodeStore: gateway.bindCodeStore,
});

// Register channel RPC methods
const channelRpc = createChannelRpcMethods(channelStore, channelManager);
for (const [name, handler] of channelRpc) {
  gateway.rpcMethods.set(name, handler);
}

// --- Cron notification callback ---
gateway.onCronNotify = (data) => {
  const { userId, jobName, result, resultText, error } = data;
  const text = result === "success"
    ? `**Scheduled task "${jobName}" completed**\n\n${resultText || "(no output)"}`
    : `**Scheduled task "${jobName}" failed**\n\n${error || "Unknown error"}`;
  channelManager.sendUserNotification(userId, text);
};

// --- Trigger webhook subsystem ---
// Triggers execute via the same internal agent-prompt API as cron
gateway.onWebhook = async (trigger, payload) => {
  const sessionId = `trigger-${trigger.id}`;
  const description = (trigger.configJson as any)?.description || trigger.name;
  const prompt = `You received an event from trigger "${trigger.name}".
Trigger description: ${description}
Event payload:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`
Analyze this event and take appropriate action.`;

  try {
    const resp = await fetch(`http://localhost:${config.port}/api/internal/agent-prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: trigger.userId,
        sessionId,
        text: prompt,
        timeoutMs: 300_000,
        caller: "trigger",
      }),
    });
    const data = await resp.json() as { status: string; error?: string };
    if (data.status !== "success") {
      console.error(`[trigger] ${trigger.id} failed: ${data.error}`);
    }
  } catch (err) {
    console.error(`[trigger] Error for ${trigger.id}:`, err instanceof Error ? err.message : err);
  }
};

// Boot all enabled channels
channelManager.bootFromStore().then(() => {
  console.log("[gateway] Channel boot complete");
}).catch((err) => {
  console.error("[gateway] Channel boot error:", err);
});

// Graceful shutdown
async function shutdown() {
  console.log("\n[gateway] Shutting down...");
  await channelManager.stopAll();
  await gateway.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
