import fs from "node:fs";
import path from "node:path";

function sanitizeAgentId(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 63);
}

function countFiles(dir: string): number {
  let count = 0;
  if (!fs.existsSync(dir)) return count;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countFiles(fullPath);
    } else if (entry.isFile()) {
      count++;
    }
  }

  return count;
}

export function clearAgentMemory(agentId: string, userDataBase = "/app/.siclaw/user-data"): { memoryDir: string; deletedFiles: number } {
  const base = path.resolve(userDataBase);
  const memoryDir = path.resolve(base, "agents", sanitizeAgentId(agentId), "memory");

  if (!memoryDir.startsWith(base + path.sep)) {
    throw new Error(`Refusing to clear memory outside user data base: ${memoryDir}`);
  }

  const deletedFiles = countFiles(memoryDir);
  fs.rmSync(memoryDir, { recursive: true, force: true });
  return { memoryDir, deletedFiles };
}
