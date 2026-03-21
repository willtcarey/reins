/**
 * File Tree State
 *
 * Shared UI state for the diff file tree component. Holds presentation
 * concerns (collapsed directories) separately from server data (DiffStore).
 *
 * A single instance is created by the app shell and passed to all
 * <diff-file-tree> instances so they stay in sync across tabs.
 */

export type FileTreeStateListener = () => void;

export class FileTreeState {
  /** Set of collapsed directory paths. All expanded by default. */
  collapsedDirs = new Set<string>();

  private _listeners = new Set<FileTreeStateListener>();

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(fn: FileTreeStateListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  /** Toggle a directory's collapsed/expanded state. */
  toggleDir(path: string) {
    if (this.collapsedDirs.has(path)) {
      this.collapsedDirs.delete(path);
    } else {
      this.collapsedDirs.add(path);
    }
    this.collapsedDirs = new Set(this.collapsedDirs);
    this.notify();
  }

  /** Reset all directories to expanded. */
  reset() {
    this.collapsedDirs = new Set();
    this.notify();
  }
}
