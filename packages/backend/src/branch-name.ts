/**
 * Deterministic branch name for a title: `task/<slug>`.
 */
export function slugifyBranchName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50)
    .replace(/-$/, "");

  return `task/${slug || "untitled"}`;
}
