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
import { PRESETS } from "../provider-presets.js";

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
  // --- Status bar: show config summary on session start ---
  api.on("session_start", async (_event, ctx) => {
    updateSetupStatus(ctx, credentialsDir);
  });

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
          "Credentials",
          "Models",
          "Exit",
        ]);

        if (!action || action === "Exit") {
          running = false;
          continue;
        }

        switch (action) {
          case "Credentials":
            await credentialsSubmenu(ctx, credentialsDir);
            break;
          case "Models":
            await modelsSubmenu(ctx);
            break;
        }
      }

      // Refresh status bar after any config changes
      updateSetupStatus(ctx, credentialsDir);
    },
  });
}

// ---------------------------------------------------------------------------
// Sub-menus
// ---------------------------------------------------------------------------

async function credentialsSubmenu(
  ctx: { ui: { select: Function; input: Function; editor: Function; confirm: Function; notify: Function } },
  credentialsDir: string,
): Promise<void> {
  let running = true;
  while (running) {
    const action = await ctx.ui.select("Credentials", [
      "Add",
      "List",
      "Remove",
      "Back",
    ]);

    if (!action || action === "Back") {
      running = false;
      continue;
    }

    switch (action) {
      case "Add":
        await handleAddCredential(ctx, credentialsDir);
        break;
      case "List":
        await handleListCredentials(ctx, credentialsDir);
        break;
      case "Remove":
        await handleRemoveCredential(ctx, credentialsDir);
        break;
    }
  }
}

async function modelsSubmenu(
  ctx: { ui: { select: Function; input: Function; confirm: Function; notify: Function } },
): Promise<void> {
  let running = true;
  while (running) {
    const action = await ctx.ui.select("Models", [
      "List",
      "Set default",
      "Add model",
      "Add provider",
      "Remove model",
      "Remove provider",
      "Back",
    ]);

    if (!action || action === "Back") {
      running = false;
      continue;
    }

    switch (action) {
      case "List":
        handleListProviders(ctx);
        break;
      case "Set default":
        await handleSetDefault(ctx);
        break;
      case "Add model":
        await handleAddModel(ctx);
        break;
      case "Add provider":
        await handleModelProvider(ctx);
        break;
      case "Remove model":
        await handleRemoveModel(ctx);
        break;
      case "Remove provider":
        await handleRemoveProvider(ctx);
        break;
    }
  }
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
// Config write helper
// ---------------------------------------------------------------------------

function saveProviderToConfig(providerName: string, provider: ProviderConfig): void {
  const configPath = getConfigPath();
  let existing: Partial<SiclawConfig> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch { /* start fresh */ }
  }

  const providers = (existing.providers as Record<string, ProviderConfig>) ?? {};
  providers[providerName] = provider;

  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...existing, providers }, null, 2) + "\n",
  );
  reloadConfig();
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
    const models = provider.models.map((m, i) => {
      const active = isDefault && (defaultModelId ? defaultModelId === m.id : i === 0);
      return active ? `*${m.name || m.id}` : (m.name || m.id);
    });
    lines.push(`  ${isDefault ? ">" : " "} ${name}: ${provider.baseUrl || "(no URL)"}`);
    lines.push(`    Models: ${models.join(", ")}`);
  }

  ctx.ui.notify(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Set default provider/model
// ---------------------------------------------------------------------------

async function handleSetDefault(
  ctx: { ui: { select: Function; notify: Function } },
): Promise<void> {
  const config = loadConfig();
  const entries = Object.entries(config.providers) as [string, ProviderConfig][];

  if (entries.length === 0) {
    ctx.ui.notify("No providers configured.", "warning");
    return;
  }

  // Build flat list: "providerName / modelName (modelId)"
  const options: { label: string; provider: string; modelId: string }[] = [];
  for (const [name, provider] of entries) {
    for (const m of provider.models) {
      options.push({
        label: `${name} / ${m.name || m.id}`,
        provider: name,
        modelId: m.id,
      });
    }
  }

  const selected = await ctx.ui.select(
    "Set default model",
    options.map((o) => o.label),
  );
  if (!selected) return;

  const choice = options.find((o) => o.label === selected);
  if (!choice) return;

  // Write to config
  const configPath = getConfigPath();
  let existing: Partial<SiclawConfig> = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch { /* ignore */ }

  (existing as any).default = {
    provider: choice.provider,
    modelId: choice.modelId,
  };

  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify(existing, null, 2) + "\n",
  );
  reloadConfig();

  ctx.ui.notify(`Default set to: ${choice.provider} / ${choice.modelId}\nRestart session to activate.`);
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

  // Provider name — auto-derive for known presets, only ask for Compatible
  let providerName: string;
  if (preset.needsBaseUrl) {
    const entered = await ctx.ui.input("Provider name");
    if (!entered) return;
    providerName = entered;
  } else {
    providerName = preset.name;
  }

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

  saveProviderToConfig(providerName, provider);

  const modelName = models[0].name || models[0].id;
  ctx.ui.notify(`Provider "${providerName}" saved | Model: ${modelName}\nRestart session to activate.`);
}

// ---------------------------------------------------------------------------
// Add model to existing provider
// ---------------------------------------------------------------------------

async function handleAddModel(
  ctx: { ui: { select: Function; input: Function; notify: Function } },
): Promise<void> {
  const config = loadConfig();
  const entries = Object.entries(config.providers) as [string, ProviderConfig][];

  if (entries.length === 0) {
    ctx.ui.notify("No providers configured. Use Configure provider first.", "warning");
    return;
  }

  // Select provider
  const providerLabel = await ctx.ui.select(
    "Add model to",
    entries.map(([name, p]) => `${name} (${p.baseUrl || "no URL"})`),
  );
  if (!providerLabel) return;

  const providerName = providerLabel.split(" (")[0];

  // Model details
  const modelId = await ctx.ui.input("Model ID");
  if (!modelId) return;

  const modelName = await ctx.ui.input("Model name", modelId);
  const ctxWindowStr = await ctx.ui.input("Context window", "128000");
  const contextWindow = parseInt(ctxWindowStr || "128000", 10);
  const maxTokensStr = await ctx.ui.input("Max output tokens", "8192");
  const maxTokens = parseInt(maxTokensStr || "8192", 10);

  // Read existing provider to inherit api type and compat defaults
  const existingProvider = entries.find(([n]) => n === providerName)?.[1];
  if (!existingProvider) return;

  const isAnthropic = existingProvider.api === "anthropic";

  const newModel: ProviderConfig["models"][number] = {
    id: modelId,
    name: modelName || modelId,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    compat: {
      supportsDeveloperRole: !isAnthropic,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },
  };

  // Write to config
  const configPath = getConfigPath();
  let existing: Partial<SiclawConfig> = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch { /* start fresh */ }

  const providers = (existing.providers as Record<string, ProviderConfig>) ?? {};
  if (!providers[providerName]) {
    ctx.ui.notify(`Provider "${providerName}" not found`, "error");
    return;
  }

  providers[providerName].models.push(newModel);

  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...existing, providers }, null, 2) + "\n",
  );
  reloadConfig();

  const allModels = providers[providerName].models.map((m) => m.name || m.id).join(", ");
  ctx.ui.notify(`Model "${modelName || modelId}" added to "${providerName}".\nModels: ${allModels}\nRestart session to activate.`);
}

// ---------------------------------------------------------------------------
// Remove model from existing provider
// ---------------------------------------------------------------------------

async function handleRemoveModel(
  ctx: { ui: { select: Function; confirm: Function; notify: Function } },
): Promise<void> {
  const config = loadConfig();
  const entries = Object.entries(config.providers) as [string, ProviderConfig][];

  if (entries.length === 0) {
    ctx.ui.notify("No providers configured.", "warning");
    return;
  }

  // Select provider
  const providerLabel = await ctx.ui.select(
    "Remove model from",
    entries.map(([name, p]) => `${name} (${p.models.length} models)`),
  );
  if (!providerLabel) return;

  const providerName = providerLabel.split(" (")[0];
  const provider = entries.find(([n]) => n === providerName)?.[1];
  if (!provider) return;

  if (provider.models.length <= 1) {
    ctx.ui.notify(`Provider "${providerName}" has only one model. Remove the provider instead.`, "warning");
    return;
  }

  // Select model
  const modelLabels = provider.models.map((m) => `${m.name || m.id} (${m.id})`);
  const modelLabel = await ctx.ui.select("Remove model", modelLabels);
  if (!modelLabel) return;

  const modelId = modelLabel.split(" (").pop()?.replace(")", "") ?? "";

  const confirmed = await ctx.ui.confirm(
    "Confirm removal",
    `Remove model "${modelId}" from provider "${providerName}"?`,
  );
  if (!confirmed) return;

  // Write to config
  const configPath = getConfigPath();
  let existing: Partial<SiclawConfig> = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch { /* ignore */ }

  const providers = (existing.providers as Record<string, ProviderConfig>) ?? {};
  if (!providers[providerName]) {
    ctx.ui.notify(`Provider "${providerName}" not found`, "error");
    return;
  }

  providers[providerName].models = providers[providerName].models.filter((m) => m.id !== modelId);

  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...existing, providers }, null, 2) + "\n",
  );
  reloadConfig();

  const remaining = providers[providerName].models.map((m) => m.name || m.id).join(", ");
  ctx.ui.notify(`Model "${modelId}" removed from "${providerName}".\nRemaining: ${remaining}\nRestart session to activate.`);
}

// ---------------------------------------------------------------------------
// Status bar helper
// ---------------------------------------------------------------------------

function updateSetupStatus(
  ctx: { ui: { setStatus: Function } },
  credentialsDir: string,
): void {
  const config = loadConfig();

  // Count credentials
  let credCount = 0;
  try {
    const manifestPath = path.join(credentialsDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      credCount = JSON.parse(fs.readFileSync(manifestPath, "utf-8")).length;
    }
  } catch { /* ignore */ }

  // Count providers
  const providerCount = Object.keys(config.providers).length;

  // Build status parts
  const missing: string[] = [];
  if (providerCount === 0) missing.push("model");
  if (credCount === 0) missing.push("credentials");

  if (missing.length > 0) {
    ctx.ui.setStatus("setup", `/setup: ${missing.join(" + ")} not configured`);
  } else {
    ctx.ui.setStatus("setup", undefined);
  }
}
