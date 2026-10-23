import { sameSource, type DirectoryEntry, type FileListing, type FileViewMode, type ReinsSdk, type Source } from "reins-sdk/contract";
import { FileLoader } from "../file-loader.js";
import { fuzzyMatch } from "./quick-open-store.js";

export interface FileBrowserOpenOptions {
  path?: string;
  startLine?: number;
  endLine?: number;
  mode?: FileViewMode;
}

export interface LineRange {
  startLine: number;
  endLine: number;
}

/**
 * The file browser and its file search, a built-in feature, for one source at a time: the directory
 * tree, the open file and the search's query. Closing it keeps them; opening it for another source
 * starts over.
 */
export class FileBrowserStore {
  readonly file: FileLoader;
  source: Source | null = null;
  browserOpen = false;
  searchOpen = false;
  query = "";
  /** The lines the open file was asked to show; a new object for every open, which reveals them again. */
  lines: LineRange | null = null;
  mode: FileViewMode = "code";

  directoryEntries = new Map<string, DirectoryEntry[]>();
  expandedDirs = new Set<string>();
  treeLoading = new Set<string>();
  treeError: string | null = null;

  // Responses for an earlier source are dropped by comparing generations.
  private generation = 0;
  private filtered: { files: readonly string[] | null; query: string; results: string[] } | null = null;
  private listeners = new Set<() => void>();
  private unsubscribers: Array<() => void>;

  constructor(private readonly reins: Pick<ReinsSdk, "files" | "workspace">) {
    this.file = new FileLoader(reins.files);
    this.unsubscribers = [
      this.file.subscribe(() => this.notify()),
      reins.files.subscribe(() => this.notify()),
      reins.files.onFilesChanged((source) => {
        if (!sameSource(this.source, source)) return;
        for (const path of this.directoryEntries.keys()) void this.listDirectory(path);
      }),
    ];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get path(): string | null { return this.file.path; }

  get listing(): FileListing { return this.reins.files.listing(this.source); }

  /** Listed paths ranked by fuzzy match with the query, a basename match well ahead of a match across the path. */
  get results(): string[] {
    const files = this.listing.data;
    if (this.filtered?.files !== files || this.filtered.query !== this.query) {
      this.filtered = { files, query: this.query, results: filterFiles(files ?? [], this.query) };
    }
    return this.filtered.results;
  }

  contentUrl(path: string, options?: { download?: boolean }): string | null {
    return this.source ? this.reins.files.contentUrl(this.source, path, options) : null;
  }

  /** Shows the browser; with a path, reads that file again and opens the tree to it. */
  open(source: Source, { path, startLine, endLine, mode }: FileBrowserOpenOptions = {}): void {
    this.useSource(source);
    this.browserOpen = true;
    void this.fetchDirectory(".");
    if (path) {
      this.lines = startLine != null && endLine != null ? { startLine, endLine } : null;
      this.mode = mode ?? "code";
      this.file.show(source, path, { reload: true });
      void this.expandToPath(path);
    } else {
      this.lines = null;
    }
    this.notify();
  }

  /** Shows a file chosen in the browser's tree or search, closing the search. */
  select(path: string): void {
    const source = this.source;
    if (!source) return;
    this.searchOpen = false;
    this.open(source, { path });
  }

  close(): void {
    this.browserOpen = false;
    this.notify();
  }

  /** Opens the shown file in the Inspector with its lines and Code/Preview choice, and closes the browser. */
  openInInspector(): void {
    const { source, path, lines, mode } = this;
    if (!source || !path) return;
    this.reins.workspace.open({ view: "file", source, path, ...lines, ...(mode === "preview" ? { mode } : {}) }, { in: "inspector" });
    this.close();
  }

  /** Opens a file found by the search in the Inspector, and closes the search. */
  openFoundInInspector(path: string): void {
    const source = this.source;
    if (!source) return;
    this.closeSearch();
    this.reins.workspace.open({ view: "file", source, path }, { in: "inspector" });
  }

  openSearch(source: Source): void {
    this.useSource(source);
    this.searchOpen = true;
    this.query = "";
    this.notify();
  }

  closeSearch(): void {
    this.searchOpen = false;
    this.notify();
  }

  setQuery(query: string): void {
    this.query = query;
    this.notify();
  }

  setMode(mode: FileViewMode): void {
    this.mode = mode;
    this.notify();
  }

  /** Lists one directory level for the tree, once. */
  async fetchDirectory(path: string): Promise<void> {
    if (!this.source || this.directoryEntries.has(path) || this.treeLoading.has(path)) return;
    await this.listDirectory(path);
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

  dispose(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.file.dispose();
    this.listeners.clear();
  }

  private useSource(source: Source): void {
    const previous = this.source;
    this.source = source;
    if (sameSource(previous, source)) return;
    this.generation += 1;
    this.file.clear();
    this.lines = null;
    this.mode = "code";
    this.query = "";
    this.directoryEntries = new Map();
    this.expandedDirs = new Set();
    this.treeLoading = new Set();
    this.treeError = null;
  }

  /** Expands every directory above a file so the tree shows it. */
  private async expandToPath(filePath: string): Promise<void> {
    const parts = filePath.split("/").slice(0, -1);
    const ancestors = [".", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
    for (const directory of ancestors) this.expandedDirs.add(directory);
    this.notify();
    await Promise.all(ancestors.map((directory) => this.fetchDirectory(directory)));
  }

  private async listDirectory(path: string): Promise<void> {
    const source = this.source;
    if (!source) return;
    const generation = this.generation;
    this.treeLoading.add(path);
    this.treeError = null;
    this.notify();
    try {
      const entries = await this.reins.files.listDirectory(source, path);
      if (generation !== this.generation) return;
      this.directoryEntries.set(path, entries);
    } catch {
      if (generation !== this.generation) return;
      this.treeError = "Failed to load directory";
    } finally {
      if (generation === this.generation) {
        this.treeLoading.delete(path);
        this.notify();
      }
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

function filterFiles(files: readonly string[], query: string, limit = 50): string[] {
  if (!query.trim()) return files.slice(0, limit);

  const results: { file: string; score: number }[] = [];
  for (const file of files) {
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
