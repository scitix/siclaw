/**
 * /setup extension — in-session environment configuration for TUI mode.
 *
 * Provides credential management (kubeconfig, SSH, API tokens) and
 * model provider configuration via interactive dialogs.
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  listCredentials,
  registerKubeconfig,
  registerSshPassword,
  registerSshKey,
  registerApiToken,
  registerApiBasicAuth,
  removeCredential,
  probeKubeconfig,
  type CredentialType,
} from "../../tools/credential-manager.js";
import {
  getConfigPath,
  loadConfig,
  reloadConfig,
  type ProviderConfig,
  type SiclawConfig,
} from "../config.js";

// ---------------------------------------------------------------------------
// Provider presets (extracted from cli-setup.ts)
// ---------------------------------------------------------------------------

interface ProviderPreset {
  label: string;
  baseUrl: string;
  api: string;
  models: ProviderConfig["models"];
  needsBaseUrl?: boolean;
}

const PRESETS: ProviderPreset[] = [
  {
    label: "OpenAI (GPT-4o, GPT-4o-mini)",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    models: [
      {
        id: "gpt-4o",
        name: "GPT-4o",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
        compat: { supportsDeveloperRole: true, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      },
      {
        id: "gpt-4o-mini",
        name: "GPT-4o-mini",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
        compat: { supportsDeveloperRole: true, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      },
    ],
  },
  {
    label: "Anthropic (Claude Sonnet 4, Claude Opus 4)",
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic",
    models: [
      {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16000,
        compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      },
      {
        id: "claude-opus-4-20250514",
        name: "Claude Opus 4",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 16000,
        compat: { supportsDeveloperRole: false, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      },
    ],
  },
  {
    label: "Compatible API (Qwen, DeepSeek, Kimi, Ollama, etc.)",
    baseUrl: "",
    api: "openai-completions",
    needsBaseUrl: true,
    models: [
      {
        id: "default",
        name: "Default Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192,
        compat: { supportsDeveloperRole: true, supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Credential type labels
// ---------------------------------------------------------------------------

const CREDENTIAL_TYPE_LABELS: Record<CredentialType, string> = {
  kubeconfig: "Kubeconfig",
  ssh_password: "SSH Password",
  ssh_key: "SSH Key",
  api_token: "API Token",
  api_basic_auth: "API Basic Auth",
};

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function setupExtension(api: ExtensionAPI, credentialsDir: string): void {
  api.registerCommand("setup", {
    description: "Configure credentials and model provider",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Use web UI to manage credentials", "warning");
        return;
      }

      // Main menu loop
      let running = true;
      while (running) {
        const action = await ctx.ui.select("Setup", [
          "Add credential",
          "List credentials",
          "Remove credential",
          "List providers",
          "Configure provider",
          "Remove provider",
          "Exit",
        ]);

        if (!action || action === "Exit") {
          running = false;
          continue;
        }

        switch (action) {
          case "Add credential":
            await handleAddCredential(ctx, credentialsDir);
            break;
          case "List credentials":
            await handleListCredentials(ctx, credentialsDir);
            break;
          case "Remove credential":
            await handleRemoveCredential(ctx, credentialsDir);
            break;
          case "List providers":
            handleListProviders(ctx);
            break;
          case "Configure provider":
            await handleModelProvider(ctx);
            break;
          case "Remove provider":
            await handleRemoveProvider(ctx);
            break;
        }
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Add credential flow
// ---------------------------------------------------------------------------

async function handleAddCredential(
  ctx: { ui: { select: Function; input: Function; editor: Function; confirm: Function; notify: Function } },
  credentialsDir: string,
): Promise<void> {
  const typeLabel = await ctx.ui.select(
    "Credential Type",
    Object.values(CREDENTIAL_TYPE_LABELS),
  );
  if (!typeLabel) return;

  const type = (Object.entries(CREDENTIAL_TYPE_LABELS).find(
    ([, label]) => label === typeLabel,
  )?.[0] ?? "kubeconfig") as CredentialType;

  switch (type) {
    case "kubeconfig":
      await addKubeconfig(ctx, credentialsDir);
      break;
    case "ssh_password":
      await addSshPassword(ctx, credentialsDir);
      break;
    case "ssh_key":
      await addSshKey(ctx, credentialsDir);
      break;
    case "api_token":
      await addApiToken(ctx, credentialsDir);
      break;
    case "api_basic_auth":
      await addApiBasicAuth(ctx, credentialsDir);
      break;
  }
}

async function addKubeconfig(
  ctx: { ui: { select: Function; input: Function; editor: Function; confirm: Function; notify: Function } },
  credentialsDir: string,
): Promise<void> {
  const inputMethod = await ctx.ui.select("Kubeconfig source", [
    "File path",
    "Paste content",
  ]);
  if (!inputMethod) return;

  let kubeconfigContent: string | undefined;
  let resolvedPath: string | undefined;
  let defaultName = "cluster";

  if (inputMethod === "Paste content") {
    const raw = await ctx.ui.editor("Paste kubeconfig YAML/JSON");
    if (!raw) return;
    kubeconfigContent = raw;
    try {
      const yamlMod = await import("js-yaml");
      const kc = yamlMod.load(raw) as Record<string, unknown>;
      if (kc?.["current-context"]) {
        defaultName = String(kc["current-context"]);
      }
    } catch { /* use default */ }
  } else {
    const sourcePath = await ctx.ui.input("Kubeconfig path", "~/.kube/config");
    if (!sourcePath) return;
    resolvedPath = sourcePath.startsWith("~")
      ? path.join(process.env.HOME ?? "", sourcePath.slice(1))
      : path.resolve(sourcePath);

    defaultName = path.basename(resolvedPath, path.extname(resolvedPath));
    try {
      const yamlMod = await import("js-yaml");
      const content = fs.readFileSync(resolvedPath, "utf-8");
      const kc = yamlMod.load(content) as Record<string, unknown>;
      if (kc?.["current-context"]) {
        defaultName = String(kc["current-context"]);
      }
    } catch { /* use filename */ }
  }

  const name = await ctx.ui.input("Credential name", defaultName);
  if (!name) return;

  const { entry, error } = registerKubeconfig(credentialsDir, {
    name,
    ...(kubeconfigContent ? { content: kubeconfigContent } : { sourcePath: resolvedPath }),
  });
  if (error) {
    ctx.ui.notify(error, "error");
    return;
  }

  // Probe connectivity
  const kubeconfigFile = path.join(credentialsDir, entry.files[0]);
  ctx.ui.notify(`Probing ${name}...`);
  const probe = await probeKubeconfig(kubeconfigFile);

  if (probe.reachable) {
    ctx.ui.notify(`Kubeconfig "${name}" added (server ${probe.version})`);
  } else {
    ctx.ui.notify(`Kubeconfig "${name}" added but unreachable: ${probe.error}`, "warning");
  }
}

async function addSshPassword(
  ctx: { ui: { input: Function; notify: Function } },
  credentialsDir: string,
): Promise<void> {
  const name = await ctx.ui.input("Credential name", "my-server");
  if (!name) return;
  const host = await ctx.ui.input("Host", "192.168.1.100");
  if (!host) return;
  const portStr = await ctx.ui.input("Port", "22");
  const port = portStr ? parseInt(portStr, 10) : 22;
  const username = await ctx.ui.input("Username", "root");
  if (!username) return;
  const password = await ctx.ui.input("Password");
  if (!password) return;

  registerSshPassword(credentialsDir, { name, host, port, username, password });
  ctx.ui.notify(`SSH password credential "${name}" added`);
}

async function addSshKey(
  ctx: { ui: { input: Function; notify: Function } },
  credentialsDir: string,
): Promise<void> {
  const name = await ctx.ui.input("Credential name", "my-server");
  if (!name) return;
  const host = await ctx.ui.input("Host", "192.168.1.100");
  if (!host) return;
  const portStr = await ctx.ui.input("Port", "22");
  const port = portStr ? parseInt(portStr, 10) : 22;
  const username = await ctx.ui.input("Username", "root");
  if (!username) return;
  const keyPath = await ctx.ui.input("Private key path", "~/.ssh/id_rsa");
  if (!keyPath) return;

  const resolvedKey = keyPath.startsWith("~")
    ? path.join(process.env.HOME ?? "", keyPath.slice(1))
    : path.resolve(keyPath);

  const { error } = registerSshKey(credentialsDir, {
    name, host, port, username, keyPath: resolvedKey,
  });
  if (error) {
    ctx.ui.notify(error, "error");
    return;
  }
  ctx.ui.notify(`SSH key credential "${name}" added`);
}

async function addApiToken(
  ctx: { ui: { input: Function; notify: Function } },
  credentialsDir: string,
): Promise<void> {
  const name = await ctx.ui.input("Credential name", "my-api");
  if (!name) return;
  const url = await ctx.ui.input("API base URL (optional)");
  const token = await ctx.ui.input("Token");
  if (!token) return;

  registerApiToken(credentialsDir, { name, url: url || undefined, token });
  ctx.ui.notify(`API token credential "${name}" added`);
}

async function addApiBasicAuth(
  ctx: { ui: { input: Function; notify: Function } },
  credentialsDir: string,
): Promise<void> {
  const name = await ctx.ui.input("Credential name", "my-api");
  if (!name) return;
  const url = await ctx.ui.input("API base URL (optional)");
  const username = await ctx.ui.input("Username");
  if (!username) return;
  const password = await ctx.ui.input("Password");
  if (!password) return;

  registerApiBasicAuth(credentialsDir, {
    name, url: url || undefined, username, password,
  });
  ctx.ui.notify(`API basic auth credential "${name}" added`);
}

// ---------------------------------------------------------------------------
// List credentials flow
// ---------------------------------------------------------------------------

async function handleListCredentials(
  ctx: { ui: { notify: Function } },
  credentialsDir: string,
): Promise<void> {
  const entries = await listCredentials(credentialsDir);

  if (entries.length === 0) {
    ctx.ui.notify("No credentials configured. Use /setup to add one.");
    return;
  }

  const lines: string[] = ["Credentials:"];
  for (const e of entries) {
    let status = "";
    if (e.type === "kubeconfig") {
      status = e.reachable ? ` [connected, ${e.server_version}]` : ` [unreachable: ${e.probe_error}]`;
    }
    lines.push(`  ${e.name} (${e.type})${status}`);
  }

  ctx.ui.notify(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Remove credential flow
// ---------------------------------------------------------------------------

async function handleRemoveCredential(
  ctx: { ui: { select: Function; confirm: Function; notify: Function } },
  credentialsDir: string,
): Promise<void> {
  const entries = await listCredentials(credentialsDir);

  if (entries.length === 0) {
    ctx.ui.notify("No credentials to remove.");
    return;
  }

  const names = entries.map((e) => `${e.name} (${e.type})`);
  const selected = await ctx.ui.select("Remove credential", names);
  if (!selected) return;

  const name = selected.split(" (")[0];

  const confirmed = await ctx.ui.confirm(
    "Confirm removal",
    `Remove credential "${name}" and its files?`,
  );
  if (!confirmed) return;

  const { removed } = removeCredential(credentialsDir, name);
  if (removed) {
    ctx.ui.notify(`Credential "${name}" removed`);
  } else {
    ctx.ui.notify(`Credential "${name}" not found`, "warning");
  }
}

// ---------------------------------------------------------------------------
// List providers flow
// ---------------------------------------------------------------------------

function handleListProviders(
  ctx: { ui: { notify: Function } },
): void {
  const config = loadConfig();
  const entries = Object.entries(config.providers) as [string, ProviderConfig][];

  if (entries.length === 0) {
    ctx.ui.notify("No providers configured. Use /setup → Configure provider.");
    return;
  }

  const defaultProvider = config.default?.provider ?? entries[0][0];
  const defaultModelId = config.default?.modelId;

  const lines: string[] = ["Providers:"];
  for (const [name, provider] of entries) {
    const isDefault = name === defaultProvider;
    const models = provider.models.map((m) => {
      const active = isDefault && (!defaultModelId || defaultModelId === m.id);
      return active ? `*${m.name || m.id}` : (m.name || m.id);
    });
    lines.push(`  ${isDefault ? ">" : " "} ${name}: ${provider.baseUrl || "(no URL)"}`);
    lines.push(`    Models: ${models.join(", ")}`);
  }

  ctx.ui.notify(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Remove provider flow
// ---------------------------------------------------------------------------

async function handleRemoveProvider(
  ctx: { ui: { select: Function; confirm: Function; notify: Function } },
): Promise<void> {
  const config = loadConfig();
  const entries = Object.entries(config.providers) as [string, ProviderConfig][];

  if (entries.length === 0) {
    ctx.ui.notify("No providers to remove.");
    return;
  }

  const names = entries.map(([name, p]) => {
    const model = p.models[0]?.name || p.models[0]?.id || "?";
    return `${name} (${model})`;
  });

  const selected = await ctx.ui.select("Remove provider", names);
  if (!selected) return;

  const providerName = selected.split(" (")[0];

  const confirmed = await ctx.ui.confirm(
    "Confirm removal",
    `Remove provider "${providerName}"?`,
  );
  if (!confirmed) return;

  const configPath = getConfigPath();
  let existing: Partial<SiclawConfig> = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch { /* start fresh */ }

  const providers = (existing.providers as Record<string, ProviderConfig>) ?? {};
  delete providers[providerName];

  // Clear default if it pointed to the removed provider
  if (existing.default && (existing.default as any).provider === providerName) {
    delete existing.default;
  }

  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...existing, providers }, null, 2) + "\n",
  );
  reloadConfig();

  ctx.ui.notify(`Provider "${providerName}" removed. Restart session to take effect.`);
}

// ---------------------------------------------------------------------------
// Configure provider flow
// ---------------------------------------------------------------------------

async function handleModelProvider(
  ctx: { ui: { select: Function; input: Function; notify: Function } },
): Promise<void> {
  const presetLabel = await ctx.ui.select(
    "Provider",
    PRESETS.map((p) => p.label),
  );
  if (!presetLabel) return;

  const preset = PRESETS.find((p) => p.label === presetLabel)!;

  // API Key
  const apiKey = await ctx.ui.input("API Key");
  if (!apiKey) {
    ctx.ui.notify("API key is required", "warning");
    return;
  }

  // Base URL
  let baseUrl = preset.baseUrl;
  if (preset.needsBaseUrl) {
    const entered = await ctx.ui.input("Base URL");
    if (!entered) {
      ctx.ui.notify("Base URL is required", "warning");
      return;
    }
    baseUrl = entered;
  } else {
    const entered = await ctx.ui.input("Base URL (Enter to keep default)", preset.baseUrl);
    if (entered) baseUrl = entered;
  }

  // Model ID (for compatible APIs)
  let models = preset.models;
  if (preset.needsBaseUrl) {
    const modelId = await ctx.ui.input("Model ID", "default");
    if (modelId && modelId !== "default") {
      models = [{ ...models[0], id: modelId, name: modelId }];
    }
  }

  // Write config
  const provider: ProviderConfig = {
    baseUrl,
    apiKey,
    api: preset.api,
    authHeader: true,
    models,
  };

  const configPath = getConfigPath();
  let existing: Partial<SiclawConfig> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch { /* start fresh */ }
  }

  const providers = (existing.providers as Record<string, ProviderConfig>) ?? {};
  providers["default"] = provider;

  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...existing, providers }, null, 2) + "\n",
  );

  reloadConfig();

  const modelName = models[0].name || models[0].id;
  ctx.ui.notify(`Provider saved: ${presetLabel.split(" (")[0]} | Model: ${modelName}\nRestart session to activate the new provider.`);
}
