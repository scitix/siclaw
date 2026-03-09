/**
 * First-run setup wizard using @clack/prompts.
 *
 * Runs before session creation when no provider is configured.
 * Configures one provider + model, writes settings.json, then returns
 * so cli-main.ts can continue into the TUI session.
 */

import fs from "node:fs";
import path from "node:path";
import { intro, outro, selectKey, text, password, note, cancel, isCancel } from "@clack/prompts";
import { getConfigPath, reloadConfig, type ProviderConfig, type SiclawConfig } from "./core/config.js";
import { PRESETS } from "./core/provider-presets.js";

/**
 * Run the first-run setup wizard. Returns true if setup completed successfully.
 */
export async function runFirstRunSetup(): Promise<boolean> {
  // Clear any prior console output (e.g. mcp-client logs) to avoid clack rendering artifacts
  console.clear();
  intro("Welcome to Siclaw");

  // 1. Select provider (use selectKey to avoid scroll rendering bugs)
  const presetKey = await selectKey({
    message: "Select a model provider",
    options: PRESETS.map((p, i) => ({
      value: String(i),
      label: p.label,
      key: String(i + 1),
    })),
  });

  if (isCancel(presetKey)) {
    cancel("Setup cancelled.");
    return false;
  }

  const preset = PRESETS[parseInt(presetKey as string, 10)];

  // 2. API Key
  const apiKey = await password({
    message: "API Key",
  });

  if (isCancel(apiKey) || !apiKey) {
    cancel("API key is required.");
    return false;
  }

  // 3. Base URL (required for Compatible, optional override for others)
  let baseUrl = preset.baseUrl;
  if (preset.needsBaseUrl) {
    const entered = await text({
      message: "Base URL",
      placeholder: "https://api.example.com/v1",
    });
    if (isCancel(entered) || !entered) {
      cancel("Base URL is required.");
      return false;
    }
    baseUrl = entered.trim();
  }

  // 4. Model ID (for compatible APIs)
  let models = preset.models;
  if (preset.needsBaseUrl) {
    const modelId = await text({
      message: "Model ID",
      placeholder: "e.g. qwen-plus, deepseek-chat",
    });
    if (isCancel(modelId)) {
      cancel("Setup cancelled.");
      return false;
    }
    if (modelId) {
      const trimmed = modelId.trim();
      models = [{ ...models[0], id: trimmed, name: trimmed }];
    }
  }

  // 5. Write config
  const providerName = preset.name;
  const provider: ProviderConfig = {
    baseUrl,
    apiKey: (apiKey as string).trim(),
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
  providers[providerName] = provider;

  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(
    configPath,
    JSON.stringify({ ...existing, providers }, null, 2) + "\n",
    { mode: 0o600 },
  );

  reloadConfig();

  const modelName = models[0].name || models[0].id;
  note(
    `Provider: ${preset.label.split(" (")[0]}\nModel: ${modelName}\nConfig: ${configPath}`,
    "Configuration saved",
  );

  outro("Starting session... Use /setup to add credentials and more providers.");
  return true;
}
