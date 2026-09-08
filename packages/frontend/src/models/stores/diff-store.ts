/**
 * Diff Store
 *
 * Centralized data store for git diff state. Polls the lightweight
 * /diff/files endpoint for file listings, and fetches the raw patch on demand
 * when the user views Changes.
 *
 * A single instance is created by the app shell and shared across the review
 * panel and file tree, eliminating duplicate fetches.
 */

import type { DiffFileSummary } from "../changes/types.js";
import { sortFileSummaries } from "../changes/diff-sort.js";
import { Loadable, type Loadable as LoadableState } from "../../helpers/loadable.js";

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

export interface DiffPatchData {
  patch: string;
  cacheKeyPrefix: string;
  version: number;
  branch: string | null;
  baseBranch: string | null;
}

export type DiffStoreListener = () => void;

export type DiffRefreshTrigger =
  | "manual"
  | "poll"
  | "poll-summary-changed"
  | "websocket"
  | "route"
  | "upload"
  | "mode-change"
  | "branch-change"
  | "rebase";

export interface DiffRefreshOptions {
  /** Only refetch loaded renderer payloads when the lightweight file summary changed. */
  onlyFetchDiffIfNeeded?: boolean;
  /** Caller responsible for this refresh, exposed through DOM diagnostics. */
  trigger?: DiffRefreshTrigger;
}

export class DiffStore {

  // ---- Public reactive state ------------------------------------------------

  /** Lightweight file listing — always up to date via polling. */
  fileData: LoadableState<DiffFileData> = Loadable.idle<DiffFileData>().asLoaded({ files: [], branch: null, baseBranch: null });

  /** Raw patch diff — fetched on demand by the Changes renderer. */
  patchData: LoadableState<DiffPatchData> = Loadable.idle();

  contextLines = DEFAULT_CONTEXT;

  /** Which changes to show: all branch changes or only uncommitted. */
  diffMode: DiffMode = "branch";

  /** Commit spread for the active branch (ahead/behind base & remote). */
  spread: SpreadData | null = null;

  /** Current sync action (push or rebase) in progress. */
  syncAction: SyncAction = "idle";

  /** Result of the last sync action — transient, auto-clears. */
  syncResult: SyncResult = null;

  /** Refresh diagnostics exposed by the review surface for inspection. */
  lastFilesRefreshAt: string | null = null;
  lastPayloadRefreshAt: string | null = null;
  lastRefreshTrigger: DiffRefreshTrigger | null = null;
  lastSummaryChanged: boolean | null = null;

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
  /** Monotonic version for patch-backed renderer items. */
  private _patchDiffVersion = 0;
  /** Only the latest started patch request may update renderer data. */
  private _patchRequestGeneration = 0;

  /** Build the `&branch=...` query fragment if a branch is set. */
  private get _branchParam(): string {
    return this._branch ? `&branch=${encodeURIComponent(this._branch)}` : "";
  }

  // ---- Accessors ------------------------------------------------------------

  get projectId(): number | null {
    return this._projectId;
  }

  /** The branch being viewed: selected task branch, or current branch for scratch sessions. */
  get branch(): string | null {
    return this._branch ?? this.fileData.data?.branch ?? null;
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
    this.fileData = this.fileData.asLoaded({ files: [], branch: null, baseBranch: null });
    this.patchData = Loadable.idle();
    this._patchDiffVersion = 0;
    this._patchRequestGeneration += 1;
    this.lastFilesRefreshAt = null;
    this.lastPayloadRefreshAt = null;
    this.lastRefreshTrigger = null;
    this.lastSummaryChanged = null;
    this.spread = null;
    this.syncAction = "idle";
    this.syncResult = null;
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
    this.patchData = Loadable.idle();
    this._patchDiffVersion = 0;
    this._patchRequestGeneration += 1;
    this.spread = null;
    this.notify();
    void this.refresh({ trigger: "branch-change" });
    this._restartSpreadPolling();
  }

  // ---- Diff mode -------------------------------------------------------------

  /** Switch between branch and uncommitted diff modes. Re-fetches data. */
  async setDiffMode(mode: DiffMode) {
    if (mode === this.diffMode) return;
    const hadPatchData = this.patchData.data !== null;
    this.diffMode = mode;
    this.patchData = Loadable.idle();
    this._patchDiffVersion = 0;
    this._patchRequestGeneration += 1;
    this.notify();
    // Re-poll file list immediately with the new mode
    await this.refresh({ trigger: "mode-change" });
    if (hadPatchData) await this.fetchPatchDiff("mode-change");
  }

  // ---- File listing / rendered diff refresh ---------------------------------

  /** Refresh the file listing and, by default, any already-loaded rendered diff payloads. */
  async refresh(options: DiffRefreshOptions = {}) {
    const trigger = options.trigger ?? "manual";
    if (this._projectId == null) {
      this.fileData = this.fileData.asLoaded({ files: [], branch: null, baseBranch: null });
      this.notify();
      return;
    }

    this.fileData = this.fileData.asLoading();
    this.notify();

    try {
      const resp = await fetch(
        `/api/projects/${this._projectId}/diff/files?mode=${this.diffMode}${this._branchParam}`
      );
      if (!resp.ok) {
        this.lastFilesRefreshAt = new Date().toISOString();
        this.lastRefreshTrigger = trigger;
        this.lastSummaryChanged = null;
        this.fileData = this.fileData.asError(`HTTP ${resp.status}`);
        this.notify();
        return;
      }
      const json = await resp.json();
      const newFiles = sortFileSummaries(json.files ?? []);
      const changed = JSON.stringify(newFiles) !== JSON.stringify(this.fileData.data?.files ?? []);
      this.lastFilesRefreshAt = new Date().toISOString();
      this.lastRefreshTrigger = trigger;
      this.lastSummaryChanged = changed;
      this.fileData = this.fileData.asLoaded({
        files: newFiles,
        branch: json.branch ?? null,
        baseBranch: json.baseBranch ?? null,
      });
      this.notify();

      // If rendered diff data is loaded, re-fetch it when the file list changes.
      // Default refreshes force this because path/+/- summaries do not change
      // when an edit swaps text with the same net line counts. Polling opts into
      // summary-gated diff refreshes to keep the interval cheap.
      const shouldRefetchLoadedDiffs = changed || options.onlyFetchDiffIfNeeded !== true;
      const payloadTrigger: DiffRefreshTrigger = trigger === "poll" && changed
        ? "poll-summary-changed"
        : trigger;
      if (shouldRefetchLoadedDiffs && this.patchData.data) {
        await this.fetchPatchDiff(payloadTrigger);
      }
    } catch (err: any) {
      this.lastFilesRefreshAt = new Date().toISOString();
      this.lastRefreshTrigger = trigger;
      this.lastSummaryChanged = null;
      this.fileData = this.fileData.asError(err.message ?? "Failed to fetch file list");
      this.notify();
    }
  }

  // ---- Patch diff (on demand) ------------------------------------------------

  /** Fetch the raw patch diff for patch-backed renderers. */
  async fetchPatchDiff(trigger: DiffRefreshTrigger = "manual") {
    const requestGeneration = ++this._patchRequestGeneration;
    if (this._projectId == null) {
      this.patchData = Loadable.idle();
      this.notify();
      return;
    }

    this.patchData = this.patchData.asLoading();
    this.notify();

    try {
      const resp = await fetch(
        `/api/projects/${this._projectId}/diff/patch?context=${this.contextLines}&mode=${this.diffMode}${this._branchParam}`
      );
      if (requestGeneration !== this._patchRequestGeneration) return;
      if (!resp.ok) {
        this.lastPayloadRefreshAt = new Date().toISOString();
        this.lastRefreshTrigger = trigger;
        this.patchData = this.patchData.asError(`HTTP ${resp.status}`);
        this.notify();
        return;
      }

      const patch = await resp.text();
      if (requestGeneration !== this._patchRequestGeneration) return;
      const version = this._patchDiffVersion + 1;
      this._patchDiffVersion = version;
      this.patchData = this.patchData.asLoaded({
        patch,
        cacheKeyPrefix: `project-${this._projectId}-${this.diffMode}-${this.contextLines}-${this._branch ?? "HEAD"}-v${version}`,
        version,
        branch: this.branch,
        baseBranch: this.fileData.data?.baseBranch ?? null,
      });
      this.lastPayloadRefreshAt = new Date().toISOString();
      this.lastRefreshTrigger = trigger;
      this.notify();
      return;
    } catch (err: any) {
      if (requestGeneration !== this._patchRequestGeneration) return;
      this.lastPayloadRefreshAt = new Date().toISOString();
      this.lastRefreshTrigger = trigger;
      this.patchData = this.patchData.asError(err.message ?? "Failed to fetch patch diff");
    }
    this.notify();
  }

  /** Discard the parsed patch diff. */
  clearPatchDiff() {
    this.patchData = Loadable.idle();
    this._patchDiffVersion = 0;
    this._patchRequestGeneration += 1;
    this.notify();
  }

  // ---- Spread polling (sync status) ------------------------------------------

  /** Fetch spread, optionally with a remote git fetch first. */
  async fetchSpread(remote = false) {
    const branch = this.branch;
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
    const branch = this.branch;
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
    const branch = this.branch;
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
    // Refresh spread + the loaded review patch after rebase.
    await this.fetchSpread();
    if (this.patchData.data) await this.fetchPatchDiff("rebase");
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
      void this.refresh({ onlyFetchDiffIfNeeded: true, trigger: "poll" });
      this._pollTimer = setInterval(
        () => void this.refresh({ onlyFetchDiffIfNeeded: true, trigger: "poll" }),
        POLL_INTERVAL,
      );
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
  }
}
