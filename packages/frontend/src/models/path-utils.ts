/**
 * Frontend path utilities.
 */

// ---- Project directory (set once when the active project changes) ----------

let _projectDir: string | null = null;

/**
 * Set the project's absolute directory so that `isBrowsablePath` and
 * `toRelativePath` can recognise absolute paths inside the project.
 * Call this whenever the active project changes.
 */
export function setProjectDir(dir: string | null): void {
  // Ensure it ends with "/" for easy prefix matching
  _projectDir = dir && !dir.endsWith("/") ? dir + "/" : dir;
}

/** Return the current project directory (with trailing slash), or null. */
export function getProjectDir(): string | null {
  return _projectDir;
}

// ---- Path helpers -----------------------------------------------------------

/**
 * Convert a path to a project-relative path if it's an absolute path
 * inside the project directory.  Returns the original path unchanged
 * if it's already relative or outside the project.
 */
export function toRelativePath(path: string): string {
  if (!path) return path;
  if (_projectDir && path.startsWith(_projectDir)) {
    return path.slice(_projectDir.length);
  }
  // Handle exact match without trailing slash (e.g. "/home/user/project")
  if (_projectDir && path + "/" === _projectDir) {
    return "";
  }
  return path;
}

/**
 * Whether a path looks safe to open in the file browser.
 *
 * Accepts relative paths that don't escape via `..`, and also absolute
 * paths that fall inside the current project directory (after stripping
 * the prefix).  The backend has its own validation, but we avoid even
 * sending the request for obviously-bad paths.
 */
export function isBrowsablePath(path: string): boolean {
  if (!path) return false;
  // Normalise absolute project paths first
  const rel = toRelativePath(path);
  if (rel.startsWith("/")) return false;
  // Reject ".." at start, end, or between separators
  if (/(^|[/\\])\.\.([/\\]|$)/.test(rel)) return false;
  return true;
}
