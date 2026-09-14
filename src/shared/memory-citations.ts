/** Machine-readable attribution, kept out of presentation and never executed. */
export function memoryCitationPaths(text: string): string[] {
  const block = text.match(
    /(?:^|\n)<\s*memory-citations\s*>([\s\S]*?)<\s*\/\s*memory-citations\s*>\s*$/,
  );
  if (!block || block[1].length > 4096) return [];
  try {
    const paths: unknown = JSON.parse(block[1]);
    if (
      !Array.isArray(paths) ||
      paths.length > 16 ||
      paths.some(
        (p) => typeof p !== "string" || !/^memory\/[a-f0-9]{64}\.md$/.test(p),
      )
    )
      return [];
    return [...new Set(paths)];
  } catch {
    return [];
  }
}

/** Also hides an unfinished trailing block while streaming. Source text remains
 * intact for attribution and session recovery. Only a standalone line is special. */
export function stripMemoryCitations(text: string): string {
  return text
    .replace(/(?:^|\n)<\s*memory-citations\s*>[\s\S]*$/, "\n\n")
    .replace(/(?:^|\n)<\s*memory-citat(?:i(?:o(?:n(?:s(?:>)?)?)?)?)?$/, "\n\n");
}
