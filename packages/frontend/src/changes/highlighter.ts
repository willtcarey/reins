/**
 * Highlight Manager
 *
 * Manages communication with the Shiki web worker for off-main-thread
 * syntax highlighting of diff lines.
 */

import type { DiffFile, DiffHunk } from "./types.js";
import type { HighlightRequest, HighlightResponse } from "./highlight-worker.js";

export type HighlightCallback = () => void;

/** Minimal interface for highlight providers — allows test fakes. */
export interface IHighlighter {
  highlight(files: DiffFile[], onComplete: HighlightCallback): void;
  /**
   * Highlight a single hunk without cancelling other pending requests.
   * Each hunk completes independently and invokes its own callback,
   * enabling incremental per-hunk rendering.
   */
  highlightHunk(path: string, hunk: DiffHunk, onComplete: HighlightCallback): void;
  dispose(): void;
}

let nextId = 0;

export class Highlighter implements IHighlighter {
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

    // Build request with hunks separated so each is highlighted independently
    const request: HighlightRequest = {
      id,
      type: "highlight",
      files: files.map((f) => ({
        path: f.path,
        hunks: f.hunks.map((h) => ({
          lines: h.lines.map((l) => l.text),
        })),
      })),
    };

    // Store file ref so the response handler can write html back in-place
    this.pending.set(id, onComplete);
    this.fileRefs.set(id, files);

    this.worker.postMessage(request);
  }

  /**
   * Highlight a single hunk without cancelling other pending requests.
   * Each hunk completes independently and invokes its own callback,
   * enabling incremental per-hunk rendering.
   */
  highlightHunk(path: string, hunk: DiffHunk, onComplete: HighlightCallback): void {
    const id = nextId++;

    // Wrap the hunk in a single-file, single-hunk request — the worker
    // protocol always operates on files, but we only send one hunk.
    const request: HighlightRequest = {
      id,
      type: "highlight",
      files: [
        {
          path,
          hunks: [{ lines: hunk.lines.map((l) => l.text) }],
        },
      ],
    };

    // Build a fake single-hunk DiffFile ref so handleResponse can write
    // the html back into the correct DiffLine objects.
    this.pending.set(id, onComplete);
    this.fileRefs.set(id, [{ path, additions: 0, removals: 0, hunks: [hunk] }]);

    this.worker.postMessage(request);
  }

  private handleResponse(resp: HighlightResponse): void {
    const fileRef = this.fileRefs.get(resp.id);
    const callback = this.pending.get(resp.id);

    // If this response was for a cancelled request, ignore it
    if (!callback) return;

    if (fileRef) {
      // Write highlighted HTML back into the DiffLine objects per-hunk
      for (let fi = 0; fi < resp.files.length && fi < fileRef.length; fi++) {
        const respHunks = resp.files[fi].hunks;
        const fileHunks = fileRef[fi].hunks;
        for (let hi = 0; hi < respHunks.length && hi < fileHunks.length; hi++) {
          const htmlLines = respHunks[hi].htmlLines;
          const lines = fileHunks[hi].lines;
          for (let li = 0; li < htmlLines.length && li < lines.length; li++) {
            lines[li].html = htmlLines[li];
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
