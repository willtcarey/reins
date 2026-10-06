/** Pure frontend path normalization and safety helpers. */

function directoryPrefix(checkoutPath: string | null): string | null {
  if (!checkoutPath) return null;
  return checkoutPath.endsWith("/") ? checkoutPath : `${checkoutPath}/`;
}

/** Convert an in-project absolute path to a project-relative path. */
export function toRelativePath(path: string, checkoutPath: string | null): string {
  if (!path) return path;
  const prefix = directoryPrefix(checkoutPath);
  if (prefix && path.startsWith(prefix)) return path.slice(prefix.length);
  if (prefix && `${path}/` === prefix) return "";
  return path;
}

/** Whether a path can be opened within the explicitly supplied project. */
export function isBrowsablePath(path: string, checkoutPath: string | null): boolean {
  if (!path) return false;
  const relativePath = toRelativePath(path, checkoutPath);
  if (relativePath.startsWith("/")) return false;
  if (/(^|[/\\])\.\.([/\\]|$)/.test(relativePath)) return false;
  return true;
}
