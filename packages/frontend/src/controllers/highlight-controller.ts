/**
 * HighlightController
 *
 * Reactive controller that owns the syntax highlighter (Shiki web worker)
 * and triggers re-highlighting when diff files change. This moves
 * highlighting responsibility out of DiffStore (pure data) and into the
 * view layer where it belongs.
 *
 * Uses a WeakSet<DiffFile> to track which file objects have already been
 * highlighted. When the store produces a new file object (shallow copy)
 * after mutation (e.g. expandHunk), only that file is re-highlighted.
 * Files that haven't changed keep their existing html and are skipped.
 *
 * Usage:
 *   private _highlight = new HighlightController(this);
 *
 *   // When the store notifies:
 *   this._highlight.files = store.fullData?.files ?? [];
 */
import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { DiffFile } from "../changes/types.js";
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
  private _files: DiffFile[] = [];
  private _lastRef: DiffFile[] | null = null;
  private _highlighted = new WeakSet<DiffFile>();

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
   * Set the files to highlight. Uses a WeakSet to track which file objects
   * have already been highlighted — only dirty (new) file objects are sent
   * to the highlighter. The Highlighter writes `line.html` by reference,
   * so highlighting a subset updates the correct lines in the main array.
   */
  set files(files: DiffFile[]) {
    if (files === this._lastRef) return;
    this._files = files;
    this._lastRef = files;

    if (files.length === 0) return;

    const dirtyFiles = files.filter((f) => !this._highlighted.has(f));
    if (dirtyFiles.length === 0) return;

    this._highlighter.highlight(dirtyFiles, () => {
      for (const f of dirtyFiles) {
        this._highlighted.add(f);
      }
      this._host.requestUpdate();
    });
  }

  get files(): DiffFile[] {
    return this._files;
  }

  hostConnected() {}
  hostDisconnected() {}
}
