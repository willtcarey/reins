/**
 * Frontend path utilities.
 */

/**
 * Whether a path looks safe to open in the file browser.
 *
 * Rejects absolute paths and `..` components that could escape the
 * project directory.  The backend has its own validation, but we
 * avoid even sending the request for obviously-bad paths.
 */
export function isBrowsablePath(path: string): boolean {
  if (!path) return false;
  if (path.startsWith("/")) return false;
  // Reject ".." at start, end, or between separators
  if (/(^|[/\\])\.\.([/\\]|$)/.test(path)) return false;
  return true;
}
