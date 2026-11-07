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
 * about something fixed names it (a file names its source); a view that follows the main area
 * reads `workspace.current()` instead.
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

/** What a message's decorations are shown for: the session of the message. */
export interface WorkspaceContext {
  /** The source of the message's session; null until it is known. */
  readonly source: Source | null;
}

/**
 * What a pane is given: the container it is shown in, so a view can fit its actions or layout to it (a file in the
 * Inspector offers to open in the file browser). Any container can show any pane. What the view shows is in the view
 * itself (a file's source and path); what the main area is about is `workspace.current()`.
 */
export interface PaneContext {
  readonly container: ContainerId;
  /**
   * Says that what the view is about (`MountedView.subject`) may have changed without the host showing anything
   * new, such as a review scrolled to another file: the host asks `subject()` again and tells `onDidChange`
   * listeners if it differs. Only the main area's view is asked, so elsewhere it does nothing.
   */
  subjectChanged(): void;
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
  /**
   * What the view is about now, most specific first (`Workspace.current`): a dashboard gives the session it has
   * in focus. Asked when something needs it, such as a command, so it answers synchronously from what the view
   * holds. Without it, the view is about nothing. Only the main area's view is asked, for now.
   */
  subject?(): readonly Subject[];
  /**
   * Told when its container hides it while it stays mounted (a main-area tab not shown, a page swiped away) and
   * when it shows it again; one mounted hidden is told at once. Without it, or until told, it is shown. A hidden
   * view may stop what only matters on screen (focusing, marking things read, loading).
   */
  setVisible?(visible: boolean): void;
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

/**
 * A view as a block of its own in a container: an Inspector tab, the main area's page (`workspace.open(view,
 * { in: "main" })`), and later a modal. One presentation for every container: the container draws its own
 * frame (a tab, a header, the browser tab's title) from the title, description and icon, and says which it is
 * in the context.
 */
export interface PanePresentation<V extends View = View> extends ViewPresentation<V, PaneContext> {
  /** `context` is where the pane is. */
  title(view: V, context: PaneContext): string;
  /** A tab's tooltip. */
  description(view: V, context: PaneContext): string;
  /**
   * Draws the view's icon (an Inspector tab's), with the same lifecycle as a view. Its target is the icon's
   * box, 14 px square, with the tab's text color as `currentColor`: draw to fill it.
   */
  icon: ViewPresentation<V, PaneContext>;
  /**
   * Draws the view's controls (a filter, a button) in the host's toolbar, in place of its title, with the same
   * lifecycle as a view; the host keeps the rest of the toolbar (the sidebar button, the connection status, its
   * menu). Only the main area shows it, for now. Without it the toolbar shows the title, and on a wide screen
   * the main area has no toolbar: the view fills it.
   */
  toolbar?: ViewPresentation<V, PaneContext>;
  /**
   * The Inspector's width in px while the view is shown there, until the user resizes it: then the user's width
   * is kept for the view's name. 320 when left out; a phone shows the pane full width. Other containers ignore it.
   */
  width?: number;
}

/**
 * Says that a view is one of the tabs of a kind of subject: with the main area showing it, the host shows a tab for
 * every view that is a tab of that kind, for the same subject (a session's Chat, its Changes, an extension's view
 * of a session), the app's first, then extensions' in the order they registered.
 */
export interface TabOf {
  readonly type: keyof SubjectTypes;
  /** The name of the view's parameter that holds the subject's ID; the host makes the other tabs' views with it alone. */
  readonly parameter: string;
}

/**
 * How the host can show a view, by presentation. Containers (the Inspector, the main area) show views
 * as a `pane`; message decorations show theirs `inline`. A view without the presentation a place
 * needs is unavailable there.
 */
export interface ViewRenderer<V extends View = View> {
  /**
   * What tells views of this name apart: two views whose keys are equal are the same view, so opening
   * one focuses and replaces the other (a file's lines and mode only move within its tab). Without
   * it, the name has one view.
   */
  key?(view: V): string;
  /** The tabs it is one of in the main area; without it, the view shows there alone. */
  tabOf?: TabOf;
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
 * A container of the workspace, by ID; later layouts add IDs. Both show a view's `pane`. The Inspector
 * shows views as tabs. The main area shows one view at a time, the page of a route the host derives
 * from the view, so opening a view there navigates (Back returns to the one before), and a reload or a
 * link shows the same view. The app's `session` view is shown there too.
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
   * view: a history entry, except that the same view (`ViewRenderer.key`) shown there now is replaced
   * by this one in place, and it throws for a view without a `pane` presentation (the Inspector shows
   * such a view as unavailable).
   */
  open(view: KnownView, options?: OpenOptions): void;
  /**
   * The main area's view now, and what it is about: a mounted view says it (`MountedView.subject`). Null on a page
   * that is not a view (settings, a project's history, no session).
   */
  current(): CurrentView | null;
  /** The ID of the main area's most specific subject of `type` now, or null when it is about none. */
  currentSubject<K extends keyof SubjectTypes>(type: K): SubjectTypes[K] | null;
  /** Listens for the main area's view, or what it is about, changing: read `current()` again on hearing it. */
  onDidChange(listener: () => void): Disposer;
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
// Projects, tasks and sessions
// ---------------------------------------------------------------------------

/**
 * What a session, a task or a project has that the user may want to see: `running` (work in progress), or
 * `unread` (its work finished with something the user has not opened yet); null when neither. A task or project
 * has its sessions': running when any of them runs, else unread when any of them is.
 */
export type Activity = "running" | "unread" | null;

export interface ProjectsChange {
  readonly projectIds: readonly number[];
}

export interface TasksChange {
  readonly projectIds: readonly number[];
}

export interface SessionsChange {
  readonly sessionIds: readonly string[];
  /** The projects the changed sessions were or are in; null for no project. */
  readonly projectIds: readonly (number | null)[];
}

/**
 * The host's projects, tasks and sessions are live: each read is synchronous, from what the host has loaded,
 * so it can be read while drawing. Each has an `onDidChange` event that says what changed, only when something
 * its reads give changed (not, say, a session's model), once for the changes of a moment. The event carries no
 * data: a listener that cares reads again. A listener may ignore what it does not show, or read again on any.
 */
export interface Project {
  readonly id: number;
  readonly name: string;
  readonly activity: Activity;
  /** The branch its tasks start from. */
  readonly baseBranch: string;
  /** Where its sessions work unless they inherit better; null when it has none. */
  readonly defaultSource: Source | null;
}

export interface ProjectCreation {
  readonly name: string;
  /** Its default source: a directory on a node, which must exist there. */
  readonly source: Source;
  /** Its base branch; found in the source when left out. */
  readonly baseBranch?: string;
}

export interface ProjectChanges {
  readonly name?: string;
  readonly baseBranch?: string;
  /** A new default source; its sessions stay where they are. */
  readonly defaultSource?: Source;
}

/** The projects. Operations that reach the server reject with an Error whose message can be shown. */
export interface Projects {
  /** Every project, by name. */
  list(): readonly Project[];
  /** Tells which projects were added, removed or changed (their name, activity, …), as `list()` gives them. */
  onDidChange(listener: (change: ProjectsChange) => void): Disposer;
  /** Creates a project and resolves with it. Rejects an unknown node or a path that is not a directory there. */
  create(project: ProjectCreation): Promise<Project>;
  update(projectId: number, changes: ProjectChanges): Promise<void>;
  /** Removes the project from Reins with its tasks and sessions (never files on disk). */
  remove(projectId: number): Promise<void>;
}

export interface Task {
  readonly id: number;
  readonly projectId: number;
  readonly title: string;
  readonly description: string | null;
  /** The branch its sessions work on. */
  readonly branchName: string;
  readonly closed: boolean;
  readonly updatedAt: string;
  readonly sessionCount: number;
  /** Lines its branch adds and removes against the project's base branch; null when not known. */
  readonly diffStats: { readonly additions: number; readonly removals: number } | null;
  readonly activity: Activity;
}

/** A project's tasks, loaded the first time they are asked for. */
export interface Tasks {
  /** The project's tasks, the latest changed first; empty until they load (asking loads them). */
  list(projectId: number): readonly Task[];
  /** Whether the project's tasks (and its assistant's conversations) loaded once. */
  loaded(projectId: number): boolean;
  /**
   * Tells which projects' tasks changed: a task added, removed or changed (its title, activity, diff, …), or the
   * tasks loaded. For a project the host has not loaded, it tells that its tasks may have changed (a task
   * closed elsewhere), with nothing to read until they are asked for.
   */
  onDidChange(listener: (change: TasksChange) => void): Disposer;
  /** Creates a task from what the user wants done: Reins writes its title, description and branch. */
  create(projectId: number, request: string): Promise<void>;
  update(projectId: number, taskId: number, changes: { readonly title?: string; readonly description?: string | null }): Promise<void>;
  /** Deletes the task, with its sessions. */
  remove(projectId: number, taskId: number): Promise<void>;
}

/** A node, where sessions run. */
export interface NodeSummary {
  readonly id: string;
  readonly name: string;
  readonly connected: boolean;
}

export interface Nodes {
  /** Every node that is not revoked, from the server. */
  list(): Promise<readonly NodeSummary[]>;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** A session, as the agents' `reins.sessions.get` (in `execute`) gives it, in the SDK's camelCase. */
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
  /** Running, or finished with something the user has not seen; null otherwise. */
  readonly activity: Activity;
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

/** A session as the host's session lists show it. */
export interface SessionSummary {
  readonly id: string;
  /** Its project; null for a session of no project (which has no task). */
  readonly projectId: number | null;
  /** Its task; null for a conversation of its project's assistant. */
  readonly taskId: number | null;
  /** The session that started it as its child; null for one that is not a child. */
  readonly parentSessionId: string | null;
  /** Its explicit name; null when it has none. */
  readonly name: string | null;
  /** The text of its first message; null before it has one, or when the host has not loaded it. */
  readonly firstMessage: string | null;
  readonly createdAt: string;
  /** When it last changed (a message, a run, a rename). */
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly activity: Activity;
  /** Pinned sessions are listed before the others. */
  readonly pinned: boolean;
  /** Archived sessions are left out of lists unless asked for. */
  readonly archived: boolean;
  /** The backend extension that started it, or null. */
  readonly startedBy: string | null;
  /** Where it runs, and its node's name; a removed node takes no work until the session moves. */
  readonly source: Source;
  readonly nodeName: string;
  readonly nodeRemoved: boolean;
}

/** Which sessions `Sessions.list` gives; every session the host shows when empty. */
export interface SessionQuery {
  /** A project's sessions, or (null) those of no project. */
  readonly projectId?: number | null;
  /** With a project: one task's sessions, or (null) its assistant's conversations. */
  readonly taskId?: number | null;
  /** Archived sessions too; left out otherwise. */
  readonly archived?: boolean;
}

/** A node a session can move to, with the paths its project's sessions used there. */
export interface SessionMoveTarget {
  readonly nodeId: string;
  readonly name: string;
  readonly connected: boolean;
  /** Whether the session is on it now. */
  readonly current: boolean;
  readonly paths: readonly string[];
}

/**
 * Sessions: by ID from the server, and live lists of the ones the host has (*Projects, tasks and sessions*).
 * Operations that reach the server reject with an Error whose message can be shown.
 */
export interface Sessions {
  /**
   * The sessions the host has that `query` asks for, pinned first, then the latest changed first. The host always
   * has every session with activity and those of no project; a project's assistant conversations
   * and a task's sessions load the first time a query names them (`{ projectId }`, `{ projectId, taskId }`).
   * Background sessions are never listed.
   */
  list(query?: SessionQuery): readonly SessionSummary[];
  /**
   * Tells which sessions appeared, went or changed as `list()` gives them (name, activity, time, …), and the
   * projects they were or are in (null: no project), so a list of one project can ignore the others.
   */
  onDidChange(listener: (change: SessionsChange) => void): Disposer;
  /** Marks an idle session read or unread; lists show it at once. A running session cannot be marked unread. */
  setUnread(sessionId: string, unread: boolean): Promise<void>;
  setPinned(sessionId: string, pinned: boolean): Promise<void>;
  setArchived(sessionId: string, archived: boolean): Promise<void>;
  /** Names the session; null or blank gives it no name. */
  setName(sessionId: string, name: string | null): Promise<void>;
  /** Every node it could move to, with why some cannot take it. */
  moveTargets(sessionId: string): Promise<readonly SessionMoveTarget[]>;
  /** Moves an idle session to a directory on a node; its tools run there from then on. */
  move(sessionId: string, to: Source): Promise<void>;
  /**
   * The session as the app has it now, kept current by the server's messages, so it resolves at once; one the app
   * has not loaded is asked of the server. Rejects for a session the server does not have.
   */
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
// The sidebar
// ---------------------------------------------------------------------------

/**
 * A part of the sidebar's body. The host owns the sidebar around it (its header, collapsing it, the collapsed
 * rail and its activity badge, the phone's sessions page) and where its sections are: the user orders them and
 * turns them on or off in Settings → Sidebar. A section draws only itself.
 */
export interface SidebarSection {
  /** What the user's order and switches remember it by: lowercase letters, digits and hyphens. One section has an ID. */
  readonly id: string;
  /** Its heading, which the host draws above it and Settings → Sidebar names it by; the ID when left out. */
  readonly title?: string;
  /**
   * Draws into `target`, an element the host made, while the section is shown; disposed when it is turned off,
   * the sidebar collapses or leaves the page, or the registration is disposed. A throw is shown in its place.
   */
  mount(target: HTMLElement): Mounted | void;
}

export interface Sidebar {
  /**
   * Adds a section. A new one is shown, after the sections the user has ordered, in registration order. A
   * second section of an ID, or an ID that is not lowercase letters, digits and hyphens, throws.
   */
  registerSection(section: SidebarSection): Disposer;
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/** The host's own dialogs for its things, so every extension acting on one asks the user the same way. */
export interface Ui {
  /**
   * Asks for the session's new name, its first message shown for a blank one, and saves it (a blank name:
   * none). Resolves true once saved, false when cancelled. A failed save is shown and the dialog stays open.
   * Rejects for a session the server does not have.
   */
  renameSession(sessionId: string): Promise<boolean>;
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
  readonly projects: Projects;
  readonly tasks: Tasks;
  readonly sessions: Sessions;
  readonly nodes: Nodes;
  readonly sidebar: Sidebar;
  readonly ui: Ui;
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
