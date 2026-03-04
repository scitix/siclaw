/**
 * Gateway Client for AgentBox
 *
 * HTTP client that uses mTLS client certificates to call Gateway's internal APIs.
 * Used by AgentBox to query metadata (settings, cron jobs, etc.)
 */

import https from "node:https";
import fs from "node:fs";
import path from "node:path";

export interface GatewayClientOptions {
  gatewayUrl: string;
  certPath?: string; // Directory containing tls.crt, tls.key, ca.crt
}

export interface CronJob {
  id: string;
  name: string;
  schedule: string;
  status: string;
  description?: string | null;
  lastRunAt?: string | null;
  lastResult?: string | null;
}

export interface SkillBundleEntry {
  dirName: string;
  scope: "builtin" | "team" | "personal";
  specs: string;
  scripts: Array<{ name: string; content: string }>;
}

export interface SkillBundle {
  version: string;
  skills: SkillBundleEntry[];
  disabledBuiltins?: string[];
}

export class GatewayClient {
  private gatewayUrl: string;
  private tlsOptions: https.RequestOptions | null = null;

  constructor(options: GatewayClientOptions) {
    this.gatewayUrl = options.gatewayUrl.replace(/\/$/, ""); // Remove trailing slash

    // Load client certificates if certPath provided
    const certPath = options.certPath || process.env.SICLAW_CERT_PATH || "/etc/siclaw/certs";

    const certFile = path.join(certPath, "tls.crt");
    const keyFile = path.join(certPath, "tls.key");
    const caFile = path.join(certPath, "ca.crt");

    // Check if certificate files exist
    if (fs.existsSync(certFile) && fs.existsSync(keyFile) && fs.existsSync(caFile)) {
      this.tlsOptions = {
        cert: fs.readFileSync(certFile),
        key: fs.readFileSync(keyFile),
        ca: fs.readFileSync(caFile),
        rejectUnauthorized: true, // Verify Gateway's certificate
      };
      console.log(`[gateway-client] Loaded client certificates from ${certPath}`);
    } else {
      console.warn(`[gateway-client] Client certificates not found at ${certPath}, will use plain HTTP`);
    }
  }

  /**
   * Fetch settings (providers, models, embedding config) from Gateway
   */
  async fetchSettings(): Promise<any> {
    return this.request("/api/internal/settings", "GET");
  }

  /**
   * List cron jobs for a user
   */
  async listCronJobs(userId: string): Promise<CronJob[]> {
    const data = await this.request(`/api/internal/cron-list?userId=${encodeURIComponent(userId)}`, "GET");
    return data.jobs || [];
  }

  /**
   * Fetch the skill bundle from Gateway via mTLS.
   * Identity (userId, env) is derived from the client certificate — no params needed.
   */
  async fetchSkillBundle(): Promise<SkillBundle> {
    return this.request("/api/internal/skills/bundle", "GET");
  }

  /**
   * Make HTTP(S) request to Gateway with mTLS authentication
   */
  private request(path: string, method: "GET" | "POST" = "GET", body?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.gatewayUrl);
      const isHttps = url.protocol === "https:";

      const requestOptions: https.RequestOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers: {
          "Content-Type": "application/json",
        },
        ...(isHttps && this.tlsOptions ? this.tlsOptions : {}),
      };

      const client = isHttps ? https : require("http");
      const req = client.request(requestOptions, (res: any) => {
        let data = "";

        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });

        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              resolve(json);
            } catch (err) {
              reject(new Error(`Failed to parse JSON response: ${data}`));
            }
          } else {
            reject(new Error(`Gateway returned ${res.statusCode}: ${data}`));
          }
        });
      });

      req.on("error", (err: Error) => {
        reject(new Error(`Gateway request failed: ${err.message}`));
      });

      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("Gateway request timeout"));
      });

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }
}
