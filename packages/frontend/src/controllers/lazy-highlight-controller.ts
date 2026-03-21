/**
 * LazyHighlightController
 *
 * Combines IntersectionObserver-based lazy activation with
 * HighlightController and cache-key deduplication. Extracts the
 * common pattern shared by edit-tool-block, read-tool-block, and
 * write-tool-block into a single reactive controller.
 *
 * The host provides a single `getData()` callback that returns the
 * path and hunk to highlight (or null to skip). The controller
 * derives a cache key from the data to avoid redundant highlighting.
 *
 * Usage:
 *   private _hl = new LazyHighlightController(this, () => {
 *     const path = getPath(this.block);
 *     if (!path || this.block.isError) return null;
 *     return { path, hunk: buildHunk(this.block) };
 *   });
 *
 *   // In willUpdate — call when block/expanded changes:
 *   this._hl.update();
 *
 *   // In render:
 *   const html = this._hl.getLineHtml(index);
 */
import type { ReactiveControllerHost } from "lit";
import type { DiffHunk } from "../changes/types.js";
import { HighlightController } from "./highlight-controller.js";
import type { IHighlighter } from "../changes/highlighter.js";

/** Return the path and hunk to highlight, or null to skip. */
export type LazyHighlightDataFn = () => { path: string; hunk: DiffHunk } | null;

export class LazyHighlightController {
  private _host: ReactiveControllerHost & HTMLElement;
  private _highlight: HighlightController;
  private _observer: IntersectionObserver | null = null;
  private _hasBeenVisible = false;
  private _lastKey: string | null = null;
  private _getData: LazyHighlightDataFn;

  constructor(
    host: ReactiveControllerHost & HTMLElement,
    getData: LazyHighlightDataFn,
    highlighter?: IHighlighter,
  ) {
    this._host = host;
    this._getData = getData;
    this._highlight = new HighlightController(host, highlighter);
  }

  /** Whether the element has been visible at least once. */
  get hasBeenVisible() {
    return this._hasBeenVisible;
  }

  /** Start observing visibility. Call from connectedCallback. */
  connect() {
    if (this._hasBeenVisible) return;
    this._observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this._hasBeenVisible = true;
            this._observer?.disconnect();
            this._observer = null;
            this._tryHighlight();
            break;
          }
        }
      },
      { threshold: 0 },
    );
    this._observer.observe(this._host);
  }

  /** Stop observing. Call from disconnectedCallback. */
  disconnect() {
    this._observer?.disconnect();
    this._observer = null;
  }

  /**
   * Check if highlighting needs to be (re-)triggered.
   * Call from willUpdate when relevant properties change.
   */
  update() {
    if (this._hasBeenVisible) {
      this._tryHighlight();
    }
  }

  /** Get highlighted HTML for a line by index, or undefined if not yet available. */
  getLineHtml(index: number): string | undefined {
    return this._highlight.getLineHtml(index);
  }

  private _tryHighlight() {
    const data = this._getData();
    if (!data) return;

    const key = data.path + "\0" + data.hunk.lines.map((l) => l.text).join("\n");
    if (key === this._lastKey) return;
    this._lastKey = key;

    this._highlight.setHunk(data.path, data.hunk);
  }
}
