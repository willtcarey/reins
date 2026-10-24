/**
 * The Reins SDK, `@reins/sdk`: everything a built-in feature may use (docs/dev/reins-sdk.md). It
 * imports nothing from the app, so it can become a package of its own; its values are Reins values,
 * never templates, markup, stores or transport types. The one DOM value is the element the host
 * gives a view to mount into (ADR-030). The app's side of it is in `sdk-host/`.
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
   * is asked for and cached for the two sources asked for last. After the source's files may have
   * changed or its node comes back, `subscribe` listeners are told and the next ask reloads it, so
   * ask again on hearing that. Empty (no data, not loading) for a null or unknown source and while
   * the node is offline. A reload that finds the same files keeps the same `data` array.
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

/**
 * What a container shows: a plain, serializable object whose `view` names its renderer, registered
 * at runtime (`Views.register`); its other fields are parameters that only that renderer reads. The
 * SDK lists no view names: the feature that registers a view defines its parameters. A view
 * about something fixed names it (a file names its source); a view that follows the viewed session
 * reads `WorkspaceContext` instead.
 */
export type View = { readonly view: string; readonly [parameter: string]: unknown };

/**
 * The views TypeScript knows, by name, for checking what features register, open and decorate with.
 * Empty here: the feature that registers a view adds it beside its register function,
 * `declare module "@reins/sdk" { interface ViewTypes { file: FileView } }`. It is only
 * types: at runtime any name registers and opens, so an extension without TypeScript works the same.
 */
export interface ViewTypes {}

/** A view of a name some feature added to `ViewTypes`. */
export type KnownView = ViewTypes[keyof ViewTypes];

/** What the workspace shows views and decorated messages for: the viewed session. */
export interface WorkspaceContext {
  /** The viewed session's source; null until it is known. */
  readonly source: Source | null;
}

/** What an inline view is given: the piece of message text it is shown for. */
export interface InlineContext extends WorkspaceContext {
  /** The piece's original text. */
  readonly text: string;
  /** Whether the piece is a whole inline-code span. */
  readonly code: boolean;
  /** A new copy of what the host draws for the piece without a view (`<code>app.ts</code>`, or the text). */
  original(): Node;
}

/**
 * A view on the page, as its `mount` returned it. A new view object given to `update`, equal or not,
 * is an open of the view: show it afresh (read it again, reveal its lines).
 */
export interface MountedView<V extends View = View, C = WorkspaceContext> {
  /** Without it, the host disposes the view and mounts it again for a new view or context. */
  update?(view: V, context: C): void;
  /** Stops what the view runs. Afterwards the host empties the target. */
  dispose?(): void;
}

/**
 * One way to show a view. `mount` draws the view into `target`, an element the host made for it,
 * whose children are the view's until it is disposed: when the target leaves the page, or the view
 * or its presentation goes. The host never mounts a target twice without a dispose between.
 * Any framework fits: React's `createRoot`, Svelte's and Vue's `mount`, Solid's `render`.
 */
export interface ViewPresentation<V extends View = View, C = WorkspaceContext> {
  mount(target: HTMLElement, view: V, context: C): MountedView<V, C> | void;
}

/** A view in a pane, such as an Inspector tab, with the tab's title, description (its tooltip) and icon. */
export interface PanePresentation<V extends View = View> extends ViewPresentation<V, WorkspaceContext> {
  title(view: V): string;
  description(view: V): string;
  /**
   * Draws the tab's icon, with the same lifecycle as a view. Its target is the icon's box, 14 px
   * square, with the tab's text color as `currentColor`: draw to fill it.
   */
  icon: ViewPresentation<V, WorkspaceContext>;
  /**
   * The pane's width in px while the view is shown, until the user resizes it: then the user's width
   * is kept for the view's name. 320 when left out; a phone shows the pane full width.
   */
  width?: number;
}

/**
 * How the host can show a view, by presentation. A container offers one (the Inspector shows views
 * in a `pane`); message decorations show theirs `inline`. A view without the presentation a place
 * needs is unavailable there.
 */
export interface ViewRenderer<V extends View = View> {
  /**
   * What tells views of this name apart: two views whose keys are equal are the same view, so opening
   * one focuses and replaces the other (a file's lines and mode only move within its tab). Without
   * it, the name has one view.
   */
  key?(view: V): string;
  pane?: PanePresentation<V>;
  /**
   * In place of a piece of message text, which the view controls completely: it may draw the text
   * (`context.original()`), change it or draw something else. The text stays until it mounts.
   */
  inline?: ViewPresentation<V, InlineContext>;
}

export interface Views {
  /**
   * Registers the renderer of a view name. A name has one renderer, and a renderer has at least
   * one presentation; otherwise it throws. The host trusts that views named `name` are its `ViewTypes` entry.
   */
  register<K extends keyof ViewTypes>(name: K, renderer: ViewRenderer<ViewTypes[K]>): Disposer;
}

// ---------------------------------------------------------------------------
// The workspace
// ---------------------------------------------------------------------------

/** A container of the workspace, by ID; later layouts add IDs. The Inspector shows views in a `pane`. */
export type ContainerId = "inspector";

export interface OpenOptions {
  /** The container; the Inspector when left out. */
  in?: ContainerId;
}

export interface Workspace {
  /**
   * Shows a view in a container of the workspace: the same view (`ViewRenderer.key`) already open
   * there is focused and replaced by this one, otherwise it opens after the others. On a phone the
   * workspace on screen moves to the container's page.
   */
  open(view: KnownView, options?: OpenOptions): void;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** A piece of prose, `text.slice(start, end)`, and the view shown in its place. */
export interface DecorationSpan {
  start: number;
  end: number;
  view: KnownView;
}

/**
 * Finds pieces of completed message text and names the view shown in place of each, in its `inline`
 * presentation (`ViewRenderer.inline`). The host decides where decorating may happen (prose and whole
 * inline-code spans; never code blocks, HTML, links, images or a message still streaming), and leaves
 * a piece's text as it is where its view has no inline presentation. Finding pieces happens while
 * messages render, so it answers synchronously from what it has, and says when that changes.
 */
export interface MessageDecorator {
  /** The pieces of some prose to decorate, in order and not overlapping. */
  decorate(text: string, context: WorkspaceContext): DecorationSpan[];
  /** The view shown in place of a whole inline-code span, or null. */
  decorateCode?(code: string, context: WorkspaceContext): KnownView | null;
  /** Listens for what it decorates from changing; the host then decorates messages again. */
  onChange(listener: () => void): Disposer;
}

export interface Messages {
  /** Registers a decorator. A piece has one view: where decorators overlap, the earlier registered wins. */
  registerDecorator(decorator: MessageDecorator): Disposer;
}

// ---------------------------------------------------------------------------
// The SDK
// ---------------------------------------------------------------------------

/** What app-shell gives each built-in's register function. */
export interface ReinsSdk {
  readonly files: Files;
  readonly workspace: Workspace;
  readonly views: Views;
  readonly messages: Messages;
}
