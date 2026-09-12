import fs from "node:fs";
import path from "node:path";
import { resolveGroupGid } from "./credential-broker.js";
import { kubeConnection } from "../tools/infra/inline-kubeconfig.js";

/** Runtime-authorized material stays in AgentBox, never in the code runner.
 * A per-call snapshot prevents a cached/rebound cluster name or another turn's
 * credential refresh from changing which resource the approved command reads.
 */
export async function withSandboxKubeconfig<T>(credentialsDir: string | undefined, content: string,
  execute: (file: string) => Promise<T>): Promise<T> {
  if (!credentialsDir) throw new Error("Credential directory required");
  kubeConnection(content);
  const gid = resolveGroupGid("kubecred");
  if (process.env.NODE_ENV === "production" && gid === null) throw new Error("Credential reader group required");
  const dir = fs.mkdtempSync(path.join(credentialsDir, "sandbox-call-"));
  try {
    if (gid !== null) fs.chownSync(dir, -1, gid);
    fs.chmodSync(dir, gid === null ? 0o700 : 0o750);
    const file = path.join(dir, "approved.kubeconfig");
    fs.writeFileSync(file, content, { mode: 0o600, flag: "wx" });
    if (gid !== null) {
      fs.chownSync(file, -1, gid);
      fs.chmodSync(file, 0o640);
    }
    return await execute(file);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
