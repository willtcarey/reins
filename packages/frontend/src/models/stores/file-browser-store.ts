/**
 * File Browser Store
 *
 * Manages file list fetching, fuzzy search, and file content loading
 * for the file browser overlay. The file list is fetched from the
 * backend (git ls-files + untracked non-ignored), and content is
 * fetched via the /api/projects/:id/files/content endpoint.
 */

import { fuzzyMatch } from "./quick-open-store.js";

export type FileBrowserStoreListener = () => void;

export class FileBrowserStore {
  // ---- Public reactive state ------------------------------------------------

  files: string[] = [];
  loading = false;
  contentLoading = false;
  selectedFile: string | null = null;
  fileContent: string | null = null;
  /** Error message if file content fetch fails */
  contentError: string | null = null;
  /** Whether the selected file is binary */
  isBinary = false;

  private _projectId: number | null = null;
  private _lastFetchProjectId: number | null = null;

  // ---- Subscription ---------------------------------------------------------

  private _listeners = new Set<FileBrowserStoreListener>();

  subscribe(fn: FileBrowserStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  // ---- Project ID -----------------------------------------------------------

  get projectId(): number | null {
    return this._projectId;
  }

  set projectId(id: number | null) {
    this._projectId = id;
  }

  // ---- Data fetching --------------------------------------------------------

  /** Fetch the file list from the server. Caches per project until refreshed. */
  async fetchFiles() {
    if (!this._projectId) return;
    // Skip if we already have files for this project
    if (this._lastFetchProjectId === this._projectId && this.files.length > 0) {
      return;
    }

    this.loading = true;
    this.notify();

    try {
      const res = await fetch(`/api/projects/${this._projectId}/files`);
      if (res.ok) {
        const body = await res.json();
        this.files = body.files;
        this._lastFetchProjectId = this._projectId;
      }
    } catch {
      // Keep cached files on error
    } finally {
      this.loading = false;
      this.notify();
    }
  }

  /** Force refresh the file list (e.g. after agent writes files). */
  async refreshFiles() {
    this._lastFetchProjectId = null;
    await this.fetchFiles();
  }

  /** Fetch content for a specific file. */
  async selectFile(path: string) {
    if (!this._projectId) return;
    this.selectedFile = path;
    this.fileContent = null;
    this.contentError = null;
    this.isBinary = false;
    this.contentLoading = true;
    this.notify();

    try {
      const res = await fetch(
        `/api/projects/${this._projectId}/files/content?path=${encodeURIComponent(path)}`,
      );
      if (!res.ok) {
        this.contentError = res.status === 404 ? "File not found" : `Error ${res.status}`;
        return;
      }

      const contentType = res.headers.get("content-type") || "";
      if (
        contentType.startsWith("text/") ||
        contentType.includes("json") ||
        contentType.includes("javascript") ||
        contentType.includes("xml") ||
        contentType.includes("yaml") ||
        contentType.includes("svg")
      ) {
        this.fileContent = await res.text();
      } else {
        this.isBinary = true;
        const blob = await res.blob();
        this.fileContent = `Binary file (${formatSize(blob.size)})`;
      }
    } catch {
      this.contentError = "Failed to load file";
    } finally {
      this.contentLoading = false;
      this.notify();
    }
  }

  // ---- Filtering ------------------------------------------------------------

  /** Filter files by fuzzy match. Returns at most `limit` results. */
  filter(query: string, limit = 50): string[] {
    if (!query.trim()) return this.files.slice(0, limit);

    const results: { file: string; score: number }[] = [];
    for (const file of this.files) {
      const score = fuzzyMatch(query, file);
      if (score !== null) {
        results.push({ file, score });
      }
    }
    results.sort((a, b) => a.score - b.score);
    return results.slice(0, limit).map((r) => r.file);
  }

  /** Reset store state (e.g. when closing the overlay). */
  reset() {
    this.selectedFile = null;
    this.fileContent = null;
    this.contentError = null;
    this.isBinary = false;
    this.contentLoading = false;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
