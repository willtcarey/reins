/**
 * The Reins SDK: everything a built-in feature may use (docs/dev/reins-sdk.md). It imports nothing
 * from the app, so it can become a types package; its values are Reins values, never templates,
 * markup, stores or transport types.
 */

/** Undoes a registration or a subscription. Calling it again does nothing. */
export type Disposer = () => void;

// ---------------------------------------------------------------------------
// Sources and files
// ---------------------------------------------------------------------------

/** A checkout on a node (ADR-029), where a session's files are. Its node and path are its identity. */
export interface Source {
  readonly nodeId: string;
  /** The checkout's path on its node; absolute paths in its sessions' output are under it. */
  readonly path: string;
}

export function sameSource(a: Source | null, b: Source | null): boolean {
  if (!a || !b) return a === b;
  return a.nodeId === b.nodeId && a.path === b.path;
}

/** A source's file listing as it loads. A reload keeps `data` while it runs and when it fails. */
export interface FileListing {
  /** Paths relative to the source's root. */
  readonly data: readonly string[] | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export interface FileText {
  /** The file's text, or for a binary file a description of it. */
  text: string;
  isBinary: boolean;
}

export interface DirectoryEntry {
  name: string;
  type: "file" | "directory";
}

/**
 * A source's files. The host finds how to reach a source and whether its node is connected, from
 * the sessions it knows on that source.
 */
export interface Files {
  /**
   * The source's listing, synchronously, so it can be read while rendering: loaded the first time it
   * is asked for, cached, and reloaded when the source's files may have changed and when its node
   * comes back. Empty (no data, not loading) for a null or unknown source and while the node is
   * offline. A reload that finds the same files keeps the same `data` array.
   */
  listing(source: Source | null): FileListing;
  /** Listens for any listing changing, including a source's node going offline or coming back. */
  subscribe(listener: () => void): Disposer;
  /**
   * Listens for a source's files having possibly changed: a file-modifying tool or a turn of one of
   * its sessions ended. A burst of them is announced once, about half a second after the first.
   */
  onFilesChanged(listener: (source: Source) => void): Disposer;
  /** Reads a file as it is now; nothing is cached. Rejects with an Error whose message can be shown. */
  read(source: Source, path: string): Promise<FileText>;
  /** One level of a directory, `.` being the source's root. */
  listDirectory(source: Source, path: string): Promise<DirectoryEntry[]>;
  /** Where the browser loads a file itself (images, PDFs, downloads); null for an unknown source. */
  contentUrl(source: Source, path: string, options?: { download?: boolean }): string | null;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Which of a file's tabs shows it: its code, or a preview (Markdown, HTML, images, PDFs). */
export type FileViewMode = "code" | "preview";

/** Each view's parameters, by the view's name. `changes` is the Inspector's own. */
export interface ViewParameters {
  changes: Record<never, never>;
  file: { path: string; startLine?: number; endLine?: number; mode?: FileViewMode };
}

export type ViewName = keyof ViewParameters;
export type ViewOf<K extends ViewName> = { view: K } & ViewParameters[K];
/** What a container shows: a plain, serializable object whose `view` names its renderer. */
export type View = { [K in ViewName]: ViewOf<K> }[ViewName];

function lineNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** A view from a value that was serialized (or null when it is not one). */
export function parseView(value: unknown): View | null {
  if (typeof value !== "object" || value === null) return null;
  const name: unknown = Reflect.get(value, "view");
  if (name === "changes") return { view: "changes" };
  if (name !== "file") return null;
  const path: unknown = Reflect.get(value, "path");
  if (typeof path !== "string" || !path) return null;
  const startLine = lineNumber(Reflect.get(value, "startLine"));
  const endLine = startLine == null ? undefined : lineNumber(Reflect.get(value, "endLine"));
  const mode: unknown = Reflect.get(value, "mode");
  return {
    view: "file",
    path,
    ...(startLine == null ? {} : { startLine }),
    ...(endLine == null ? {} : { endLine }),
    ...(mode === "code" || mode === "preview" ? { mode } : {}),
  };
}

/** Views with the same key are the same view: a file's lines and mode only move within it. */
export function viewKey(view: View): string {
  return view.view === "file" ? `file:${view.path}` : view.view;
}

/** What the workspace shows views and decorated messages for. */
export interface WorkspaceContext {
  /** The viewed session's source; null until it is known. */
  readonly source: Source | null;
}

/** An icon the host draws. */
export type IconName = "file" | "folder" | "code" | "preview";

/**
 * How the host shows a view: its tab's title, description (the title's tooltip) and icon, and the
 * custom element that renders it. The host creates that element and sets its `view` and `context`
 * (`ViewElement`); the element fills its container.
 */
export interface ViewRenderer<V = View> {
  title(view: V): string;
  description(view: V): string;
  icon: IconName;
  /** A custom element name (with a hyphen), defined by the feature before it registers. */
  element: string;
}

/**
 * The properties the host sets on a view's element. Every open of the view sets a new `view` object,
 * equal or not, so an element that sees a new one shows it afresh (reads it again, reveals its lines).
 */
export interface ViewElement<V = View> {
  view: V | null;
  context: WorkspaceContext | null;
}

/** Each view's renderer type, by the view's name. */
export type ViewRendererMap = { [K in ViewName]: ViewRenderer<ViewOf<K>> };

export interface Views {
  /**
   * Registers the renderer of a view name. A name has one renderer, `changes` is the Inspector's own,
   * and `element` must be a custom element name; each of these throws.
   */
  register<K extends ViewName>(name: K, renderer: ViewRendererMap[K]): Disposer;
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

/** A container of the workspace, by ID; later layouts add IDs. */
export type ContainerId = "inspector";

export interface OpenOptions {
  /** The container; the Inspector when left out. */
  in?: ContainerId;
  /** The source the view is of, for a caller outside the workspace: the workspace ignores a view of another project. */
  source?: Source;
}

export interface Workspace {
  /**
   * Shows a view in a container of the workspace on screen: a view with the same `viewKey` that is
   * already open there is focused and replaced by this one, otherwise it opens after the others. On a
   * phone the workspace moves to the container's page. Nothing happens while no workspace is shown.
   */
  open(view: View, options?: OpenOptions): void;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Decoration {
  /** What activating it opens, in the Inspector. */
  view: View;
  /** What activating it does, as its tooltip. */
  label: string;
}

/** A decoration of `text.slice(start, end)`. */
export interface DecorationSpan extends Decoration {
  start: number;
  end: number;
}

/**
 * Turns pieces of completed message text into controls that open views. The host applies it to
 * prose (never to code blocks, links, images or a message still streaming) and keeps the message's
 * text unchanged. It is called while messages render, so it answers synchronously from what it has,
 * and says when that changes.
 */
export interface MessageDecorator {
  /** The pieces of some prose to decorate, in order and not overlapping. */
  decorate(text: string, context: WorkspaceContext): DecorationSpan[];
  /** The decoration a whole inline-code span is, or null. */
  decorateCode?(code: string, context: WorkspaceContext): Decoration | null;
  /** Listens for what it decorates from changing; the host then decorates messages again. */
  onChange(listener: () => void): Disposer;
}

export interface Messages {
  /** Registers a decorator; where two decorate overlapping text, the earlier registered wins. */
  registerDecorator(decorator: MessageDecorator): Disposer;
}

// ---------------------------------------------------------------------------
// The SDK
// ---------------------------------------------------------------------------

/**
 * What features import as `reins` from `reins-sdk`. Using it before the host is installed (app-shell,
 * at startup) throws.
 */
export interface ReinsSdk {
  readonly files: Files;
  readonly workspace: Workspace;
  readonly views: Views;
  readonly messages: Messages;
}
