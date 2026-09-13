import type https from "node:https";
import yaml from "js-yaml";
import { record } from "../../script-sandbox/validation.js";

function only(args: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(args).some(k => !fields.includes(k))) throw new Error("Unsupported Kubernetes authentication");
}

/** Build authentication from inline data only. Never execute or materialize kubeconfig. */
export function kubeConnection(content: string): { url: URL; options: https.RequestOptions } {
  const doc = yaml.load(content, { schema: yaml.JSON_SCHEMA }) as any;
  if (!doc || !Array.isArray(doc.contexts) || !Array.isArray(doc.clusters) || !Array.isArray(doc.users)) throw new Error("Invalid kubeconfig");
  const context = doc.contexts.find((c: any) => c.name === doc["current-context"])?.context;
  const cluster = doc.clusters.find((c: any) => c.name === context?.cluster)?.cluster;
  const user = doc.users.find((u: any) => u.name === context?.user)?.user;
  if (!record(cluster) || !record(user)) throw new Error("Missing kubeconfig context");
  only(cluster, ["server", "certificate-authority-data", "insecure-skip-tls-verify", "disable-compression"]);
  only(user, ["token", "client-certificate-data", "client-key-data"]);
  if (cluster["insecure-skip-tls-verify"]) throw new Error("TLS verification is required");
  const url = new URL(String(cluster.server));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Invalid Kubernetes endpoint");
  if (!user.token && !(user["client-certificate-data"] && user["client-key-data"])) throw new Error("Inline Kubernetes authentication required");
  const pem = (value: unknown) => value === undefined ? undefined : Buffer.from(String(value), "base64");
  return { url, options: { ca: pem(cluster["certificate-authority-data"]), cert: pem(user["client-certificate-data"]), key: pem(user["client-key-data"]),
    headers: user.token ? { Authorization: `Bearer ${String(user.token)}` } : {}, rejectUnauthorized: true } };
}
