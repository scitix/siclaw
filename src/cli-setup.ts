/**
 * Interactive setup wizard for TUI mode (`siclaw --setup`).
 *
 * Writes plain values to `.siclaw/config/settings.json`.
 * No $VAR indirection — env vars are handled by config.ts at load time.
 */

import fs from "node:fs";
import readline from "node:readline";
import { getConfigPath, reloadConfig, type ProviderConfig, type SiclawConfig } from "./core/config.js";

// ---------------------------------------------------------------------------
// Provider presets
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
// Readline helpers
// ---------------------------------------------------------------------------

function createRl(): readline.Interface {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

/** Like ask() but suppresses input echo (for API keys / secrets). */
function askSecret(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    const rlAny = rl as any;
    const output = rlAny.output as NodeJS.WritableStream;
    rlAny._writeToOutput = function (s: string) {
      if (s === question) output.write(s);
    };
    rl.question(question, (answer) => {
      rlAny._writeToOutput = (s: string) => output.write(s);
      output.write("\n");
      resolve(answer.trim());
    });
  });
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
 * Returns true if the user has no usable LLM configuration:
 * - No SICLAW_API_KEY / SICLAW_LLM_API_KEY env var, AND
 * - No settings.json with providers
 */
export function needsSetup(): boolean {
  // Env vars are sufficient — no settings.json needed
  if (process.env.SICLAW_API_KEY || process.env.SICLAW_LLM_API_KEY) return false;

  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return true;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const providers = raw.providers;
    if (!providers || typeof providers !== "object" || Object.keys(providers).length === 0) {
      return true;
    }
    // Check that at least one provider has an apiKey
    for (const p of Object.values(providers) as any[]) {
      if (p.apiKey) return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Print configuration instructions and exit.
 */
export function printSetupInstructions(): void {
  console.error(`
  No LLM provider configured.

  Option 1 — environment variables (recommended):

    export SICLAW_API_KEY=sk-...
    export SICLAW_BASE_URL=https://api.openai.com/v1  # or your provider's URL
    export SICLAW_MODEL=gpt-4o                         # optional
    siclaw

  Option 2 — setup wizard:

    siclaw --setup
`);
}

/**
 * Interactive provider configuration wizard.
 * Writes plain values to `.siclaw/config/settings.json`.
 */
export async function runInteractiveSetup(): Promise<void> {
  const rl = createRl();

  try {
    console.log("");
    console.log("  Siclaw Setup");
    console.log("");

    // 1. Select provider type
    const presetIdx = await askSelect(
      rl,
      "  Provider:",
      PRESETS.map((p) => p.label),
    );
    const preset = PRESETS[presetIdx];

    // 2. API Key (masked input)
    const apiKey = await askSecret(rl, `  API Key: `);
    if (!apiKey) {
      console.log("  API key is required. Aborted.");
      return;
    }

    // 3. Base URL
    let baseUrl = preset.baseUrl;
    if (preset.needsBaseUrl) {
      const entered = await ask(rl, `  Base URL: `);
      if (entered) baseUrl = entered;
      if (!baseUrl) {
        console.log("  Base URL is required. Aborted.");
        return;
      }
    } else {
      const entered = await ask(rl, `  Base URL [${preset.baseUrl}]: `);
      if (entered) baseUrl = entered;
    }

    // 4. Model ID (compatible provider only)
    let models = preset.models;
    if (preset.needsBaseUrl) {
      const modelId = await ask(rl, `  Model ID [default]: `);
      if (modelId) {
        models = [{ ...models[0], id: modelId, name: modelId }];
      }
    }

    // 5. Write config
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

    const configDir = configPath.replace(/[/\\][^/\\]+$/, "");
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...existing, providers }, null, 2) + "\n",
    );

    reloadConfig();

    const modelName = models[0].name || models[0].id;
    console.log("");
    console.log(`  Saved to ${configPath}`);
    console.log(`  Provider: ${preset.label.split(" (")[0]} | Model: ${modelName}`);
    console.log("");
  } finally {
    rl.close();
  }
}
