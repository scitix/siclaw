/**
 * Reverse proxy — forwards Siclaw domain API requests to the Runtime.
 *
 * Preserves path, method, headers (including Authorization), and streams
 * the response body back to the original client.
 */

import http from "node:http";

export function createRuntimeProxy(
  runtimeUrl: string,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const target = new URL(runtimeUrl);

  return (req, res) => {
    const options: http.RequestOptions = {
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (err) => {
      console.error("[proxy] Runtime proxy error:", err.message);
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Runtime unavailable" }));
      }
    });

    // Forward request body
    req.pipe(proxyReq, { end: true });
  };
}
