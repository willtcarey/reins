/**
 * HighlightController
 *
 * Reactive controller that owns syntax highlighting for a set of text lines.
 * Sends lines to the shared Shiki web worker for highlighting and stores the
 * resulting HTML. Consumers call `highlight(path, lines)` whenever the input
 * changes — same-reference assignments are skipped, and stale callbacks from
 * earlier requests are ignored.
 *
 * Usage (inside a Lit component):
 *   private _highlight = new HighlightController(this);
 *
 *   willUpdate(changed) {
 *     this._highlight.highlight(this.path, this.lines);
 *   }
 *
 *   // In render:
 *   const html = this._highlight.getLineHtml(lineIndex);
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { IHighlighter } from "../models/changes/highlighter.js";
import { getSharedHighlighter } from "../models/changes/shared-highlighter.js";

export class HighlightController implements ReactiveController {

  private _host: ReactiveControllerHost;
  private _highlighter: IHighlighter;
  private _lastLines: string[] | null = null;

  /**
   * Highlighted HTML strings for each line.
   * Null until the highlighter callback fires. Cleared when new lines
   * are set (so stale HTML is never used with new content).
   */
  private _htmlLines: string[] | null = null;

  /**
   * @param host The Lit component that owns this controller.
   * @param highlighter Optional — pass a fake for testing. Production uses the shared instance.
   */
  constructor(host: ReactiveControllerHost, highlighter?: IHighlighter) {
    this._host = host;
    this._highlighter = highlighter ?? getSharedHighlighter();
    host.addController(this);
  }

  /**
   * Highlight the given lines. When the lines reference changes, they are
   * sent to the highlighter. Same-ref assignments are skipped. Pass null
   * to clear.
   */
  highlight(path: string, lines: string[] | null): void {
    if (lines === this._lastLines) return;
    this._lastLines = lines;
    this._htmlLines = null;
    if (!lines) return;

    const targetLines = lines;
    this._highlighter.highlightHunk(
      path,
      lines,
      (htmlLines) => {
        // Guard against stale callbacks
        if (this._lastLines === targetLines) {
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

  hostConnected() {}
  hostDisconnected() {}
}
