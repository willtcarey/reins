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

import type { DiffFile, DiffFileSummary, DiffHunk, DiffLine } from "../changes/types.js";
import { sortDiffFiles, sortFileSummaries } from "../changes/diff-sort.js";
import { Loadable, type Loadable as LoadableState } from "../../helpers/loadable.js";

const DEFAULT_CONTEXT = 3;
const EXPAND_STEP = 15;
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

export interface DiffPatchData {
  patch: string;
  cacheKeyPrefix: string;
  version: number;
  branch: string | null;
  baseBranch: string | null;
}

export type DiffStoreListener = () => void;

export interface DiffRefreshOptions {
  /** Only refetch loaded renderer payloads when the lightweight file summary changed. */
  onlyFetchDiffIfNeeded?: boolean;
}

export class DiffStore {

  // ---- Public reactive state ------------------------------------------------

  /** Lightweight file listing — always up to date via polling. */
  fileData: LoadableState<DiffFileData> = Loadable.idle<DiffFileData>().asLoaded({ files: [], branch: null, baseBranch: null });

  /** Full highlighted diff — fetched on demand, may be stale or null. */
  fullData: LoadableState<DiffFullData> = Loadable.idle();

  /** Raw patch diff — fetched on demand by patch-backed renderers. */
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
  /** Cache of file content lines (1-indexed: element 0 is unused). */
  private _fileContentCache = new Map<string, string[]>();
  /** Monotonic version for patch-backed renderer items. */
  private _patchDiffVersion = 0;

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
    this.fullData = Loadable.idle();
    this.patchData = Loadable.idle();
    this._patchDiffVersion = 0;
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
    this.fullData = Loadable.idle();
    this.patchData = Loadable.idle();
    this._patchDiffVersion = 0;
    this.spread = null;
    this.notify();
    void this.refresh();
    this._restartSpreadPolling();
  }

  // ---- Diff mode -------------------------------------------------------------

  /** Switch between branch and uncommitted diff modes. Re-fetches data. */
  async setDiffMode(mode: DiffMode) {
    if (mode === this.diffMode) return;
    const hadPatchData = this.patchData.data !== null;
    this.diffMode = mode;
    this.fullData = Loadable.idle();
    this.patchData = Loadable.idle();
    this._patchDiffVersion = 0;
    this.notify();
    // Re-poll file list immediately with the new mode
    await this.refresh();
    // Preserve existing behavior: mode switches load the classic full diff.
    await this.fetchFullDiff();
    if (hadPatchData) await this.fetchPatchDiff();
  }

  // ---- Per-hunk expansion ---------------------------------------------------

  /**
   * Fetch file content lines for a given path. Returns a 1-indexed array
   * (element 0 is empty string) so fileLines[lineNo] gives the line text.
   */
  private async _fetchFileLines(filePath: string): Promise<string[]> {
    const cached = this._fileContentCache.get(filePath);
    if (cached) return cached;

    const projectId = this._projectId;
    if (projectId == null) return [""];

    const branch = this._branch ?? undefined;
    let url = `/api/projects/${projectId}/files/content?path=${encodeURIComponent(filePath)}`;
    if (branch) url += `&ref=${encodeURIComponent(branch)}`;

    try {
      const resp = await fetch(url);
      if (!resp.ok) return [""];
      const text = await resp.text();
      const lines = text.split("\n");
      // Make 1-indexed: prepend empty string at index 0
      const oneIndexed = ["", ...lines];
      this._fileContentCache.set(filePath, oneIndexed);
      return oneIndexed;
    } catch {
      return [""];
    }
  }

  /**
   * Find the first old/new line numbers from a hunk's lines, scanning from
   * either end. `edge = "start"` scans forward, `edge = "end"` scans backward.
   */
  private _hunkEdge(
    file: DiffFile,
    hunkIndex: number,
    edge: "start" | "end",
  ): { oldLine: number; newLine: number } {
    const lines = file.hunks[hunkIndex].lines;
    let oldLine = 0;
    let newLine = 0;
    const len = lines.length;
    for (let step = 0; step < len; step++) {
      const line = lines[edge === "start" ? step : len - 1 - step];
      if (oldLine === 0 && line.oldLine != null) oldLine = line.oldLine;
      if (newLine === 0 && line.newLine != null) newLine = line.newLine;
      if (oldLine > 0 && newLine > 0) break;
    }
    return { oldLine, newLine };
  }

  /** Build context DiffLine objects from file content. */
  private _makeContextLines(
    fileLines: string[],
    newStart: number,
    oldStart: number,
    count: number,
  ): DiffLine[] {
    const result: DiffLine[] = [];
    for (let i = 0; i < count; i++) {
      const newLine = newStart + i;
      const oldLine = oldStart + i;
      if (newLine >= fileLines.length) break;
      result.push({
        type: "context",
        text: fileLines[newLine],
        oldLine,
        newLine,
      });
    }
    return result;
  }

  /**
   * Resolve the DiffFile and its 1-indexed content lines for expansion.
   * Returns null if the file isn't found or content can't be fetched.
   */
  private async _resolveFileForExpansion(
    filePath: string,
  ): Promise<{ file: DiffFile; fileLines: string[] } | null> {
    const fullData = this.fullData.data;
    if (!fullData) return null;
    const file = fullData.files.find((f) => f.path === filePath);
    if (!file) return null;
    const fileLines = await this._fetchFileLines(filePath);
    if (fileLines.length <= 1) return null;
    return { file, fileLines };
  }

  /**
   * Insert context lines into a hunk and notify subscribers.
   * Creates new object references (shallow copies) for both the mutated hunk
   * and the parent file, plus a new files array. HighlightController uses
   * ref-equality to detect which hunks need re-highlighting.
   */
  private _insertLines(
    file: DiffFile,
    hunk: DiffHunk,
    lines: DiffLine[],
    position: "prepend" | "append",
  ) {
    // Build a new lines array so the hunk gets a new object reference.
    // HighlightController uses ref-equality to detect changes.
    const newLines = position === "prepend"
      ? [...lines, ...hunk.lines]
      : [...hunk.lines, ...lines];

    // Replace the hunk in the file's hunks array with a shallow copy
    const hunkIndex = file.hunks.indexOf(hunk);
    if (hunkIndex >= 0) {
      file.hunks[hunkIndex] = { ...hunk, lines: newLines };
    }

    const fullData = this.fullData.data;
    if (fullData) {
      const fileIndex = fullData.files.indexOf(file);
      if (fileIndex >= 0) {
        fullData.files[fileIndex] = { ...file };
      }
      this.fullData = this.fullData.asLoaded({ ...fullData, files: [...fullData.files] });
    }
    this.notify();
  }

  /**
   * Expand a hunk in the given direction — show more context lines above or below.
   * Returns the number of lines inserted (used for scroll adjustment on "up").
   */
  async expandHunk(
    filePath: string,
    hunkIndex: number,
    direction: "up" | "down",
    step = EXPAND_STEP,
  ): Promise<number> {
    const resolved = await this._resolveFileForExpansion(filePath);
    if (!resolved) return 0;
    const { file, fileLines } = resolved;
    if (hunkIndex < 0 || hunkIndex >= file.hunks.length) return 0;

    const up = direction === "up";
    const totalLines = fileLines.length - 1; // 1-indexed

    // Anchor: the edge of this hunk facing the expansion direction
    const anchor = this._hunkEdge(file, hunkIndex, up ? "start" : "end");

    // Bound: nearest limit — adjacent hunk edge or file boundary
    const neighborIdx = hunkIndex + (up ? -1 : 1);
    const hasNeighbor = neighborIdx >= 0 && neighborIdx < file.hunks.length;
    const bound = hasNeighbor
      ? this._hunkEdge(file, neighborIdx, up ? "end" : "start").newLine + (up ? 1 : -1)
      : (up ? 1 : totalLines);

    const available = up ? anchor.newLine - bound : bound - anchor.newLine;
    const count = Math.min(step, available);
    if (count <= 0) return 0;

    const insertNew = up ? anchor.newLine - count : anchor.newLine + 1;
    const insertOld = up ? anchor.oldLine - count : anchor.oldLine + 1;
    const contextLines = this._makeContextLines(fileLines, insertNew, insertOld, count);
    this._insertLines(file, file.hunks[hunkIndex], contextLines, up ? "prepend" : "append");

    // If expansion closed the gap to an adjacent hunk, merge them.
    // Always merge into the earlier hunk and remove the later one.
    // After _insertLines, the file object in fullData.files is a new shallow copy,
    // so we re-read it to mutate the correct reference.
    if (hasNeighbor && count >= available) {
      const updatedFile = this.fullData.data!.files.find((f) => f.path === filePath)!;
      const earlierIdx = Math.min(hunkIndex, neighborIdx);
      const laterIdx = earlierIdx + 1;
      // Create a new hunk object so HighlightController detects the change
      // via ref-equality. Without this, the earlier hunk is mutated in-place
      // and the controller skips re-highlighting.
      const mergedLines = [
        ...updatedFile.hunks[earlierIdx].lines,
        ...updatedFile.hunks[laterIdx].lines,
      ];
      updatedFile.hunks[earlierIdx] = {
        ...updatedFile.hunks[earlierIdx],
        lines: mergedLines,
      };
      updatedFile.hunks.splice(laterIdx, 1);
      this.notify();
    }

    return count;
  }

  // ---- File listing / rendered diff refresh ---------------------------------

  /** Refresh the file listing and, by default, any already-loaded rendered diff payloads. */
  async refresh(options: DiffRefreshOptions = {}) {
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
        this.fileData = this.fileData.asError(`HTTP ${resp.status}`);
        this.notify();
        return;
      }
      const json = await resp.json();
      const newFiles = sortFileSummaries(json.files ?? []);
      const changed = JSON.stringify(newFiles) !== JSON.stringify(this.fileData.data?.files ?? []);
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
      if (shouldRefetchLoadedDiffs && this.fullData.data) {
        await this.fetchFullDiff();
      }
      if (shouldRefetchLoadedDiffs && this.patchData.data) {
        await this.fetchPatchDiff();
      }
    } catch (err: any) {
      this.fileData = this.fileData.asError(err.message ?? "Failed to fetch file list");
      this.notify();
    }
  }

  // ---- Full diff (on demand) -------------------------------------------------

  /** Fetch the full diff. Highlighting is done client-side via Shiki worker. */
  async fetchFullDiff() {
    if (this._projectId == null) {
      this.fullData = Loadable.idle();
      this.notify();
      return;
    }

    this.fullData = this.fullData.asLoading();
    this.notify();

    try {
      const resp = await fetch(
        `/api/projects/${this._projectId}/diff?context=${this.contextLines}&mode=${this.diffMode}${this._branchParam}`
      );
      if (!resp.ok) {
        this.fullData = this.fullData.asError(`HTTP ${resp.status}`);
        this.notify();
        return;
      }
      const json = await resp.json();
      const files = sortDiffFiles(json.files ?? []);
      this.fullData = this.fullData.asLoaded({
        files,
        branch: json.branch ?? null,
        baseBranch: json.baseBranch ?? null,
      });
      this._fileContentCache.clear();
      this.notify();
      return;
    } catch (err: any) {
      this.fullData = this.fullData.asError(err.message ?? "Failed to fetch diff");
    }
    this.notify();
  }

  /** Fetch the raw patch diff for patch-backed renderers. */
  async fetchPatchDiff() {
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
      if (!resp.ok) {
        this.patchData = this.patchData.asError(`HTTP ${resp.status}`);
        this.notify();
        return;
      }

      const patch = await resp.text();
      const version = this._patchDiffVersion + 1;
      this._patchDiffVersion = version;
      this.patchData = this.patchData.asLoaded({
        patch,
        cacheKeyPrefix: `project-${this._projectId}-${this.diffMode}-${this.contextLines}-${this._branch ?? "HEAD"}-v${version}`,
        version,
        branch: this.branch,
        baseBranch: this.fileData.data?.baseBranch ?? null,
      });
      this.notify();
      return;
    } catch (err: any) {
      this.patchData = this.patchData.asError(err.message ?? "Failed to fetch patch diff");
    }
    this.notify();
  }

  /** Discard the full diff data (e.g. when navigating away from the changes view). */
  clearFullDiff() {
    this.fullData = Loadable.idle();
    this.contextLines = DEFAULT_CONTEXT;
    this._fileContentCache.clear();
    this.notify();
  }

  /** Discard the parsed patch diff. */
  clearPatchDiff() {
    this.patchData = Loadable.idle();
    this._patchDiffVersion = 0;
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
      void this.refresh({ onlyFetchDiffIfNeeded: true });
      this._pollTimer = setInterval(() => void this.refresh({ onlyFetchDiffIfNeeded: true }), POLL_INTERVAL);
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
