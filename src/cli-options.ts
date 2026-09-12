/** Options for a single non-interactive diagnostic invocation. */
export interface CliOptions {
  prompt: string;
  agent?: string;
  continueSession: boolean;
  debug: boolean;
}

export function parseCliOptions(args: string[]): CliOptions {
  const result: CliOptions = { prompt: "", continueSession: false, debug: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error(`Duplicate option: ${arg}`);
    seen.add(arg);
    switch (arg) {
      case "--prompt":
      case "--agent": {
        const value = args[++i];
        if (!value?.trim() || value.startsWith("--")) {
          throw new Error(`${arg} requires a non-empty value.`);
        }
        if (arg === "--prompt") result.prompt = value;
        else result.agent = value;
        break;
      }
      case "--continue": result.continueSession = true; break;
      case "--debug": result.debug = true; break;
      case "--print": break; // Accepted for existing scripts; all CLI runs print.
      default: throw new Error(`Unknown command or option: ${arg}`);
    }
  }
  if (!result.prompt) {
    throw new Error("A diagnostic run requires --prompt <text>. Use 'siclaw local' for the Web UI.");
  }
  return result;
}
