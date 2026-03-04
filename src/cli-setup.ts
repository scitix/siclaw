/**
 * Interactive first-run setup for TUI mode.
 *
 * Uses Node.js readline (no pi-agent dependency) because InteractiveMode
 * hasn't started yet when this runs.
 */

import fs from "node:fs";
import readline from "node:readline";
import { getConfigPath, loadConfig, reloadConfig, type ProviderConfig, type SiclawConfig } from "./core/config.js";

// ---------------------------------------------------------------------------
// Provider presets
// ---------------------------------------------------------------------------

interface ProviderPreset {
  label: string;
  key: string;
  baseUrl: string;
  api: string;
  models: ProviderConfig["models"];
  needsBaseUrl?: boolean; // true = prompt user for base URL
}

const PRESETS: ProviderPreset[] = [
  {
    label: "OpenAI (GPT-4o, GPT-4o-mini)",
    key: "openai",
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
    key: "anthropic",
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
    label: "Compatible API (Qwen, DeepSeek, Ollama, etc.)",
    key: "compatible",
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
// Readline helpers
// ---------------------------------------------------------------------------

function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function askSelect(rl: readline.Interface, prompt: string, options: string[]): Promise<number> {
  return new Promise((resolve) => {
    console.log(prompt);
    for (let i = 0; i < options.length; i++) {
      console.log(`  ${i + 1}) ${options[i]}`);
    }
    const doAsk = () => {
      rl.question(`Choose [1-${options.length}]: `, (answer) => {
        const num = parseInt(answer.trim(), 10);
        if (num >= 1 && num <= options.length) {
          resolve(num - 1);
        } else {
          doAsk();
        }
      });
    };
    doAsk();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true if interactive setup should run:
 * - settings.json does not exist, OR
 * - providers object is empty
 */
export function needsSetup(): boolean {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return true;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const providers = raw.providers;
    if (!providers || typeof providers !== "object" || Object.keys(providers).length === 0) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Interactive provider configuration wizard.
 * Writes result to `.siclaw/config/settings.json`.
 */
export async function runInteractiveSetup(): Promise<void> {
  const rl = createRl();

  try {
    console.log("");
    console.log("  Welcome to Siclaw! Let's configure your AI provider.");
    console.log("");

    // 1. Select provider type
    const presetIdx = await askSelect(
      rl,
      "  Select provider type:",
      PRESETS.map((p) => p.label),
    );
    const preset = PRESETS[presetIdx];

    // 2. API Key
    const apiKeyInput = await ask(rl, `  API Key: `);
    if (!apiKeyInput) {
      console.log("  API key is required. Setup aborted.");
      return;
    }

    // Offer env-var reference storage (recommended for security)
    let apiKey: string;
    if (!apiKeyInput.startsWith("$")) {
      const storageChoice = await askSelect(rl, "  How to store the API key?", [
        "As environment variable reference (recommended — key stays out of config files)",
        "Store directly in settings.json (simple but less secure)",
      ]);
      if (storageChoice === 0) {
        const envVarName = preset.key === "compatible"
          ? "SICLAW_PROVIDER_API_KEY"
          : `${preset.key.toUpperCase()}_API_KEY`;
        const suggestedName = await ask(rl, `  Env var name [${envVarName}]: `);
        const finalName = suggestedName || envVarName;
        apiKey = `$${finalName}`;
        console.log("");
        console.log(`  Will store "$${finalName}" in config.`);
        console.log(`  Make sure to set the env var before running siclaw:`);
        console.log(`    export ${finalName}=${apiKeyInput}`);
        console.log("");
      } else {
        apiKey = apiKeyInput;
      }
    } else {
      // User already provided a $VAR reference
      apiKey = apiKeyInput;
    }

    // 3. Base URL (only if needed or custom)
    let baseUrl = preset.baseUrl;
    if (preset.needsBaseUrl) {
      const entered = await ask(rl, `  Base URL: `);
      if (entered) baseUrl = entered;
      if (!baseUrl) {
        console.log("  Base URL is required for compatible providers. Setup aborted.");
        return;
      }
    } else {
      const entered = await ask(rl, `  Base URL [${preset.baseUrl}]: `);
      if (entered) baseUrl = entered;
    }

    // 4. Model ID for compatible provider
    let models = preset.models;
    if (preset.key === "compatible") {
      const modelId = await ask(rl, `  Model ID [default]: `);
      if (modelId) {
        models = [{ ...models[0], id: modelId, name: modelId }];
      }
    }

    // 5. Build and write config
    const provider: ProviderConfig = {
      baseUrl,
      apiKey,
      api: preset.api,
      authHeader: true,
      models,
    };

    // Load existing config or start from defaults
    const configPath = getConfigPath();
    let existing: Partial<SiclawConfig> = {};
    if (fs.existsSync(configPath)) {
      try {
        existing = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      } catch { /* start fresh */ }
    }

    const providers = (existing.providers as Record<string, ProviderConfig>) ?? {};
    providers["default"] = provider;

    const configDir = configPath.replace(/[/\\][^/\\]+$/, "");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...existing, providers }, null, 2) + "\n",
    );

    // Reload config cache so loadConfig() picks up the new settings
    reloadConfig();

    const modelName = models[0].name || models[0].id;
    console.log("");
    console.log(`  Saved to ${configPath}`);
    console.log(`  Model: ${modelName} | Provider: ${preset.label.split(" (")[0]}`);
    console.log("");
  } finally {
    rl.close();
  }
}
