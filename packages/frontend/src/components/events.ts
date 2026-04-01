/**
 * Shared custom event factories.
 *
 * Centralizes event names and payloads so renaming or changing the
 * shape is a compile-time error at every call site.
 */

/** Request to open a file in the file browser overlay. */
export function openInBrowserEvent(path: string) {
  return new CustomEvent("open-in-browser", {
    detail: path,
    bubbles: true,
    composed: true,
  });
}
