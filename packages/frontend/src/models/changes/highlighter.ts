/**
 * Highlight Manager
 *
 * Manages communication with the Shiki web worker for off-main-thread
 * syntax highlighting of diff lines.
 *
 * The highlighter is a pure function: it takes text lines in and returns
 * HTML lines out via callback. It never mutates DiffLine objects — the
 * HighlightController owns the highlighted output.
 */

import type { HighlightRequest, HighlightResponse } from "./highlight-worker.js";

/** Callback that receives per-line highlighted HTML strings. */
export type HighlightHunkCallback = (htmlLines: string[]) => void;

/** Minimal interface for highlight providers — allows test fakes. */
export interface IHighlighter {
  /**
   * Highlight a set of source lines for a single hunk.
   * The callback receives an array of HTML strings (one per input line).
   */
  highlightHunk(
    path: string,
    lines: string[],
    onComplete: HighlightHunkCallback,
  ): void;
  dispose(): void;
}

let nextId = 0;

export class Highlighter implements IHighlighter {
  private worker: Worker;
  private callbacks = new Map<number, HighlightHunkCallback>();

  constructor() {
    this.worker = new Worker("/dist/models/changes/highlight-worker.js", {
      type: "module",
    });
    this.worker.onmessage = (e: MessageEvent<HighlightResponse>) => {
      this.handleResponse(e.data);
    };
  }

  /**
   * Highlight a set of source lines for a single hunk.
   * The callback receives an array of HTML strings (one per input line).
   */
  highlightHunk(
    path: string,
    lines: string[],
    onComplete: HighlightHunkCallback,
  ): void {
    const id = nextId++;

    const request: HighlightRequest = {
      id,
      type: "highlight",
      files: [
        {
          path,
          hunks: [{ lines }],
        },
      ],
    };

    this.callbacks.set(id, onComplete);
    this.worker.postMessage(request);
  }

  private handleResponse(resp: HighlightResponse): void {
    const callback = this.callbacks.get(resp.id);
    if (!callback) return;

    this.callbacks.delete(resp.id);

    const htmlLines = resp.files[0]?.hunks[0]?.htmlLines ?? [];
    callback(htmlLines);
  }

  dispose(): void {
    this.worker.terminate();
    this.callbacks.clear();
  }
}
