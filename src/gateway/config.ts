/**
 * Siclaw Agent Runtime configuration.
 */

export interface RuntimeConfig {
  /** HTTP port for WS RPC + health/metrics (default: 3001) */
  port: number;
  /** HTTPS port for internal mTLS API (AgentBox ↔ Runtime) (default: 3002) */
  internalPort: number;
  /** Bind host */
  host: string;
  /** Runtime's own secret — Portal/Upstream must present this to connect via WS */
  runtimeSecret: string;
  /** Management server URL (Portal or Upstream) — provides Agent info, credentials, permissions */
  serverUrl: string;
  /** Portal/Upstream's secret — Runtime presents this when calling the management server */
  portalSecret: string;
  /** MySQL connection string */
  databaseUrl: string;
  /** Shared JWT secret for token verification */
  jwtSecret: string;
  /**
   * Optional URL of an external credential provider. When set, all credential
   * list/get requests are forwarded there and the local clusters DB is bypassed.
   * When empty, credentials come from the local clusters + agent_clusters tables.
   */
  externalCredentialUrl: string;
  /** Bearer token sent as X-Auth-Token to the external credential provider. */
  externalCredentialToken: string;
}

export function loadRuntimeConfig(): RuntimeConfig {
  return {
    port: parseInt(process.env.SICLAW_PORT || "3001", 10),
    internalPort: parseInt(process.env.SICLAW_INTERNAL_PORT || "3002", 10),
    host: process.env.SICLAW_HOST || "0.0.0.0",
    runtimeSecret: process.env.SICLAW_RUNTIME_SECRET || "",
    serverUrl: process.env.SICLAW_SERVER_URL || "",
    portalSecret: process.env.SICLAW_PORTAL_SECRET || "",
    databaseUrl: process.env.DATABASE_URL || "",
    jwtSecret: process.env.JWT_SECRET || "",
    externalCredentialUrl: process.env.EXTERNAL_CREDENTIAL_URL || "",
    externalCredentialToken: process.env.EXTERNAL_CREDENTIAL_TOKEN || "",
  };
}
