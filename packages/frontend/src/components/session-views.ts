/**
 * A session in the main area: its Chat and its Changes, two views that are tabs of the session (workspace-inspector.md
 * slice 5), and their toolbar. App code, which app-shell registers for the app's lifetime: each view finds its session's
 * state from its own view, Chat its session's store and Changes and the toolbar its session's diff (`app.diffs`).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { sameSource, type Disposer, type PanePresentation, type Source, type Subject, type TabOf, type Views } from "@reins/sdk";
import { StoreController } from "../controllers/store-controller.js";
import type { SessionDiff, SessionDiffs } from "../models/stores/session-diffs.js";
import { ActiveSessionStore } from "../models/stores/active-session-store.js";
import type { AppStore } from "../models/stores/app-store.js";
import { conversationIcon, diffIcon, paneIcon } from "../ui/icons.js";
import { openFileBrowserEvent } from "./events.js";
import "./branch-indicator.js";
import "./chat-panel.js";
import "./changes/review-diff-panel.js";
import "./nav-icon.js";

/** A session's conversation: its Chat tab, at the session's route. */
export type SessionView = { view: "session"; sessionId: string };
/** A session's changes, its diff and review: its Changes tab; `file`, the file it is opened at, which it reveals. */
export type SessionChangesView = { view: "session-changes"; sessionId: string; file?: string };

declare module "@reins/sdk" {
  interface ViewTypes {
    session: SessionView;
    "session-changes": SessionChangesView;
  }
  /** What a session's views are about (`workspace.current()`): its session, its task and its project. */
  interface SubjectTypes {
    project: number;
    task: number;
    session: string;
  }
}

function taskAndProject(projectId: number | null, taskId: number | null): Subject[] {
  if (projectId == null) return [];
  return taskId == null ? [{ type: "project", id: projectId }] : [{ type: "task", id: taskId }, { type: "project", id: projectId }];
}

/** The session, then its task and project once the app has its details. */
function sessionSubject(app: AppStore, sessionId: string): Subject[] {
  const detail = app.sessionCache.getDetail(sessionId);
  return [{ type: "session", id: sessionId }, ...taskAndProject(detail?.projectId || null, detail?.taskId ?? null)];
}

/**
 * The conversation of one session, while the Chat shows it: its active session store, refreshed on reconnect, and its
 * project loaded for the chat's parent and child sessions.
 */
class ChatSession {
  readonly store: ActiveSessionStore;
  private unreconcile: Disposer;

  constructor(app: AppStore, sessionId: string) {
    this.store = new ActiveSessionStore(sessionId, app.client, app.sessionCache, app.activeConversationsStore, app.sessionOperations);
    this.unreconcile = app.registerReconciler(() => this.store.refreshFromServer());
    void this.store.initialize().then(() => {
      const projectId = this.store.projectId;
      if (projectId != null) void app.projectsStore.ensureLoaded(projectId);
    });
  }

  dispose(): void {
    this.unreconcile();
    this.store.dispose();
  }
}

/** A session's conversation, over its own session store. */
@customElement("session-chat-pane")
export class SessionChatPane extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private sessions = new StoreController<ActiveSessionStore>(this);
  /** The app's projects and connection, which the parent and running children come from. */
  private apps = new StoreController<AppStore>(this);
  @property({ attribute: false }) visible = true;

  set session(session: ActiveSessionStore | null) { this.sessions.store = session; }
  get session(): ActiveSessionStore | null { return this.sessions.store; }
  set app(app: AppStore | null) { this.apps.store = app; }
  get app(): AppStore | null { return this.apps.store; }

  override render() {
    const { app, session } = this;
    if (!app || !session) return nothing;
    const projectId = session.projectId;
    const projectStore = projectId == null ? null : app.projectsStore.peekStore(projectId) ?? null;
    const parentSessionId = session.sessionData.parentSessionId;
    const placement = session.sessionData.placement;
    return keyed(session, html`
      <chat-panel
        class="block h-full min-h-0 min-w-0"
        .store=${session}
        .projectStore=${projectStore}
        .parentSession=${parentSessionId ? projectStore?.getSession(parentSessionId) ?? null : null}
        .runningChildSessions=${projectStore?.runningChildSessionsFor(session.sessionId) ?? []}
        .source=${placement?.path ? this.sourceOf(placement.nodeId, placement.path) : null}
        .skills=${app.locationSkills}
        .decorators=${app.decorators}
        .commands=${app.commands}
        .sendHandoff=${app.sendHandoff}
        ?visible=${this.visible}
      ></chat-panel>
    `);
  }

  private source: Source | null = null;

  /** The same object while the session's checkout is, so the chat is not updated by every render. */
  private sourceOf(nodeId: string, path: string): Source {
    const source = { nodeId, path };
    if (!sameSource(this.source, source)) this.source = source;
    return this.source ?? source;
  }
}

/** The session's diff shown: that of the view's session, which an update to another session swaps. */
class UsedDiff {
  private used: ReturnType<SessionDiffs["use"]>;

  constructor(private readonly cache: Pick<SessionDiffs, "use">, sessionId: string) {
    this.used = cache.use(sessionId);
  }

  get diff(): SessionDiff { return this.used.diff; }

  /** Whether it moved to another session's. */
  follow(sessionId: string): boolean {
    if (sessionId === this.used.diff.sessionId) return false;
    this.used.release();
    this.used = this.cache.use(sessionId);
    return true;
  }

  release(): void { this.used.release(); }
}

/** What a session's Changes is about: the file its review is on, the session, then its task and project once known. */
function changesSubject(app: AppStore, diff: SessionDiff, file: string | null): Subject[] {
  const { source, sessionId } = diff;
  const reviewed: Subject[] = file && source ? [{ type: "file", id: { source, path: file } }] : [];
  return [...reviewed, ...sessionSubject(app, sessionId)];
}

/** A session's diff and review, for its project. */
@customElement("session-changes-pane")
export class SessionChangesPane extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private stores = new StoreController<SessionDiff>(this);
  @property({ attribute: false }) visible = true;
  /** The file the review was opened at, a new object each open, which the review reveals. */
  @property({ attribute: false }) reveal: { path: string } | null = null;
  /** The file the review is on. */
  activeFile: string | null = null;
  /** Told when the review moves to another file, which the view is about. */
  subjectChanged: () => void = () => {};

  set diff(diff: SessionDiff | null) {
    if (diff !== this.stores.store) this.activeFile = null;
    this.stores.store = diff;
  }
  get diff(): SessionDiff | null { return this.stores.store; }

  override render() {
    const diff = this.diff;
    if (!diff || diff.projectId == null) return nothing;
    return keyed(diff, html`
      <review-diff-panel
        class="block h-full min-h-0 min-w-0"
        .store=${diff.files}
        .reviewStore=${diff.review}
        .source=${diff.source}
        .sessionId=${diff.sessionId}
        .visible=${this.visible}
        .reveal=${this.reveal}
        @active-file-change=${(event: CustomEvent<string | null>) => {
          if (event.detail === this.activeFile) return;
          this.activeFile = event.detail;
          this.subjectChanged();
        }}
      ></review-diff-panel>
    `);
  }
}

/** A session's tools in the host's toolbar, beside its tabs: its files and its branch. */
@customElement("session-toolbar")
export class SessionToolbar extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private stores = new StoreController<SessionDiff>(this);

  set diff(diff: SessionDiff | null) { this.stores.store = diff; }
  get diff(): SessionDiff | null { return this.stores.store; }

  override render() {
    const diff = this.diff;
    return html`
      <nav-icon icon="folder" label="Browse files" .size=${18}
        @click=${() => {
          const source = diff?.source;
          if (source) this.dispatchEvent(openFileBrowserEvent(source));
        }}></nav-icon>
      <div class="min-w-0 flex-1 overflow-hidden flex justify-end">
        <branch-indicator class="block min-w-0 max-w-full" .currentBranch=${diff?.files.branch ?? null}></branch-indicator>
      </div>
    `;
  }
}

/** Pins the Inspector's Changes tab while a session's tab is mounted, so every view of a session has it, and a page not. */
function pinChanges(app: AppStore): Disposer {
  return app.inspector.pin({ view: "diff-file-tree" });
}

/** Registers the session's Chat and Changes, each over its own session's state in the app. */
export function registerSessionViews(views: Views, app: AppStore): Disposer {
  const diffs = app.diffs;
  const toolbar: PanePresentation<SessionView | SessionChangesView>["toolbar"] = {
    mount(target, view) {
      const tools = target.ownerDocument.createElement("session-toolbar");
      tools.setAttribute("class", "flex min-w-0 flex-1 items-center gap-1.5");
      const used = new UsedDiff(diffs, view.sessionId);
      tools.diff = used.diff;
      target.append(tools);
      return {
        update: (next) => {
          if (used.follow(next.sessionId)) tools.diff = used.diff;
        },
        dispose: () => {
          used.release();
          tools.remove();
        },
      };
    },
  };
  const tabOf: TabOf = { type: "session", parameter: "sessionId" };
  const disposers = [
    views.register("session", {
      key: (view) => view.sessionId,
      tabOf,
      pane: {
        title: () => "Chat",
        description: () => "The session's conversation",
        icon: paneIcon(conversationIcon),
        toolbar,
        mount(target, view) {
          const pane = target.ownerDocument.createElement("session-chat-pane");
          pane.setAttribute("class", "block h-full min-h-0 min-w-0");
          pane.app = app;
          let chat = new ChatSession(app, view.sessionId);
          pane.session = chat.store;
          target.append(pane);
          const unpin = pinChanges(app);
          return {
            update: (next) => {
              if (next.sessionId === chat.store.sessionId) return;
              chat.dispose();
              chat = new ChatSession(app, next.sessionId);
              pane.session = chat.store;
            },
            setVisible: (visible) => { pane.visible = visible; },
            subject: () => sessionSubject(app, chat.store.sessionId),
            dispose: () => {
              unpin();
              chat.dispose();
              pane.remove();
            },
          };
        },
      },
    }),
    views.register("session-changes", {
      key: (view) => view.sessionId,
      tabOf,
      pane: {
        title: () => "Changes",
        description: () => "The session's changes and review",
        icon: paneIcon(diffIcon),
        toolbar,
        mount(target, view, context) {
          let shownContext = context;
          const pane = target.ownerDocument.createElement("session-changes-pane");
          pane.setAttribute("class", "block h-full min-h-0 min-w-0");
          const used = new UsedDiff(diffs, view.sessionId);
          pane.diff = used.diff;
          pane.subjectChanged = () => shownContext.subjectChanged();
          // Each open at a file reveals it, even the file revealed last.
          const open = (shown: SessionChangesView) => { if (shown.file) pane.reveal = { path: shown.file }; };
          open(view);
          target.append(pane);
          const unpin = pinChanges(app);
          return {
            update: (next, nextContext) => {
              shownContext = nextContext;
              if (used.follow(next.sessionId)) pane.diff = used.diff;
              open(next);
            },
            setVisible: (visible) => { pane.visible = visible; },
            subject: () => changesSubject(app, used.diff, pane.activeFile),
            dispose: () => {
              unpin();
              used.release();
              pane.remove();
            },
          };
        },
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

declare global {
  interface HTMLElementTagNameMap {
    "session-chat-pane": SessionChatPane;
    "session-changes-pane": SessionChangesPane;
    "session-toolbar": SessionToolbar;
  }
}
