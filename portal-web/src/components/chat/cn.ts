/** Minimal classnames utility — replaces @/lib/utils cn() from shadcn. */
export function cn(...classes: (string | false | undefined | null)[]): string {
  return classes.filter(Boolean).join(" ")
}
