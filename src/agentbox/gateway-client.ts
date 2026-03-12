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
  workspaceId?: string | null;
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
  async listCronJobs(userId: string, workspaceId?: string): Promise<CronJob[]> {
    let url = `/api/internal/cron-list?userId=${encodeURIComponent(userId)}`;
    if (workspaceId) {
      url += `&workspaceId=${encodeURIComponent(workspaceId)}`;
    }
    const data = await this.request(url, "GET");
    return data.jobs || [];
  }

  /**
   * Return a GatewayClientLike adapter for use with resource handlers.
   * Keeps `request()` private while exposing a minimal interface.
   */
  toClientLike(): import("../shared/resource-sync.js").GatewayClientLike {
    return {
      request: (p: string, m: "GET" | "POST", b?: unknown) => this.request(p, m, b),
    };
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
