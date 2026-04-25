/**
 * Siclaw Agent Runtime configuration.
 */

export interface RuntimeConfig {
  /** HTTP port for health/metrics (default: 3001) */
  port: number;
  /** HTTPS port for internal mTLS API (AgentBox ↔ Runtime) (default: 3002) */
  internalPort: number;
  /** Bind host */
  host: string;
  /** Management server URL (Portal or SiCore) — provides Agent info, credentials, permissions */
  serverUrl: string;
  /** Portal/SiCore's secret — Runtime presents this when phone-homing to the management server */
  portalSecret: string;
}

export function loadRuntimeConfig(): RuntimeConfig {
  return {
    port: parseInt(process.env.SICLAW_PORT || "3001", 10),
    internalPort: parseInt(process.env.SICLAW_INTERNAL_PORT || "3002", 10),
    host: process.env.SICLAW_HOST || "0.0.0.0",
    serverUrl: process.env.SICLAW_SERVER_URL || "",
    portalSecret: process.env.SICLAW_PORTAL_SECRET || "",
  };
}
