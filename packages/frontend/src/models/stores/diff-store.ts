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

import type { DiffFileResponse } from "@backend/routes/diff.js";
import type { SpreadResponse } from "@backend/routes/git.js";
import type { DiffMode } from "@backend/models/workspace.js";
import { sortFileSummaries } from "../changes/diff-sort.js";
import { Loadable, type Loadable as LoadableState } from "../../helpers/loadable.js";
import { api } from "../reins-client.js";

const DEFAULT_CONTEXT = 3;
const POLL_INTERVAL = 5000;
const SPREAD_INTERVAL = 10_000;
const SPREAD_FETCH_EVERY = 6;

export type SyncAction = "idle" | "pushing" | "rebasing";
export type SyncResult = { ok: true } | { error: string } | null;

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
  fileData: LoadableState<DiffFileResponse> = Loadable.idle<DiffFileResponse>().asLoaded({ files: [], branch: null, baseBranch: null });

  /** Raw patch diff — fetched on demand by the Changes renderer. */
  patchData: LoadableState<DiffPatchData> = Loadable.idle();

  contextLines = DEFAULT_CONTEXT;

  /** Which changes to show: all branch changes or only uncommitted. */
  diffMode: DiffMode = "branch";

  /** Commit spread for the active branch (ahead/behind base & remote). */
  spread: SpreadResponse | null = null;

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
   * the current HEAD (used for scratch sessions and completed-task history).
   */
  private _branch: string | null = null;
  private _listeners = new Set<DiffStoreListener>();
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _spreadTimer: ReturnType<typeof setInterval> | null = null;
  private _spreadTickCount = 0;
  private _syncResultTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic version for patch-backed renderer items. */
  private _patchDiffVersion = 0;
  /** Only the latest request for each scoped resource may update state. */
  private _filesRequestGeneration = 0;
  private _patchRequestGeneration = 0;
  private _spreadRequestGeneration = 0;

  // ---- Accessors ------------------------------------------------------------

  get projectId(): number | null {
    return this._projectId;
  }

  /** The branch being viewed: selected open-task branch, or the current project branch. */
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
    this.setScope(id, null);
  }

  // ---- Branch management -----------------------------------------------------

  /**
   * Set the task branch to diff. When an open-task session is selected, pass
   * its branch_name. Pass null for scratch sessions and completed-task history
   * to show the current project HEAD rather than reconstructing old filesystem state.
   */
  setBranch(branch: string | null) {
    if (branch === this._branch) return;
    this.setScope(this._projectId, branch);
  }

  /**
   * Apply route-derived project and branch state atomically. Project switches
   * otherwise fetch once for HEAD and again after WorkspaceStore resolves the
   * selected task branch.
   */
  setScope(projectId: number | null, branch: string | null) {
    const projectChanged = projectId !== this._projectId;
    const branchChanged = branch !== this._branch;

    if (projectChanged) {
      this._projectId = projectId;
      this.fileData = this.fileData.asLoaded({ files: [], branch: null, baseBranch: null });
      this.lastFilesRefreshAt = null;
      this.lastPayloadRefreshAt = null;
      this.lastRefreshTrigger = null;
      this.lastSummaryChanged = null;
      this.syncAction = "idle";
      this.syncResult = null;
      this.contextLines = DEFAULT_CONTEXT;
    }

    if (projectChanged || branchChanged) {
      this._branch = branch;
      this.patchData = Loadable.idle();
      this._patchDiffVersion = 0;
      this._filesRequestGeneration += 1;
      this._patchRequestGeneration += 1;
      this._spreadRequestGeneration += 1;
      this.spread = null;
      this.notify();
    }

    if (projectChanged) {
      this._restartPolling();
    } else {
      void this.refresh({
        trigger: branchChanged ? "branch-change" : "route",
        onlyFetchDiffIfNeeded: !branchChanged,
      });
    }

    if (projectChanged || branchChanged) this._restartSpreadPolling();
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
    const requestGeneration = ++this._filesRequestGeneration;
    const trigger = options.trigger ?? "manual";
    const projectId = this._projectId;
    const mode = this.diffMode;
    if (projectId == null) {
      this.fileData = this.fileData.asLoaded({ files: [], branch: null, baseBranch: null });
      this.notify();
      return;
    }

    this.fileData = this.fileData.asLoading();
    this.notify();

    try {
      const json = await api.diff.files(projectId, {
        mode,
        ...(this._branch ? { branch: this._branch } : {}),
      });
      if (requestGeneration !== this._filesRequestGeneration) return;
      if (requestGeneration !== this._filesRequestGeneration) return;
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
      if (requestGeneration !== this._filesRequestGeneration) return;
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
      const patch = await api.diff.patch(this._projectId, {
        context: this.contextLines,
        mode: this.diffMode,
        ...(this._branch ? { branch: this._branch } : {}),
      });
      if (requestGeneration !== this._patchRequestGeneration) return;
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
    const requestGeneration = ++this._spreadRequestGeneration;
    const projectId = this._projectId;
    const branch = this.branch;
    if (projectId == null || !branch) return;

    try {
      const spread = await api.git.spread(projectId, branch, remote);
      if (requestGeneration !== this._spreadRequestGeneration) return;
      if (requestGeneration !== this._spreadRequestGeneration) return;
      this.spread = spread;
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
      await api.git.push(this._projectId, branch);
      this.syncResult = { ok: true };
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
      await api.git.rebase(this._projectId, branch);
      this.syncResult = { ok: true };
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

    // Show local spread immediately without putting a remote fetch and task
    // reconciliation on the project-switch request burst. The first interval
    // refreshes remote refs, then subsequent remote refreshes stay sparse.
    this._spreadTickCount = 0;
    void this.fetchSpread(false);
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
    this._filesRequestGeneration += 1;
    this._patchRequestGeneration += 1;
    this._spreadRequestGeneration += 1;
    if (this._syncResultTimer) clearTimeout(this._syncResultTimer);
    this._listeners.clear();
  }
}
