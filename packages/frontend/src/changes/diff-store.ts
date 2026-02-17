/**
 * Diff Store
 *
 * Centralized data store for git diff state. Polls the lightweight
 * /diff/files endpoint for file listings, and fetches the full
 * syntax-highlighted diff on demand when the user views changes.
 *
 * A single instance is created by the app shell and shared across the
 * diff-panel and diff-file-tree components, eliminating duplicate fetches.
 */

import type { DiffFile, DiffFileSummary } from "./types.js";
import { sortDiffFiles, sortFileSummaries } from "./diff-sort.js";
import { Highlighter } from "./highlighter.js";

const DEFAULT_CONTEXT = 3;
const POLL_INTERVAL = 5000;

export interface DiffFileData {
  files: DiffFileSummary[];
  branch: string | null;
  baseBranch: string | null;
}

export interface DiffFullData {
  files: DiffFile[];
  branch: string | null;
  baseBranch: string | null;
}

export type DiffStoreListener = () => void;

export class DiffStore {
  // ---- Public reactive state ------------------------------------------------

  /** Lightweight file listing — always up to date via polling. */
  fileData: DiffFileData = { files: [], branch: null, baseBranch: null };

  /** Full highlighted diff — fetched on demand, may be stale or null. */
  fullData: DiffFullData | null = null;

  /** Whether the full diff is currently being fetched. */
  fullLoading = false;

  error: string | null = null;
  loading = false;
  contextLines = DEFAULT_CONTEXT;

  // ---- Private state --------------------------------------------------------

  private _projectId: number | null = null;
  private _listeners = new Set<DiffStoreListener>();
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _highlighter = new Highlighter();

  // ---- Accessors ------------------------------------------------------------

  get projectId(): number | null {
    return this._projectId;
  }

  get defaultContext(): number {
    return DEFAULT_CONTEXT;
  }

  /**
   * Convenience accessor used by components that only need file summaries.
   * Returns the file listing data (always available from polling).
   */
  get data(): DiffFileData {
    return this.fileData;
  }

  // ---- Subscription ---------------------------------------------------------

  /** Subscribe to state changes. Returns an unsubscribe function. */
  subscribe(fn: DiffStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  // ---- Project management ---------------------------------------------------

  /** Set the active project. Resets state and restarts polling. */
  setProject(id: number | null) {
    if (id === this._projectId) return;
    this._projectId = id;
    this.fileData = { files: [], branch: null, baseBranch: null };
    this.fullData = null;
    this.error = null;
    this.contextLines = DEFAULT_CONTEXT;
    this.notify();
    this._restartPolling();
  }

  // ---- Context lines --------------------------------------------------------

  /** Change the number of context lines and re-fetch full diff. */
  async setContextLines(n: number) {
    if (n === this.contextLines) return;
    this.contextLines = n;
    this.notify();
    await this.fetchFullDiff();
  }

  async expandContext(step = 20) {
    await this.setContextLines(this.contextLines + step);
  }

  async resetContext() {
    await this.setContextLines(DEFAULT_CONTEXT);
  }

  // ---- Lightweight file listing (polled) ------------------------------------

  /** Fetch the lightweight file listing from the backend. */
  async refresh() {
    if (this._projectId == null) {
      this.fileData = { files: [], branch: null, baseBranch: null };
      this.error = null;
      this.notify();
      return;
    }

    try {
      const resp = await fetch(
        `/api/projects/${this._projectId}/diff/files`
      );
      if (!resp.ok) {
        this.error = `HTTP ${resp.status}`;
        this.notify();
        return;
      }
      const json = await resp.json();
      this.fileData = {
        files: sortFileSummaries(json.files ?? []),
        branch: json.branch ?? null,
        baseBranch: json.baseBranch ?? null,
      };
      this.error = null;
      this.notify();
    } catch (err: any) {
      this.error = err.message ?? "Failed to fetch file list";
      this.notify();
    }
  }

  // ---- Full diff (on demand) -------------------------------------------------

  /** Fetch the full diff. Highlighting is done client-side via Shiki worker. */
  async fetchFullDiff() {
    if (this._projectId == null) {
      this.fullData = null;
      this.notify();
      return;
    }

    this.fullLoading = true;
    this.notify();

    try {
      const resp = await fetch(
        `/api/projects/${this._projectId}/diff?context=${this.contextLines}`
      );
      if (!resp.ok) {
        this.error = `HTTP ${resp.status}`;
        this.fullLoading = false;
        this.notify();
        return;
      }
      const json = await resp.json();
      const files = sortDiffFiles(json.files ?? []);
      this.fullData = {
        files,
        branch: json.branch ?? null,
        baseBranch: json.baseBranch ?? null,
      };
      this.error = null;
      this.fullLoading = false;
      this.notify();

      // Request syntax highlighting from the web worker
      if (files.length > 0) {
        this._highlighter.highlight(files, () => this.notify());
      }
      return;
    } catch (err: any) {
      this.error = err.message ?? "Failed to fetch diff";
    }
    this.fullLoading = false;
    this.notify();
  }

  /** Discard the full diff data (e.g. when navigating away from the changes view). */
  clearFullDiff() {
    this.fullData = null;
    this.contextLines = DEFAULT_CONTEXT;
    this.notify();
  }

  // ---- Polling --------------------------------------------------------------

  private _restartPolling() {
    this._stopPolling();
    if (this._projectId != null) {
      this.refresh();
      this._pollTimer = setInterval(() => this.refresh(), POLL_INTERVAL);
    }
  }

  private _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ---- Lifecycle ------------------------------------------------------------

  /** Clean up timers. Call when the app is torn down. */
  dispose() {
    this._stopPolling();
    this._listeners.clear();
    this._highlighter.dispose();
  }
}
