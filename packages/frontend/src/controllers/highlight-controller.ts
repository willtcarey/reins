/**
 * HighlightController
 *
 * Reactive controller that owns syntax highlighting for a **single** DiffHunk.
 * Each `<diff-hunk>` creates its own instance. The shared static Highlighter
 * (Shiki web worker) is reused across all instances and survives component
 * disconnects (e.g. tab switches).
 *
 * When the `hunk` setter receives a new object reference, the hunk's text
 * lines are sent to the highlighter along with the file path (for language
 * detection). The resulting HTML is stored here — the highlighter never
 * mutates DiffLine objects. Same-ref assignments are skipped.
 *
 * Usage (inside a Lit component):
 *   private _highlight = new HighlightController(this);
 *
 *   willUpdate(changed) {
 *     if (changed.has('file') || changed.has('hunkIndex')) {
 *       this._highlight.setHunk(this.file.path, this.file.hunks[this.hunkIndex]);
 *     }
 *   }
 *
 *   // In render:
 *   const html = this._highlight.getLineHtml(lineIndex);
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { DiffHunk } from "../models/changes/types.js";
import type { IHighlighter } from "../models/changes/highlighter.js";
import { Highlighter } from "../models/changes/highlighter.js";

export class HighlightController implements ReactiveController {
  /**
   * Shared highlighter instance — survives component disconnects so the
   * Shiki web worker (and its loaded languages) aren't thrown away on
   * tab switches. All HighlightController instances share the same worker.
   */
  private static _shared: IHighlighter = new Highlighter();

  private _host: ReactiveControllerHost;
  private _highlighter: IHighlighter;
  private _lastHunk: DiffHunk | null = null;

  /**
   * Highlighted HTML strings for each line in the current hunk.
   * Null until the highlighter callback fires. Cleared when a new
   * hunk ref is set (so stale HTML from the previous hunk is never
   * used with the new hunk's lines).
   */
  private _htmlLines: string[] | null = null;

  /**
   * @param host The Lit component that owns this controller.
   * @param highlighter Optional — pass a fake for testing. Production uses the shared instance.
   */
  constructor(host: ReactiveControllerHost, highlighter?: IHighlighter) {
    this._host = host;
    this._highlighter = highlighter ?? HighlightController._shared;
    host.addController(this);
  }

  /**
   * Set the hunk to highlight. When the hunk reference changes, its text
   * lines are sent to the highlighter. The resulting HTML is stored on this
   * controller (not mutated onto the DiffLine objects). Same-ref assignments
   * are skipped.
   */
  setHunk(path: string, hunk: DiffHunk | null): void {
    if (hunk === this._lastHunk) return;
    this._lastHunk = hunk;
    this._htmlLines = null;
    if (!hunk) return;

    const targetHunk = hunk;
    this._highlighter.highlightHunk(
      path,
      hunk.lines.map((l) => l.text),
      (htmlLines) => {
        // Guard against stale callbacks — only store the result if the
        // hunk hasn't been replaced by a newer setHunk call.
        if (this._lastHunk === targetHunk) {
          this._htmlLines = htmlLines;
        }
        this._host.requestUpdate();
      },
    );
  }

  /** Get the highlighted HTML for a line by index, or undefined if not yet available. */
  getLineHtml(index: number): string | undefined {
    return this._htmlLines?.[index];
  }

  get htmlLines(): string[] | null {
    return this._htmlLines;
  }

  get hunk(): DiffHunk | null {
    return this._lastHunk;
  }

  hostConnected() {}
  hostDisconnected() {}
}
