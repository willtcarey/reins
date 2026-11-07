/**
 * A session in the main area: its Chat and its Changes, two views that are tabs of the session (workspace-inspector.md
 * slice 5), and their toolbar. App code over the workspace's stores, as the Changes tab of the Inspector is: the
 * workspace registers them while it is connected, again for each `WorkspaceStore`.
 */

import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import type { Disposer, PanePresentation, Subject, TabOf, Views } from "@reins/sdk";
import { StoreController } from "../controllers/store-controller.js";
import type { WorkspaceStore } from "../models/stores/workspace-store.js";
import { conversationIcon, diffIcon, paneIcon } from "../ui/icons.js";
import { openFileBrowserEvent } from "./events.js";
import "./branch-indicator.js";
import "./chat-panel.js";
import "./changes/review-diff-panel.js";
import "./nav-icon.js";

/** A session's conversation: its Chat tab, at the session's route. */
export type SessionView = { view: "session"; sessionId: string };
/** A session's changes, its diff and review: its Changes tab. */
export type SessionChangesView = { view: "session-changes"; sessionId: string };

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

/** The file the workspace's review of `sessionId` is on, first in what its Changes is about; none for another session's. */
function reviewedFile(workspace: WorkspaceStore, sessionId: string): Subject[] {
  const { source, diffStore } = workspace;
  if (workspace.sessionId !== sessionId || !source || !diffStore.activeFile) return [];
  return [{ type: "file", id: { source, path: diffStore.activeFile } }];
}

/** The workspace's session's diff and review, for its project. */
@customElement("session-changes-pane")
export class SessionChangesPane extends LitElement {
  override createRenderRoot() {
    return this;
  }

  private stores = new StoreController<WorkspaceStore>(this);
  @property({ attribute: false }) visible = true;
  /** Told when the review moves to another file, which the view is about. */
  subjectChanged: () => void = () => {};

  set workspace(workspace: WorkspaceStore | null) { this.stores.store = workspace; }
  get workspace(): WorkspaceStore | null { return this.stores.store; }

  override render() {
    const store = this.workspace;
    if (!store || store.projectId == null) return nothing;
    return keyed(store.projectId, html`
      <review-diff-panel
        class="block h-full min-h-0 min-w-0"
        .store=${store.diffStore}
        .reviewStore=${store.codeReviewStore}
        .source=${store.source}
        .sessionId=${store.sessionId}
        .visible=${this.visible}
        @active-file-change=${(event: CustomEvent<string | null>) => {
          store.diffStore.setActiveFile(event.detail);
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

  private stores = new StoreController<WorkspaceStore>(this);

  set workspace(workspace: WorkspaceStore | null) { this.stores.store = workspace; }
  get workspace(): WorkspaceStore | null { return this.stores.store; }

  override render() {
    const store = this.workspace;
    return html`
      <nav-icon icon="folder" label="Browse files" .size=${18}
        @click=${() => {
          if (store?.source) this.dispatchEvent(openFileBrowserEvent(store.source));
        }}></nav-icon>
      <div class="min-w-0 flex-1 overflow-hidden flex justify-end">
        <branch-indicator class="block min-w-0 max-w-full" .currentBranch=${store?.diffStore.branch ?? null}></branch-indicator>
      </div>
    `;
  }
}

type SessionPaneTag = "session-chat-pane" | "session-changes-pane";

/**
 * A tab of the session, drawn by `tag` over the workspace; it follows the workspace's store, so a new view only changes
 * its subject. While mounted it pins the Inspector's Changes tab, so every view of a session has it, and a page not.
 */
function sessionPane<V extends SessionView | SessionChangesView>(workspace: WorkspaceStore, tag: SessionPaneTag, toolbar: PanePresentation<V>["toolbar"], label: { title: string; description: string; icon: PanePresentation<V>["icon"] }): PanePresentation<V> {
  return {
    title: () => label.title,
    description: () => label.description,
    icon: label.icon,
    toolbar,
    mount(target, view, context) {
      let shown = view;
      const pane = target.ownerDocument.createElement(tag);
      pane.setAttribute("class", "block h-full min-h-0 min-w-0");
      pane.workspace = workspace;
      if (pane instanceof SessionChangesPane) pane.subjectChanged = () => context.subjectChanged();
      target.append(pane);
      const unpin = workspace.app.inspector.pin({ view: "diff-file-tree" });
      return {
        update: (next, nextContext) => {
          shown = next;
          context = nextContext;
        },
        setVisible: (visible) => { pane.visible = visible; },
        subject: () => [...(pane instanceof SessionChangesPane ? reviewedFile(workspace, shown.sessionId) : []), ...subjectOf(workspace, shown.sessionId)],
        dispose: () => {
          unpin();
          pane.remove();
        },
      };
    },
  };
}

/** Registers the session's Chat and Changes over a workspace's store. */
export function registerSessionViews(views: Views, workspace: WorkspaceStore): Disposer {
  const toolbar = {
    mount(target: HTMLElement) {
      const tools = target.ownerDocument.createElement("session-toolbar");
      tools.setAttribute("class", "flex min-w-0 flex-1 items-center gap-1.5");
      tools.workspace = workspace;
      target.append(tools);
      return { update: () => {}, dispose: () => tools.remove() };
    },
  };
  const tabOf: TabOf = { type: "session", parameter: "sessionId" };
  const disposers = [
    views.register("session", {
      key: (view) => view.sessionId,
      tabOf,
      pane: sessionPane<SessionView>(workspace, "session-chat-pane", toolbar, { title: "Chat", description: "The session's conversation", icon: paneIcon(conversationIcon) }),
    }),
    views.register("session-changes", {
      key: (view) => view.sessionId,
      tabOf,
      pane: sessionPane<SessionChangesView>(workspace, "session-changes-pane", toolbar, { title: "Changes", description: "The session's changes and review", icon: paneIcon(diffIcon) }),
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
