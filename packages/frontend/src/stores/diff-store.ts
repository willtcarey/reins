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
import { Highlighter } from "../changes/highlighter.js";

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

  /** Cache of file content lines (1-indexed: element 0 is unused). */
  private _fileContentCache = new Map<string, string[]>();

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
    let url = `/api/projects/${projectId}/file?path=${encodeURIComponent(filePath)}`;
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
    if (!this.fullData) return null;
    const file = this.fullData.files.find((f) => f.path === filePath);
    if (!file) return null;
    const fileLines = await this._fetchFileLines(filePath);
    if (fileLines.length <= 1) return null;
    return { file, fileLines };
  }

  /** Insert context lines into a hunk, notify, and re-highlight. */
  private _insertAndHighlight(
    file: DiffFile,
    hunk: DiffHunk,
    lines: DiffLine[],
    position: "prepend" | "append",
  ) {
    if (position === "prepend") {
      hunk.lines.unshift(...lines);
    } else {
      hunk.lines.push(...lines);
    }
    this.notify();
    this._highlighter.highlight([file], () => this.notify());
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
    this._insertAndHighlight(file, file.hunks[hunkIndex], contextLines, up ? "prepend" : "append");
    return count;
  }

  /**
   * Expand the gap between two adjacent hunks by `step` lines at a time.
   * Appends context lines to the end of the previous hunk. When the gap is
   * fully consumed, merges the two hunks into one.
   * Returns the number of lines inserted.
   */
  async expandHunkGap(filePath: string, nextHunkIndex: number, step = EXPAND_STEP): Promise<number> {
    const resolved = await this._resolveFileForExpansion(filePath);
    if (!resolved) return 0;
    const { file, fileLines } = resolved;
    if (nextHunkIndex < 1 || nextHunkIndex >= file.hunks.length) return 0;

    const prevEnd = this._hunkEdge(file, nextHunkIndex - 1, "end");
    const nextStart = this._hunkEdge(file, nextHunkIndex, "start");

    const totalGap = nextStart.newLine - prevEnd.newLine - 1;
    if (totalGap <= 0) return 0;

    const count = Math.min(step, totalGap);
    const contextLines = this._makeContextLines(
      fileLines, prevEnd.newLine + 1, prevEnd.oldLine + 1, count,
    );

    const prevHunk = file.hunks[nextHunkIndex - 1];
    prevHunk.lines.push(...contextLines);

    // If we've filled the entire gap, merge the two hunks
    if (count >= totalGap) {
      const nextHunk = file.hunks[nextHunkIndex];
      prevHunk.lines.push(...nextHunk.lines);
      file.hunks.splice(nextHunkIndex, 1);
    }

    this.notify();
    this._highlighter.highlight([file], () => this.notify());
    return count;
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
      const newFiles = sortFileSummaries(json.files ?? []);
      const changed = JSON.stringify(newFiles) !== JSON.stringify(this.fileData.files);
      this.fileData = {
        files: newFiles,
        branch: json.branch ?? null,
        baseBranch: json.baseBranch ?? null,
      };
      this.error = null;
      this.notify();

      // If the file list changed and the full diff is loaded, re-fetch it
      if (changed && this.fullData) {
        await this.fetchFullDiff();
      }
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
      this._fileContentCache.clear();
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
    this._fileContentCache.clear();
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
