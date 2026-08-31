const MAX_LOG_MESSAGE_LENGTH = 512;

export function compactDispatchLogMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "Unknown error");
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length <= MAX_LOG_MESSAGE_LENGTH
    ? compact
    : `${compact.slice(0, MAX_LOG_MESSAGE_LENGTH)}…`;
}
