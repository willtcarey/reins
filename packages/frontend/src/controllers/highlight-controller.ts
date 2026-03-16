/**
 * HighlightController
 *
 * Reactive controller that owns syntax highlighting for a **single** DiffHunk.
 * Each `<diff-hunk>` creates its own instance. The shared static Highlighter
 * (Shiki web worker) is reused across all instances and survives component
 * disconnects (e.g. tab switches).
 *
 * When the `hunk` setter receives a new object reference, the hunk is sent
 * to the highlighter along with the file path (for language detection).
 * Same-ref assignments are skipped. The store already produces new file
 * objects (and therefore new hunk refs) on mutation (e.g. expandHunk
 * shallow-copies), so the reference check is sufficient.
 *
 * Usage (inside a Lit component):
 *   private _highlight = new HighlightController(this);
 *
 *   willUpdate(changed) {
 *     if (changed.has('file') || changed.has('hunkIndex')) {
 *       this._highlight.setHunk(this.file.path, this.file.hunks[this.hunkIndex]);
 *     }
 *   }
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { DiffHunk } from "../changes/types.js";
import type { IHighlighter } from "../changes/highlighter.js";
import { Highlighter } from "../changes/highlighter.js";

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
   * @param host The Lit component that owns this controller.
   * @param highlighter Optional — pass a fake for testing. Production uses the shared instance.
   */
  constructor(host: ReactiveControllerHost, highlighter?: IHighlighter) {
    this._host = host;
    this._highlighter = highlighter ?? HighlightController._shared;
    host.addController(this);
  }

  /**
   * Set the hunk to highlight. When the hunk reference changes, it is
   * sent to the highlighter with the given file path for language detection.
   * Same-ref assignments are skipped.
   */
  setHunk(path: string, hunk: DiffHunk | null): void {
    if (hunk === this._lastHunk) return;
    this._lastHunk = hunk;
    if (!hunk) return;

    this._highlighter.highlightHunk(path, hunk, () => {
      this._host.requestUpdate();
    });
  }

  get hunk(): DiffHunk | null {
    return this._lastHunk;
  }

  hostConnected() {}
  hostDisconnected() {}
}
