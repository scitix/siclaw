import fs from "node:fs";
import path from "node:path";

export interface ChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface GatewayConfig {
  port: number;
  internalPort?: number; // HTTPS port for internal mTLS API (default: 3002)
  host: string;
  plugins: {
    paths: string[];
  };
  channels: Record<string, ChannelConfig>;
}

const DEFAULT_CONFIG: GatewayConfig = {
  port: 3000,
  host: "0.0.0.0",
  plugins: {
    paths: ["./node_modules"],
  },
  channels: {},
};

export function loadGatewayConfig(): GatewayConfig {
  try {
    // Read port from shared settings.json so one file controls everything
    const configPath = process.env.SICLAW_CONFIG_DIR
      ? path.resolve(process.env.SICLAW_CONFIG_DIR, "settings.json")
      : path.resolve(process.cwd(), ".siclaw", "config", "settings.json");
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as { server?: { port?: number } };
    if (raw?.server?.port) {
      return { ...DEFAULT_CONFIG, port: raw.server.port };
    }
  } catch { /* fall through to default */ }
  return { ...DEFAULT_CONFIG };
}
