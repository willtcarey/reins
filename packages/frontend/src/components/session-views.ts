/**
 * A session in the main area: its Chat and its Changes, two views that are tabs of the session (workspace-inspector.md
 * slice 5), and their toolbar. App code: Chat over the workspace's store, which the workspace registers it with while
 * it is connected, again for each `WorkspaceStore`; Changes and the toolbar over their session's diff (`app.diffs`).
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type { Disposer, PanePresentation, Subject, TabOf, Views } from "@reins/sdk";
import { StoreController } from "../controllers/store-controller.js";
import type { SessionDiff, SessionDiffs } from "../models/stores/session-diffs.js";
import type { WorkspaceStore } from "../models/stores/workspace-store.js";
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

/** The session, then its task and project once the workspace has its details (not while it still shows another). */
function subjectOf(workspace: WorkspaceStore, sessionId: string): Subject[] {
  const active = workspace.activeSessionStore;
  if (active?.sessionId !== sessionId) return [{ type: "session", id: sessionId }];
  return [{ type: "session", id: sessionId }, ...taskAndProject(active.projectId, active.sessionData.taskId)];
}

/** The workspace's session's conversation, which follows the workspace's store. */
@customElement("session-chat-pane")
export class SessionChatPane extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private stores = new StoreController<WorkspaceStore>(this);
  @property({ attribute: false }) visible = true;

  set workspace(workspace: WorkspaceStore | null) { this.stores.store = workspace; }
  get workspace(): WorkspaceStore | null { return this.stores.store; }

  override render() {
    const store = this.workspace;
    const session = store?.activeSessionStore;
    if (!store || !session) return nothing;
    const parentSessionId = session.sessionData.parentSessionId;
    return keyed(store.sessionId, html`
      <chat-panel
        class="block h-full min-h-0 min-w-0"
        .store=${session}
        .projectStore=${store.activeProjectStore}
        .parentSession=${parentSessionId ? store.activeProjectStore?.getSession(parentSessionId) ?? null : null}
        .runningChildSessions=${store.activeProjectStore?.runningChildSessionsFor(store.sessionId) ?? []}
        .source=${store.source}
        .skills=${store.app.locationSkills}
        .decorators=${store.app.decorators}
        .commands=${store.app.commands}
        .sendHandoff=${store.app.sendHandoff}
        ?visible=${this.visible}
      ></chat-panel>
    `);
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
function changesSubject(diff: SessionDiff, file: string | null): Subject[] {
  const { source, sessionId } = diff;
  const reviewed: Subject[] = file && source ? [{ type: "file", id: { source, path: file } }] : [];
  return [...reviewed, { type: "session", id: sessionId }, ...taskAndProject(diff.projectId, diff.taskId)];
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
function pinChanges(workspace: WorkspaceStore): Disposer {
  return workspace.app.inspector.pin({ view: "diff-file-tree" });
}

/** Registers the session's Chat (over a workspace's store) and Changes (over the app's sessions' diffs). */
export function registerSessionViews(views: Views, workspace: WorkspaceStore): Disposer {
  const diffs = workspace.app.diffs;
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
        // It follows the workspace's store, so a new view only changes its subject.
        mount(target, view) {
          let shown = view;
          const pane = target.ownerDocument.createElement("session-chat-pane");
          pane.setAttribute("class", "block h-full min-h-0 min-w-0");
          pane.workspace = workspace;
          target.append(pane);
          const unpin = pinChanges(workspace);
          return {
            update: (next) => { shown = next; },
            setVisible: (visible) => { pane.visible = visible; },
            subject: () => subjectOf(workspace, shown.sessionId),
            dispose: () => {
              unpin();
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
          const unpin = pinChanges(workspace);
          return {
            update: (next, nextContext) => {
              shownContext = nextContext;
              if (used.follow(next.sessionId)) pane.diff = used.diff;
              open(next);
            },
            setVisible: (visible) => { pane.visible = visible; },
            subject: () => changesSubject(used.diff, pane.activeFile),
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
