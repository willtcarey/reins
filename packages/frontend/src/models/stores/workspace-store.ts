import { openInBrowserEvent } from "../../components/events.js";
import { Inspector, type OpenOptions, type View } from "../inspector.js";
import { toRelativePath } from "../path-utils.js";
import type { AppStore } from "./app-store.js";
import { ActiveSessionStore } from "./active-session-store.js";
import { CodeReviewStore } from "./code-review-store.js";
import { DiffStore } from "./diff-store.js";
import { FileModel } from "./file-model.js";
import { sameSource, type FileSource } from "./project-files.js";
import type { ProjectStore } from "./project-store.js";

export type WorkspaceStoreListener = () => void;

/**
 * Route-scoped workspace state and coordination.
 *
 * A transition owns its active session, diff scope, and review scope. Session
 * changes clear both scopes synchronously; resolved scopes are committed only
 * while that transition is still current.
 */
export class WorkspaceStore {
  readonly diffStore = new DiffStore();
  readonly codeReviewStore = new CodeReviewStore();
  readonly fileModel = new FileModel();

  // Tabs are kept per project while the page is open.
  private inspectors = new Map<number, Inspector>();
  private active: ActiveSessionStore | null = null;
  private listeners = new Set<WorkspaceStoreListener>();
  private unsubscribers: Array<() => void> = [];
  private unsubscribeActive: (() => void) | null = null;
  private transition = 0;
  private disposed = false;
  private _source: FileSource | null = null;

  constructor(readonly app: AppStore) {
    this.unsubscribers = [
      app.subscribe(() => this.notify()),
      app.client.subscribe({
        code_review_updated: (message) => {
          const { projectId, taskId, reviewId, revision } = message;
          void this.codeReviewStore.handleUpdated({ projectId, taskId, reviewId, revision });
        },
        open_file: (message) => {
          if (message.sessionId !== this.sessionId) return;
          const lineRange = message.startLine != null && message.endLine != null
            ? { startLine: message.startLine, endLine: message.endLine }
            : undefined;
          const source = this.source;
          if (!source) return;
          const path = toRelativePath(message.path, source.path);
          if (!path) return;
          document.dispatchEvent(openInBrowserEvent(source, path, lineRange));
        },
      }),
      app.files.onFilesChanged((source) => {
        if (!sameSource(this.source, source)) return;
        void this.diffStore.refresh({ trigger: "websocket" });
        void this.fileModel.refresh();
      }),
      app.registerReconciler(() => Promise.allSettled([
        this.active?.refreshFromServer(),
        this.codeReviewStore.refresh(),
      ])),
      this.diffStore.subscribe(() => this.notify()),
      this.codeReviewStore.subscribe(() => this.notify()),
      this.fileModel.subscribe(() => this.notify()),
      app.files.subscribe(() => this.notify()),
    ];
  }

  get activeSessionStore(): ActiveSessionStore | null { return this.active; }
  get sessionId(): string { return this.active?.sessionId ?? ""; }
  get projectId(): number | null { return this.active?.projectId ?? null; }
  /** The active session's source path, which absolute paths in its output are under. */
  get checkoutPath(): string | null {
    return this.active?.sessionData.placement.path || null;
  }

  /** The viewed session's source, once its details are known; the same object while it is unchanged. */
  get source(): FileSource | null {
    const projectId = this.projectId;
    const placement = this.active?.sessionData.placement;
    if (projectId == null || !placement?.path) return null;
    const available = placement.available && !placement.removed;
    const current = this._source;
    if (current?.projectId !== projectId || current.nodeId !== placement.nodeId || current.path !== placement.path || current.available !== available) {
      this._source = { projectId, nodeId: placement.nodeId, path: placement.path, available };
    }
    return this._source;
  }
  get activeProjectStore(): ProjectStore | null {
    const projectId = this.projectId;
    return projectId == null ? null : this.app.projectsStore.peekStore(projectId) ?? null;
  }

  /** The current project's Inspector. */
  get inspector(): Inspector | null {
    const projectId = this.projectId;
    if (projectId == null) return null;
    let inspector = this.inspectors.get(projectId);
    if (!inspector) {
      inspector = new Inspector();
      this.inspectors.set(projectId, inspector);
    }
    return inspector;
  }

  /** Shows a view in a container of the current project's workspace. */
  open(view: View, options: OpenOptions = {}): void {
    switch (options.in ?? "inspector") {
      case "inspector":
        this.inspector?.open(view);
        break;
    }
    this.notify();
  }

  focusInspectorTab(key: string): void {
    this.inspector?.focus(key);
    this.notify();
  }

  closeInspectorTab(key: string): void {
    this.inspector?.close(key);
    this.notify();
  }

  get connected() { return this.app.connected; }
  get projects() { return this.app.projects; }
  get projectsStore() { return this.app.projectsStore; }
  get settingsStore() { return this.app.settingsStore; }

  subscribe(listener: WorkspaceStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setSession(sessionId: string | null): Promise<void> {
    const nextSessionId = sessionId ?? "";
    if (nextSessionId === this.sessionId) return;

    const transition = ++this.transition;
    this.unsubscribeActive?.();
    this.unsubscribeActive = null;
    this.active?.dispose();
    this.active = nextSessionId
      ? new ActiveSessionStore(
          nextSessionId,
          this.app.client,
          this.app.sessionCache,
          this.app.activeConversationsStore,
        )
      : null;
    if (this.active) {
      this.unsubscribeActive = this.active.subscribe(() => {
        this.syncFileSource();
        this.notify();
      });
    }

    // The old diff/review may never coexist with the newly selected session.
    this.diffStore.setScope(null, null);
    void this.codeReviewStore.setScope(null);
    this.notify();

    const active = this.active;
    if (!active) return;

    await active.initialize();
    if (!this.isCurrent(transition, active)) return;
    this.syncFileSource();

    const projectId = active.projectId;
    if (projectId == null) return;
    await this.app.projectsStore.ensureLoaded(projectId);
    if (!this.isCurrent(transition, active)) return;

    const taskId = active.sessionData.taskId ?? null;
    const branch = taskId == null
      ? null
      : this.app.projectsStore.peekStore(projectId)?.findTask(taskId)?.branch_name ?? null;

    // Both stores synchronously adopt the same transition's scope before their
    // own async refreshes can complete.
    this.diffStore.setScope(projectId, branch);
    void this.codeReviewStore.setScope({ projectId, taskId });
    this.notify();
  }

  async updateTask(taskId: number, updates: { title?: string; description?: string | null }) {
    const projectId = this.projectId;
    if (projectId == null) return { error: "No project" } as const;
    return this.app.projectsStore.updateTask(projectId, taskId, updates);
  }

  async deleteTask(taskId: number) {
    const projectId = this.projectId;
    if (projectId == null) return { error: "No project" } as const;
    const result = await this.app.projectsStore.deleteTask(projectId, taskId);
    if ("ok" in result && this.active?.sessionData.taskId === taskId) await this.setSession(null);
    return result;
  }

  createSession(projectId: number) { return this.app.projectsStore.createSession(projectId); }
  createTaskSession(taskId: number, projectId: number) {
    return this.app.projectsStore.createTaskSession(taskId, projectId);
  }
  listNodes() { return this.app.projectsStore.listNodes(); }
  createProject(data: { name: string; path: string; nodeId: string; base_branch: string }) {
    return this.app.projectsStore.createProject(data);
  }
  updateProject(projectId: number, data: { name: string; base_branch: string }) {
    return this.app.projectsStore.updateProject(projectId, data);
  }
  listSources(projectId: number) { return this.app.projectsStore.listSources(projectId); }
  addSource(projectId: number, nodeId: string, path: string) {
    return this.app.projectsStore.addSource(projectId, nodeId, path);
  }
  moveSource(projectId: number, sourceId: number, path: string) {
    return this.app.projectsStore.moveSource(projectId, sourceId, path);
  }
  deleteProject(projectId: number) { return this.app.projectsStore.deleteProject(projectId); }
  generateTask(projectId: number, prompt: string) {
    return this.app.projectsStore.generateTask(projectId, prompt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.transition += 1;
    this.unsubscribeActive?.();
    this.active?.dispose();
    this.active = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.diffStore.dispose();
    void this.codeReviewStore.setScope(null);
    this.listeners.clear();
  }

  /** Files follow the viewed session's source once its details are known; until then the last source stays. */
  private syncFileSource(): void {
    const source = this.source;
    if (!source) return;
    this.fileModel.setSource({ projectId: source.projectId, nodeId: source.nodeId, checkoutPath: source.path, available: source.available });
  }

  private isCurrent(transition: number, active: ActiveSessionStore): boolean {
    return !this.disposed && transition === this.transition && this.active === active;
  }

  private notify(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}
