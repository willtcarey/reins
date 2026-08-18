import type { ReviewItem } from "./review-items.js";

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
  isCollapsed(scope: ReviewCollapseScope, item: ReviewItem): boolean {
    const key = storageKey(scope, item.id);
    try {
      const reviewedHash = this.storage.getItem(key);
      const matches = reviewedHash === hashReviewContent(item.contentKey);
      if (reviewedHash && !matches) this.storage.removeItem(key);
      return matches;
    } catch {
      return false;
    }
  }

  /** Persist collapse as "this exact file diff has been reviewed." */
  setCollapsed(scope: ReviewCollapseScope, item: ReviewItem, collapsed: boolean): void {
    const key = storageKey(scope, item.id);
    try {
      if (collapsed) this.storage.setItem(key, hashReviewContent(item.contentKey));
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

/** Fast deterministic fingerprint; the diff content is not security-sensitive input. */
function hashReviewContent(content: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
    second = (second << 13) | (second >>> 19);
  }
  return `v1:${toHex(first)}${toHex(second)}:${content.length.toString(36)}`;
}

function toHex(value: number): string {
  return (value >>> 0).toString(16).padStart(8, "0");
}
