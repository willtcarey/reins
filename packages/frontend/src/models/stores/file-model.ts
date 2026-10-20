/**
 * The workspace's project files, read from the viewed session's source: the file listing, file
 * contents and the file browser's directory tree. It outlives views, the file browser and session
 * changes within the source; another project or source starts it over.
 */

import type { DirectoryEntry } from "@backend/models/sources.js";
import { ReinsHttpError } from "@reins/client";
import { api } from "../api.js";
import { FileReferenceIndex } from "../file-references.js";
import { fuzzyMatch } from "./quick-open-store.js";

/** Where files are read: the viewed session's project and checkout. */
export interface FileSource {
  projectId: number;
  nodeId: string;
  checkoutPath: string;
  /** Whether the source's node is connected. */
  available: boolean;
}

export interface FileContent {
  loading: boolean;
  /** The file's text, or for a binary file a description of it. */
  text: string | null;
  isBinary: boolean;
  error: string | null;
}

export type FileModelListener = () => void;

function sameCheckout(a: FileSource | null, b: FileSource): boolean {
  return a != null && a.projectId === b.projectId && a.nodeId === b.nodeId && a.checkoutPath === b.checkoutPath;
}

export class FileModel {
  files: readonly string[] = [];
  filesLoading = false;

  directoryEntries = new Map<string, DirectoryEntry[]>();
  expandedDirs = new Set<string>();
  treeLoading = new Set<string>();
  treeError: string | null = null;

  private _source: FileSource | null = null;
  // Responses for an earlier source are dropped by comparing generations.
  private _generation = 0;
  private _filesLoaded = false;
  private _filesRequest: Promise<void> | null = null;
  private _references: FileReferenceIndex | null = null;
  private _contents = new Map<string, FileContent>();
  private _contentRequests = new Map<string, number>();
  private _nextContentRequest = 0;
  private _listeners = new Set<FileModelListener>();

  subscribe(listener: FileModelListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  get source(): FileSource | null { return this._source; }
  get projectId(): number | null { return this._source?.projectId ?? null; }

  setSource(source: FileSource): void {
    const previous = this._source;
    this._source = source;
    if (!sameCheckout(previous, source)) {
      this._generation += 1;
      this.files = [];
      this.filesLoading = false;
      this._filesLoaded = false;
      this._references = null;
      this._filesRequest = null;
      this._contents = new Map();
      this._contentRequests = new Map();
      this.directoryEntries = new Map();
      this.expandedDirs = new Set();
      this.treeLoading = new Set();
      this.treeError = null;
    } else if (previous?.available === source.available) {
      return;
    }
    this.notify();
    void this.loadFiles();
  }

  /**
   * File references in messages resolve against the listing, so there are none until it loads
   * or while the source's node is offline. A new listing makes a new index.
   */
  get references(): FileReferenceIndex | null {
    const source = this._source;
    if (!source?.available || !this._filesLoaded) return null;
    this._references ??= new FileReferenceIndex(this.files, source.checkoutPath);
    return this._references;
  }

  /** Loads the listing once for the source; the file search and references read it. */
  loadFiles(): Promise<void> {
    if (this._filesLoaded || !this._source?.available) return Promise.resolve();
    this._filesRequest ??= this.fetchFiles().finally(() => { this._filesRequest = null; });
    return this._filesRequest;
  }

  /** Reloads what may have changed in the checkout: the listing, listed directories and loaded files. */
  async refresh(): Promise<void> {
    if (!this._source) return;
    const generation = this._generation;
    const directories = [...this.directoryEntries.keys()];
    const loaded = [...this._contents.keys()];
    await Promise.all([
      this._source.available ? this.fetchFiles() : undefined,
      ...directories.map((path) => this.listDirectory(path, generation)),
      ...loaded.map((path) => this.loadFile(path, { refresh: true })),
    ]);
  }

  /** Paths ranked by fuzzy match, a basename match well ahead of a match across the path. */
  filter(query: string, limit = 50): string[] {
    if (!query.trim()) return this.files.slice(0, limit);

    const results: { file: string; score: number }[] = [];
    for (const file of this.files) {
      const pathScore = fuzzyMatch(query, file);
      if (pathScore === null) continue;
      const basename = file.slice(file.lastIndexOf("/") + 1);
      const baseScore = fuzzyMatch(query, basename);
      // Lower is better; the leftover basename length lets tighter basenames win ties.
      const score = baseScore !== null ? baseScore - 1000 + (basename.length - query.length) : pathScore;
      results.push({ file, score });
    }
    results.sort((a, b) => a.score - b.score);
    return results.slice(0, limit).map((result) => result.file);
  }

  file(path: string): FileContent | undefined {
    return this._contents.get(path);
  }

  /**
   * Loads a file's content once. With `refresh`, a loaded file is read again while its current
   * content stays shown.
   */
  async loadFile(path: string, { refresh = false } = {}): Promise<void> {
    const source = this._source;
    if (!source) return;
    const current = this._contents.get(path);
    if (current && (current.loading || !refresh)) return;

    const generation = this._generation;
    const request = ++this._nextContentRequest;
    this._contentRequests.set(path, request);
    if (!current || current.error) {
      this._contents.set(path, { loading: true, text: null, isBinary: false, error: null });
      this.notify();
    }

    let content: FileContent;
    try {
      const response = await api.files.content(source.projectId, path);
      const contentType = response.headers.get("content-type") || "";
      content = isTextMimeType(contentType)
        ? { loading: false, text: await response.text(), isBinary: false, error: null }
        : { loading: false, text: `Binary file (${formatSize((await response.blob()).size)})`, isBinary: true, error: null };
    } catch (error) {
      const message = error instanceof ReinsHttpError && error.status === 404 ? "File not found" : "Failed to load file";
      content = { loading: false, text: null, isBinary: false, error: message };
    }
    if (generation !== this._generation || this._contentRequests.get(path) !== request) return;
    this._contents.set(path, content);
    this.notify();
  }

  contentUrl(path: string): string | null {
    const projectId = this.projectId;
    return projectId == null ? null : api.files.contentUrl(projectId, path);
  }

  /** Lists one directory level for the tree, once. */
  async fetchDirectory(path: string): Promise<void> {
    if (!this._source || this.directoryEntries.has(path) || this.treeLoading.has(path)) return;
    await this.listDirectory(path, this._generation);
  }

  async toggleDirectory(path: string): Promise<void> {
    if (this.expandedDirs.has(path)) {
      this.expandedDirs.delete(path);
      this.notify();
      return;
    }
    this.expandedDirs.add(path);
    this.notify();
    await this.fetchDirectory(path);
  }

  /** Expands every directory above a file so the tree shows it. */
  async expandToPath(filePath: string): Promise<void> {
    const parts = filePath.split("/").slice(0, -1);
    const ancestors = [".", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
    for (const directory of ancestors) this.expandedDirs.add(directory);
    this.notify();
    await Promise.all(ancestors.map((directory) => this.fetchDirectory(directory)));
  }

  private async fetchFiles(): Promise<void> {
    const source = this._source;
    if (!source) return;
    const generation = this._generation;
    this.filesLoading = true;
    this.notify();
    try {
      const body = await api.files.list(source.projectId);
      if (generation !== this._generation) return;
      this.files = body.files;
      this._filesLoaded = true;
      this._references = null;
    } catch {
      // A failed refresh keeps the listing it had.
    } finally {
      if (generation === this._generation) {
        this.filesLoading = false;
        this.notify();
      }
    }
  }

  private async listDirectory(path: string, generation: number): Promise<void> {
    const source = this._source;
    if (!source) return;
    this.treeLoading.add(path);
    this.treeError = null;
    this.notify();
    try {
      const body = await api.files.tree(source.projectId, path);
      if (generation !== this._generation) return;
      this.directoryEntries.set(path, body.entries);
    } catch {
      if (generation !== this._generation) return;
      this.treeError = "Failed to load directory";
    } finally {
      if (generation === this._generation) {
        this.treeLoading.delete(path);
        this.notify();
      }
    }
  }

  private notify(): void {
    for (const listener of this._listeners) listener();
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
  return mimeType.startsWith("text/") || TEXT_APPLICATION_TYPES.has(mimeType);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
