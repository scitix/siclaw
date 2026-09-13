import path from "node:path";

/** Every restored root must be below the pod's writable user-data mount. */
export function privateWorkspaceRoots(cwd: string, userDataDir: string): Record<string, string> {
  const root = path.resolve(cwd, userDataDir);
  return {
    archive: path.join(root, "archive"),
    sessions: path.join(root, "agent", "sessions"),
    tasks: path.join(root, "agent", "tasks"),
    memory: path.join(root, "memory"),
    files: path.join(root, "files"),
    reports: path.join(root, "reports"),
    traces: path.join(root, "traces"),
  };
}
