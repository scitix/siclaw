/** Public, model-authored intent carried alongside tool arguments, never reasoning. */
export const TOOL_PROGRESS_FIELD = "_siclaw_progress";

export function splitToolProgress(args: Record<string, unknown>): {
  args: Record<string, unknown>; text: string;
} {
  const { [TOOL_PROGRESS_FIELD]: progress, ...domainArgs } = args;
  return { args: domainArgs, text: typeof progress === "string" ? progress.trim() : "" };
}
