export interface ChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface GatewayConfig {
  port: number;
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
  return { ...DEFAULT_CONFIG };
}
