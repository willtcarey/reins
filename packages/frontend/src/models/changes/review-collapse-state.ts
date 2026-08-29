import type { FileChange } from "./file-changes.js";

const STORAGE_KEY_PREFIX = "reins:reviewed-diff:";

export interface ReviewCollapseScope {
  readonly projectId: number;
  readonly branch: string | null;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class ReviewCollapseState {
  constructor(private readonly storage: KeyValueStorage = globalThis.localStorage) {}

  /** Read reviewed state and invalidate stale content so a later revert stays expanded. */
  isCollapsed(scope: ReviewCollapseScope, change: FileChange): boolean {
    const key = storageKey(scope, change.id);
    try {
      const reviewedHash = this.storage.getItem(key);
      const matches = reviewedHash === change.contentKey;
      if (reviewedHash && !matches) this.storage.removeItem(key);
      return matches;
    } catch {
      return false;
    }
  }

  /** Persist collapse as "this exact file diff has been reviewed." */
  setCollapsed(scope: ReviewCollapseScope, change: FileChange, collapsed: boolean): void {
    const key = storageKey(scope, change.id);
    try {
      if (collapsed) this.storage.setItem(key, change.contentKey);
      else this.storage.removeItem(key);
    } catch { /* localStorage may be disabled or full */ }
  }
}

/** A file has one storage key; collapsing overwrites its last reviewed content hash. */
function storageKey(scope: ReviewCollapseScope, itemId: string): string {
  return `${STORAGE_KEY_PREFIX}${JSON.stringify([
    scope.projectId,
    scope.branch,
    itemId,
  ])}`;
}
