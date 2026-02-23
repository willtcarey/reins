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

import type { DiffFile, DiffFileSummary } from "../changes/types.js";
import { sortDiffFiles, sortFileSummaries } from "../changes/diff-sort.js";
import { Highlighter } from "../changes/highlighter.js";

const DEFAULT_CONTEXT = 3;
const POLL_INTERVAL = 5000;
const SPREAD_INTERVAL = 10_000;
const SPREAD_FETCH_EVERY = 6;

export type DiffMode = "branch" | "uncommitted";

/** Commit spread for a branch relative to base and remote. */
export interface SpreadData {
  branch: string;
  aheadBase: number;
  behindBase: number;
  aheadRemote: number | null;
  behindRemote: number | null;
}

export type SyncAction = "idle" | "pushing" | "rebasing";
export type SyncResult = { ok: true } | { error: string } | null;

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

  /** Which changes to show: all branch changes or only uncommitted. */
  diffMode: DiffMode = "branch";

  /** Commit spread for the active branch (ahead/behind base & remote). */
  spread: SpreadData | null = null;

  /** Current sync action (push or rebase) in progress. */
  syncAction: SyncAction = "idle";

  /** Result of the last sync action — transient, auto-clears. */
  syncResult: SyncResult = null;

  // ---- Private state --------------------------------------------------------

  private _projectId: number | null = null;

  /**
   * The task branch to diff against the base branch. When set, all API
   * calls include `?branch=...`. When null, the backend falls back to
   * HEAD (used for scratch sessions).
   */
  private _branch: string | null = null;
  private _listeners = new Set<DiffStoreListener>();
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _spreadTimer: ReturnType<typeof setInterval> | null = null;
  private _spreadTickCount = 0;
  private _syncResultTimer: ReturnType<typeof setTimeout> | null = null;
  private _highlighter = new Highlighter();

  /** Build the `&branch=...` query fragment if a branch is set. */
  private get _branchParam(): string {
    return this._branch ? `&branch=${encodeURIComponent(this._branch)}` : "";
  }

  // ---- Accessors ------------------------------------------------------------

  get projectId(): number | null {
    return this._projectId;
  }

  /** The task branch being viewed (null for scratch sessions using HEAD). */
  get branch(): string | null {
    return this._branch;
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

  /** Set the active project. Resets all state and restarts polling. */
  setProject(id: number | null) {
    if (id === this._projectId) return;
    this._projectId = id;
    this._branch = null;
    this.fileData = { files: [], branch: null, baseBranch: null };
    this.fullData = null;
    this.spread = null;
    this.syncAction = "idle";
    this.syncResult = null;
    this.error = null;
    this.contextLines = DEFAULT_CONTEXT;
    this.notify();
    this._restartPolling();
    this._restartSpreadPolling();
  }

  // ---- Branch management -----------------------------------------------------

  /**
   * Set the task branch to diff. When a task session is selected, pass
   * its branch_name. For scratch sessions (no task), pass null to fall
   * back to HEAD behavior.
   */
  setBranch(branch: string | null) {
    if (branch === this._branch) return;
    this._branch = branch;
    this.fullData = null;
    this.spread = null;
    this.notify();
    this.refresh();
    this._restartSpreadPolling();
  }

  // ---- Diff mode -------------------------------------------------------------

  /** Switch between branch and uncommitted diff modes. Re-fetches data. */
  async setDiffMode(mode: DiffMode) {
    if (mode === this.diffMode) return;
    this.diffMode = mode;
    this.fullData = null;
    this.notify();
    // Re-poll file list immediately with the new mode
    await this.refresh();
    // If the full diff was visible, re-fetch it too
    await this.fetchFullDiff();
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
        `/api/projects/${this._projectId}/diff/files?mode=${this.diffMode}${this._branchParam}`
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
        `/api/projects/${this._projectId}/diff?context=${this.contextLines}&mode=${this.diffMode}${this._branchParam}`
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

  // ---- Spread polling (sync status) ------------------------------------------

  /** Fetch spread, optionally with a remote git fetch first. */
  async fetchSpread(remote = false) {
    const branch = this._branch ?? this.fileData.branch;
    if (this._projectId == null || !branch) return;

    try {
      const resp = await fetch(
        `/api/projects/${this._projectId}/git/spread?branch=${encodeURIComponent(branch)}&fetch=${remote}`,
      );
      if (!resp.ok) return;
      this.spread = await resp.json();
      this.notify();
    } catch {
      // silent
    }
  }

  // ---- Sync actions (push / rebase) -----------------------------------------

  /** Push the viewed branch to origin. */
  async push() {
    const branch = this._branch ?? this.fileData.branch;
    if (this._projectId == null || !branch || this.syncAction !== "idle") return;

    this.syncAction = "pushing";
    this.syncResult = null;
    this.notify();

    try {
      const resp = await fetch(`/api/projects/${this._projectId}/git/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch }),
      });
      const body = await resp.json();
      this.syncResult = resp.ok ? { ok: true } : { error: body.error ?? "Push failed" };
    } catch (err: any) {
      this.syncResult = { error: err.message ?? "Network error" };
    }

    this.syncAction = "idle";
    this.notify();
    this._scheduleSyncResultClear();
    // Refresh spread to reflect the new state
    await this.fetchSpread();
  }

  /** Rebase the viewed branch onto the base branch. */
  async rebase() {
    const branch = this._branch ?? this.fileData.branch;
    if (this._projectId == null || !branch || this.syncAction !== "idle") return;

    this.syncAction = "rebasing";
    this.syncResult = null;
    this.notify();

    try {
      const resp = await fetch(`/api/projects/${this._projectId}/git/rebase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch }),
      });
      const body = await resp.json();
      this.syncResult = resp.ok ? { ok: true } : { error: body.error ?? "Rebase failed" };
    } catch (err: any) {
      this.syncResult = { error: err.message ?? "Network error" };
    }

    this.syncAction = "idle";
    this.notify();
    this._scheduleSyncResultClear();
    // Refresh spread + diff after rebase
    await this.fetchSpread();
    await this.fetchFullDiff();
  }

  /** Clear sync result after a delay. */
  private _scheduleSyncResultClear() {
    if (this._syncResultTimer) clearTimeout(this._syncResultTimer);
    this._syncResultTimer = setTimeout(() => {
      this.syncResult = null;
      this.notify();
    }, 5000);
  }

  private _restartSpreadPolling() {
    this._stopSpreadPolling();
    if (this._projectId == null) return;

    // First tick always fetches remote
    this._spreadTickCount = 0;
    this._spreadTick();
    this._spreadTimer = setInterval(() => this._spreadTick(), SPREAD_INTERVAL);
  }

  private _spreadTick() {
    const remote = this._spreadTickCount % SPREAD_FETCH_EVERY === 0;
    this._spreadTickCount++;
    this.fetchSpread(remote);
  }

  private _stopSpreadPolling() {
    if (this._spreadTimer) {
      clearInterval(this._spreadTimer);
      this._spreadTimer = null;
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
    this._stopSpreadPolling();
    if (this._syncResultTimer) clearTimeout(this._syncResultTimer);
    this._listeners.clear();
    this._highlighter.dispose();
  }
}
