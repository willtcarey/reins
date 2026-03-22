/**
 * Pure logic helpers for generic tool blocks (tested without DOM).
 */

/**
 * Return a short contextual summary for a tool call based on its args.
 *
 * Shows the first non-empty string arg value, truncated to 120 chars.
 */
export function getToolSummary(_name: string, args: Record<string, any> | undefined): string {
  if (!args) return "";
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.length > 0) {
      return v.length > 120 ? v.slice(0, 117) + "…" : v;
    }
  }
  return "";
}
