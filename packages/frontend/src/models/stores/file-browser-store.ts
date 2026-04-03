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

export type DirEntry = { name: string; type: "file" | "directory" };

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

  // ---- Tree state -----------------------------------------------------------

  /** Cache of fetched directory contents, keyed by relative path */
  directoryEntries: Map<string, DirEntry[]> = new Map();
  /** Which directories are currently expanded in the tree */
  expandedDirs: Set<string> = new Set();
  /** Which directories are currently being fetched */
  treeLoading: Set<string> = new Set();
  /** Error message if a directory fetch fails */
  treeError: string | null = null;

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

  /** Fetch content for a specific file and expand the tree to show it. */
  async selectFile(path: string) {
    if (!this._projectId) return;
    this.selectedFile = path;
    this.fileContent = null;
    this.contentError = null;
    this.isBinary = false;
    this.contentLoading = true;
    this.notify();

    // Expand tree to show the file (fire-and-forget — don't block content loading)
    this.expandToPath(path);

    try {
      const res = await fetch(
        `/api/projects/${this._projectId}/files/content?path=${encodeURIComponent(path)}`,
      );
      if (!res.ok) {
        this.contentError = res.status === 404 ? "File not found" : `Error ${res.status}`;
        return;
      }

      const contentType = res.headers.get("content-type") || "";
      if (isTextMimeType(contentType)) {
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

  // ---- Tree operations -------------------------------------------------------

  /** Fetch one directory level from the server. Caches result. */
  async fetchDirectory(dirPath: string) {
    if (!this._projectId) return;
    if (this.directoryEntries.has(dirPath)) return;

    this.treeLoading.add(dirPath);
    this.treeError = null;
    this.notify();

    try {
      const res = await fetch(
        `/api/projects/${this._projectId}/files/tree?path=${encodeURIComponent(dirPath)}`,
      );
      if (res.ok) {
        const body = await res.json();
        this.directoryEntries.set(dirPath, body.entries);
      } else {
        this.treeError = "Failed to load directory";
      }
    } catch {
      this.treeError = "Failed to load directory";
    } finally {
      this.treeLoading.delete(dirPath);
      this.notify();
    }
  }

  /** Toggle a directory open/closed in the tree. */
  async toggleDirectory(dirPath: string) {
    if (this.expandedDirs.has(dirPath)) {
      this.expandedDirs.delete(dirPath);
      this.notify();
    } else {
      this.expandedDirs.add(dirPath);
      this.notify();
      await this.fetchDirectory(dirPath);
    }
  }

  /** Expand all ancestor directories so the given file is visible. */
  async expandToPath(filePath: string) {
    const parts = filePath.split("/");
    // Remove the filename — we only expand directories
    parts.pop();

    const ancestors: string[] = ["."];
    for (let i = 0; i < parts.length; i++) {
      ancestors.push(parts.slice(0, i + 1).join("/"));
    }

    for (const dir of ancestors) {
      this.expandedDirs.add(dir);
    }

    await Promise.all(ancestors.map((dir) => this.fetchDirectory(dir)));
    this.notify();
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

  /** Build a URL to fetch the raw content of the currently selected file. */
  get contentUrl(): string | null {
    if (!this._projectId || !this.selectedFile) return null;
    return `/api/projects/${this._projectId}/files/content?path=${encodeURIComponent(this.selectedFile)}`;
  }

  /** Reset store state (e.g. when closing the overlay). */
  reset() {
    this.selectedFile = null;
    this.fileContent = null;
    this.contentError = null;
    this.isBinary = false;
    this.contentLoading = false;
    this.directoryEntries = new Map();
    this.expandedDirs = new Set();
    this.treeLoading = new Set();
    this.treeError = null;
  }
}

/** MIME types that are textual despite not starting with `text/`. */
const TEXT_APPLICATION_TYPES = new Set([
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/toml",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-ruby",
  "application/x-python",
  "application/x-perl",
  "application/x-php",
  "application/x-awk",
  "application/x-lua",
  "application/x-makefile",
  "application/x-httpd-php",
]);

function isTextMimeType(mimeType: string): boolean {
  if (mimeType.startsWith("text/")) return true;
  return TEXT_APPLICATION_TYPES.has(mimeType);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
