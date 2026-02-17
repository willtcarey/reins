/**
 * Highlight Manager
 *
 * Manages communication with the Shiki web worker for off-main-thread
 * syntax highlighting of diff lines.
 */

import type { DiffFile } from "./types.js";
import type { HighlightRequest, HighlightResponse } from "./highlight-worker.js";

export type HighlightCallback = () => void;

let nextId = 0;

export class Highlighter {
  private worker: Worker;
  private pending = new Map<number, HighlightCallback>();
  private fileRefs = new Map<number, DiffFile[]>();

  constructor() {
    this.worker = new Worker("/dist/changes/highlight-worker.js", {
      type: "module",
    });
    this.worker.onmessage = (e: MessageEvent<HighlightResponse>) => {
      this.handleResponse(e.data);
    };
  }

  /**
   * Request highlighting for a set of diff files. When results arrive,
   * the `html` field on each DiffLine is populated in-place and the
   * callback is invoked so the component can re-render.
   *
   * Any previously pending requests are cancelled (their callbacks will
   * be silently dropped) so only the latest set of files is highlighted.
   */
  highlight(files: DiffFile[], onComplete: HighlightCallback): void {
    // Cancel all previously pending requests — they reference stale file arrays
    this.pending.clear();
    this.fileRefs.clear();

    const id = nextId++;

    // Build a flat request: for each file, collect all line texts in hunk order
    const request: HighlightRequest = {
      id,
      type: "highlight",
      files: files.map((f) => ({
        path: f.path,
        lines: f.hunks.flatMap((h) => h.lines.map((l) => l.text)),
      })),
    };

    // Store file ref so the response handler can write html back in-place
    this.pending.set(id, onComplete);
    this.fileRefs.set(id, files);

    this.worker.postMessage(request);
  }

  private handleResponse(resp: HighlightResponse): void {
    const fileRef = this.fileRefs.get(resp.id);
    const callback = this.pending.get(resp.id);

    // If this response was for a cancelled request, ignore it
    if (!callback) return;

    if (fileRef) {
      // Write highlighted HTML back into the DiffLine objects in-place
      for (let fi = 0; fi < resp.files.length && fi < fileRef.length; fi++) {
        const htmlLines = resp.files[fi].htmlLines;
        let lineIdx = 0;
        for (const hunk of fileRef[fi].hunks) {
          for (const line of hunk.lines) {
            if (lineIdx < htmlLines.length) {
              line.html = htmlLines[lineIdx];
            }
            lineIdx++;
          }
        }
      }

      this.fileRefs.delete(resp.id);
    }

    this.pending.delete(resp.id);
    callback();
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
