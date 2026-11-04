/**
 * The Reins SDK, `@reins/sdk`: everything a built-in feature may use (docs/dev/reins-sdk.md). It
 * imports nothing from the app, so it can become a package of its own; its values are Reins values,
 * never templates, markup, stores or transport types. The one DOM value is the element the host
 * gives a view or a Settings page to mount into (ADR-030). The app's side of it is in `sdk-host/`.
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
 * A source's files: any directory on a node, named by the node and its path, whether or not a session
 * works there. Reads go to the server, which says when the node cannot be reached.
 */
export interface Files {
  /**
   * The source's listing, synchronously, so it can be read while rendering: loaded the first time it
   * is asked for and cached for the two sources asked for last. After the source's files may have
   * changed or its node comes back, `subscribe` listeners are told and the next ask reloads it, so
   * ask again on hearing that. Empty (no data, not loading) for a null source and while its node is
   * offline or removed. A reload that finds the same files keeps the same `data` array.
   */
  listing(source: Source | null): FileListing;
  /** Listens for any listing changing, including a source's node going offline or coming back, and node names changing. */
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
  /** Where the browser loads a file itself (images, PDFs, downloads). */
  contentUrl(source: Source, path: string, options?: { download?: boolean }): string;
  /**
   * Writes files into `folder` of the source (`.`, its root, by default), replacing files of the same names,
   * reporting how much is sent (0–100); then announces its files changed. Resolves with the names written.
   * Rejects with an Error whose message can be shown: an unknown node, an offline node, a folder outside it.
   */
  upload(source: Source, files: FileList | readonly File[], options?: { folder?: string; onProgress?: (percent: number) => void }): Promise<string[]>;
  /** The name of the source's node, to show where a file is; null until the host knows it. */
  nodeName(source: Source): string | null;
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
  /** `context` is the workspace the pane is in, for a title that says how the view differs from it. */
  title(view: V, context: WorkspaceContext): string;
  description(view: V, context: WorkspaceContext): string;
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

/**
 * A container of the workspace, by ID; later layouts add IDs. The Inspector shows views in a `pane`.
 * The main area shows one view at a time, the page of a route, so opening a view there navigates
 * (Back returns to the one before); for now it shows only the app's `session` view.
 */
export type ContainerId = "inspector" | "main";

export interface OpenOptions {
  /** The container; the Inspector when left out. */
  in?: ContainerId;
}

/**
 * The kinds of thing a view can be about, with the type of each one's ID. Empty here, as `ViewTypes` is:
 * the code whose views are about a kind adds it, `declare module "@reins/sdk" { interface SubjectTypes { session: string } }`.
 * It is only types: at runtime any `type` works.
 */
export interface SubjectTypes {}

/** One thing a view is about. */
export type Subject = { [K in keyof SubjectTypes]: { readonly type: K; readonly id: SubjectTypes[K] } }[keyof SubjectTypes];

/** The view a container shows now, and what it is about, most specific first. */
export interface CurrentView {
  readonly view: View;
  /** What the view knows now, so it can be read synchronously: a session's view is about only the session while its details load. */
  readonly subject: readonly Subject[];
}

export interface Workspace {
  /**
   * Shows a view in a container of the workspace. In the Inspector, the same view (`ViewRenderer.key`)
   * already open there is focused and replaced by this one, otherwise it opens after the others; on a
   * phone the workspace on screen moves to the Inspector's page. In the main area it navigates to the
   * view, and throws for a view the main area cannot show.
   */
  open(view: KnownView, options?: OpenOptions): void;
  /** The main area's view now; null on a page that is not a view (settings, a project's history, no session). */
  current(): CurrentView | null;
  /** The ID of the main area's most specific subject of `type` now, or null when it is about none. */
  currentSubject<K extends keyof SubjectTypes>(type: K): SubjectTypes[K] | null;
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
// Sessions
// ---------------------------------------------------------------------------

/** A session, as the agents' `api.sessions.get` gives it, in the SDK's camelCase. */
export interface Session {
  readonly id: string;
  /** Its project; null for a session of no project (which has no task). */
  readonly projectId: number | null;
  /** Its task; null for a conversation of its project's assistant. */
  readonly taskId: number | null;
  /** The session that started it as its child; null for one that is not a child. */
  readonly parentSessionId: string | null;
  /** Its explicit name; null when it has none. */
  readonly name: string | null;
  /** Where it runs. */
  readonly source: Source;
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** A new session. Only the project is required. */
export interface SessionCreation {
  readonly projectId: number;
  /** A task of the project; left out or null, a new conversation of the project's assistant. */
  readonly taskId?: number | null;
  /** A source of the project; its default source when left out. */
  readonly source?: Source;
  /** Its name; left out, it is named as any session is. */
  readonly title?: string;
  /** Its model; the default model setting's when left out. */
  readonly model?: { readonly provider: string; readonly modelId: string; readonly thinkingLevel?: ThinkingLevel };
  /** Submitted as its first message once it exists; its conversation shows it at once. */
  readonly prompt?: string;
}

/** Sessions by ID. Operations that reach the server reject with an Error whose message can be shown. */
export interface Sessions {
  /** The session, from the server. Rejects for a session it does not have. */
  get(sessionId: string): Promise<Session>;
  /**
   * Creates a session and resolves with its ID once it exists and its `prompt`, if given, was admitted.
   * It rejects a task or source of another project, a model the server does not have and a blank title,
   * and a prompt the server refused (the session then exists without it; its conversation shows why). It
   * does not show the session (`workspace.open({ view: "session", sessionId }, { in: "main" })`).
   */
  create(options: SessionCreation): Promise<string>;
  /**
   * Sends a message to the session, as the user. An idle session starts work on it; a running one takes it
   * into the work it is doing, without stopping. Its conversation shows it at once. Resolves once the
   * session admitted it, not when its work ends; rejects with the server's refusal, which the conversation
   * also shows in place of the message.
   */
  send(sessionId: string, message: string): Promise<void>;
  /**
   * Compacts the session's context now: its history so far is replaced by a summary, focused on
   * `instructions` when given. Resolves once the compaction started; the conversation shows it running
   * and the summary once it is done. Rejects while the session is running or has nothing to compact.
   */
  compact(sessionId: string, instructions?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface CommandContext {
  /** The message's text after the command's name, trimmed; empty when there is none. */
  readonly args: string;
}

/** What a message that starts with `/name` does instead of being sent. */
export interface Command {
  /** What follows the slash: lowercase letters, digits and hyphens, starting with a letter or digit. */
  readonly name: string;
  /** One line, shown with the command in the composer's suggestions. */
  readonly description: string;
  /**
   * Runs the command. What it acts on it reads from the SDK (`workspace.currentSubject`), before its
   * first `await`: by then the user may have gone to another page. One that cannot run there throws.
   * The composer is busy until it settles. Once it resolves, the composer clears the text; when it
   * rejects, the composer shows the error's message and keeps the text to try again.
   */
  run(context: CommandContext): void | Promise<void>;
}

export interface Commands {
  /**
   * Registers a command, run when a message starts with `/name` followed by a space, a line break or
   * nothing; there it wins over a skill of the same name. Elsewhere in a message `/name` stays text
   * (and a skill). The composer suggests it when `/` starts a message. A name has one command: a
   * second, or a name that cannot follow a slash, throws.
   */
  register(command: Command): Disposer;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** What a `mount` drew, as it returned it. */
export interface Mounted {
  /** Stops what it runs. Afterwards the host empties the target. */
  dispose?(): void;
}

/**
 * What the extension draws on its Settings page. The host owns the page: the extension's row in Settings'
 * sidebar (its label, description and icon) and a header; the extension draws everything under it.
 */
export interface SettingsPage {
  /**
   * Draws into `target`, an element the host made, when the page is shown; disposed when the page is left
   * or the registration is disposed. It loads its own data. A throw from `mount` is shown in its place, and
   * the rest of Settings keeps working.
   */
  mount(target: HTMLElement): Mounted | void;
}

export interface Settings {
  /** Gives the extension a Settings page. An extension has one at a time: a second registration throws. */
  register(page: SettingsPage): Disposer;
}

// ---------------------------------------------------------------------------
// The SDK
// ---------------------------------------------------------------------------

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

/**
 * A method of the extension's HTTP API, as its backend part declares it for `reins.http.handle` (`HttpApi` in
 * `@reins/sdk/server`, which this matches): what it takes and answers, as JSON Schema. A schema with a
 * `static` type (a TypeBox schema has one) types `reins.http.call`; any other gives `unknown`.
 */
export interface HttpMethod {
  readonly input?: object;
  readonly output?: object;
}

/** The extension's HTTP API: its methods by name. The frontend part imports only its type (`typeof api`). */
export type HttpApi = Readonly<Record<string, HttpMethod>>;

type SchemaType<S> = S extends { readonly static: infer T } ? T : unknown;

/** What a call of method `M` takes: its input when it has one, nothing when it has none, anything untyped. */
export type HttpCallArgs<M> = M extends { readonly input: infer S }
  ? [input: SchemaType<S>, options?: RequestOptions]
  : "input" extends keyof M ? [input?: unknown, options?: RequestOptions] : [input?: undefined, options?: RequestOptions];

/** What a call of method `M` resolves with: its output, nothing for a method without one, `unknown` untyped. */
export type HttpOutput<M> = M extends { readonly output: infer S }
  ? SchemaType<S>
  : "output" extends keyof M ? unknown : void;

/**
 * Calls the methods of the extension's HTTP API, typed by `A` when the register function names it
 * (`ReinsSdk<typeof api>`), else untyped. A call is `POST /api/extensions/<name>/<method>` with `input` as its
 * JSON body. It resolves with the method's output, undefined for a method that answers nothing, and rejects
 * with an Error whose message is the server's, with its HTTP `status` and decoded `body` (400 for input its
 * schema refuses), or as fetch does without an answer.
 */
export interface Http<A extends HttpApi = HttpApi> {
  call<K extends keyof A & string>(method: K, ...args: HttpCallArgs<A[K]>): Promise<HttpOutput<A[K]>>;
}

/** An extension, as the host registers it and shows it (Settings' sidebar row). */
export interface ExtensionInfo {
  /**
   * Its name: lowercase letters, digits and hyphens. An extension with a backend part has the same name
   * there, which is where its routes and messages are.
   */
  readonly name: string;
  readonly label: string;
  /** What its Settings page is for: the page's header, and its row on a phone. */
  readonly description?: string;
  /** Draws its icon into a 14 px box, in `currentColor`, with a Settings page's lifecycle. */
  readonly icon?: { mount(target: HTMLElement): Mounted | void };
}

/** A built-in extension: its info and its register function, which gets an SDK of its own. */
export interface ExtensionRegistration extends ExtensionInfo {
  register(reins: ReinsSdk): Disposer;
}

/**
 * What an extension's register function is given: an object of its own, which knows the extension, so
 * `http`, `onMessage` and `settings` are the extension's without it naming itself. `A` is its backend part's
 * HTTP API, which types `http.call`: `registerMcp(reins: ReinsSdk<McpApi>)`.
 */
export interface ReinsSdk<A extends HttpApi = HttpApi> {
  readonly files: Files;
  readonly workspace: Workspace;
  readonly views: Views;
  readonly messages: Messages;
  readonly commands: Commands;
  readonly sessions: Sessions;
  readonly settings: Settings;
  readonly http: Http<A>;
  /**
   * Listens for the extension's messages (its backend part's `broadcast`), each as it was sent; no other
   * extension's. The extension tells its kinds apart itself.
   */
  onMessage(listener: (message: object) => void): Disposer;
  /**
   * Listens for the server connection coming back after it was lost. Messages sent meanwhile are lost:
   * load again what was kept current from them.
   */
  onReconnect(listener: () => void): Disposer;
}
