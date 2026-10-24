import { sameSource, type Files, type Source } from "@reins/sdk";

/** A file as a viewer shows it. */
export interface FileContent {
  loading: boolean;
  /** The file's text, or for a binary file a description of it. */
  text: string | null;
  isBinary: boolean;
  error: string | null;
}

const LOADING: FileContent = { loading: true, text: null, isBinary: false, error: null };

/**
 * One file's content for a viewer, read through the files API: when it is first shown, when it is
 * shown again with `reload`, and when the API says its source's files may have changed. A response
 * for a file no longer shown, or for an earlier read of it, is dropped.
 */
export class FileLoader {
  private _source: Source | null = null;
  private _path: string | null = null;
  private _content: FileContent | null = null;
  private request = 0;
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;

  constructor(private files: Files) {
    this.unsubscribe = files.onFilesChanged((source) => {
      if (sameSource(this._source, source)) this.read();
    });
  }

  get path(): string | null { return this._path; }

  /** Null while no file is shown. A file read again keeps its content shown meanwhile. */
  get content(): FileContent | null { return this._content; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Shows a file of a source, reading it unless it is already shown; `reload` reads it again. */
  show(source: Source, path: string, { reload = false } = {}): void {
    const shown = sameSource(this._source, source) && this._path === path;
    this._source = source;
    if (shown && !reload) return;
    if (!shown) {
      this._path = path;
      this._content = null;
    }
    this.read();
  }

  clear(): void {
    this.request += 1;
    this._source = null;
    this._path = null;
    this._content = null;
    this.notify();
  }

  dispose(): void {
    this.request += 1;
    this.unsubscribe();
    this.listeners.clear();
  }

  private read(): void {
    const source = this._source;
    const path = this._path;
    if (!source || path == null) return;
    const request = ++this.request;
    if (!this._content || this._content.error) {
      this._content = LOADING;
      this.notify();
    }
    this.files.read(source, path).then(
      ({ text, isBinary }) => this.land(request, { loading: false, text, isBinary, error: null }),
      (error: unknown) => this.land(request, {
        loading: false,
        text: null,
        isBinary: false,
        error: error instanceof Error ? error.message : "Failed to load file",
      }),
    );
  }

  private land(request: number, content: FileContent): void {
    if (request !== this.request) return;
    this._content = content;
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
