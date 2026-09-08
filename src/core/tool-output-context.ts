import { AsyncLocalStorage } from "node:async_hooks";

// One invocation scope, including detached continuations. Never a process-global "current session".
export interface ToolOutputContext {
  directory: string;
  outputs: Array<{ preview: string; full: string }>;
}
const context = new AsyncLocalStorage<ToolOutputContext>();
export function currentToolOutputContext(): ToolOutputContext | undefined { return context.getStore(); }
export function withToolOutputContext<T>(scope: ToolOutputContext, run: () => T): T { return context.run(scope, run); }
export function retainSanitizedToolOutput(preview: string, full: string): boolean {
  const scope = context.getStore();
  if (!scope) return false;
  scope.outputs.push({ preview, full });
  return true;
}
