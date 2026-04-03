/**
 * Shared custom event factories.
 *
 * Centralizes event names and payloads so renaming or changing the
 * shape is a compile-time error at every call site.
 */

// Augment the global event maps so addEventListener/removeEventListener
// are fully typed for our custom events — no `as EventListener` casts needed.
declare global {
  interface DocumentEventMap {
    "open-in-browser": CustomEvent<OpenInBrowserDetail>;
    "open-quick-open": CustomEvent<void>;
    "open-file-search": CustomEvent<void>;
  }

  interface HTMLElementEventMap {
    "open-in-browser": CustomEvent<OpenInBrowserDetail>;
    "open-quick-open": CustomEvent<void>;
    "open-file-search": CustomEvent<void>;
  }
}

/** Detail payload for the open-in-browser event. */
export interface OpenInBrowserDetail {
  path: string;
  /** Optional 1-based start line to highlight and scroll to. */
  startLine?: number;
  /** Optional 1-based end line (inclusive) of the highlight range. */
  endLine?: number;
}

/** Request to open a file in the file browser overlay. */
export function openInBrowserEvent(path: string, lineRange?: { startLine: number; endLine: number }) {
  return new CustomEvent<OpenInBrowserDetail>("open-in-browser", {
    detail: { path, ...lineRange },
    bubbles: true,
    composed: true,
  });
}

/** Request to open the quick-open (session search) palette. */
export function openQuickOpenEvent() {
  return new CustomEvent("open-quick-open", {
    bubbles: true,
    composed: true,
  });
}

/** Request to open the file-search palette. */
export function openFileSearchEvent() {
  return new CustomEvent("open-file-search", {
    bubbles: true,
    composed: true,
  });
}
