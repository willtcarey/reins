/**
 * Diff Store
 *
 * Centralized data store for git diff state. Fetches diff data from the
 * backend, polls for updates, sorts files, and notifies subscribers.
 *
 * A single instance is created by the app shell and shared across the
 * diff-panel and diff-file-tree components, eliminating duplicate fetches.
 */

import type { DiffFile } from "./types.js";
import { sortDiffFiles } from "./diff-sort.js";

const DEFAULT_CONTEXT = 3;
const POLL_INTERVAL = 5000;

export interface DiffData {
  files: DiffFile[];
  branch: string | null;
  baseBranch: string | null;
}

export type DiffStoreListener = () => void;

export class DiffStore {
  // ---- Public reactive state ------------------------------------------------

  data: DiffData = { files: [], branch: null, baseBranch: null };
  error: string | null = null;
  loading = false;
  contextLines = DEFAULT_CONTEXT;

  // ---- Private state --------------------------------------------------------

  private _projectId: number | null = null;
  private _listeners = new Set<DiffStoreListener>();
  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  // ---- Accessors ------------------------------------------------------------

  get projectId(): number | null {
    return this._projectId;
  }

  get defaultContext(): number {
    return DEFAULT_CONTEXT;
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
    this.data = { files: [], branch: null, baseBranch: null };
    this.error = null;
    this.contextLines = DEFAULT_CONTEXT;
    this.notify();
    this._restartPolling();
  }

  // ---- Context lines --------------------------------------------------------

  /** Change the number of context lines and re-fetch. */
  async setContextLines(n: number) {
    if (n === this.contextLines) return;
    this.contextLines = n;
    this.notify();
    await this.refresh();
  }

  async expandContext(step = 20) {
    await this.setContextLines(this.contextLines + step);
  }

  async resetContext() {
    await this.setContextLines(DEFAULT_CONTEXT);
  }

  // ---- Fetching -------------------------------------------------------------

  /** Fetch latest diff data from the backend. */
  async refresh() {
    if (this._projectId == null) {
      this.data = { files: [], branch: null, baseBranch: null };
      this.error = null;
      this.notify();
      return;
    }

    try {
      const resp = await fetch(
        `/api/projects/${this._projectId}/diff?context=${this.contextLines}`
      );
      if (!resp.ok) {
        this.error = `HTTP ${resp.status}`;
        this.notify();
        return;
      }
      const json = await resp.json();
      this.data = {
        files: sortDiffFiles(json.files ?? []),
        branch: json.branch ?? null,
        baseBranch: json.baseBranch ?? null,
      };
      this.error = null;
      this.notify();
    } catch (err: any) {
      this.error = err.message ?? "Failed to fetch diff";
      this.notify();
    }
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
  }
}
