/** Pure frontend path normalization and safety helpers. */

function directoryPrefix(projectDir: string | null): string | null {
  if (!projectDir) return null;
  return projectDir.endsWith("/") ? projectDir : `${projectDir}/`;
}

/** Convert an in-project absolute path to a project-relative path. */
export function toRelativePath(path: string, projectDir: string | null): string {
  if (!path) return path;
  const prefix = directoryPrefix(projectDir);
  if (prefix && path.startsWith(prefix)) return path.slice(prefix.length);
  if (prefix && `${path}/` === prefix) return "";
  return path;
}

/** Whether a path can be opened within the explicitly supplied project. */
export function isBrowsablePath(path: string, projectDir: string | null): boolean {
  if (!path) return false;
  const relativePath = toRelativePath(path, projectDir);
  if (relativePath.startsWith("/")) return false;
  if (/(^|[/\\])\.\.([/\\]|$)/.test(relativePath)) return false;
  return true;
}
