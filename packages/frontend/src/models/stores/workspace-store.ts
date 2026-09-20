import { openInBrowserEvent } from "../../components/events.js";
import { toRelativePath } from "../path-utils.js";
import type { AppStore } from "./app-store.js";
import { ActiveSessionStore } from "./active-session-store.js";
import { CodeReviewStore } from "./code-review-store.js";
import { DiffStore } from "./diff-store.js";
import type { ProjectStore } from "./project-store.js";

const FILE_MODIFYING_TOOLS = new Set(["write", "edit", "bash"]);

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

  private active: ActiveSessionStore | null = null;
  private listeners = new Set<WorkspaceStoreListener>();
  private unsubscribers: Array<() => void> = [];
  private unsubscribeActive: (() => void) | null = null;
  private transition = 0;
  private disposed = false;

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
          const projectId = this.projectId;
          if (projectId == null) return;
          const path = toRelativePath(message.path, this.projectDir);
          if (!path) return;
          document.dispatchEvent(openInBrowserEvent(projectId, path, lineRange));
        },
        event: (message) => {
          if (message.sessionId !== this.sessionId) return;
          const filesChanged =
            (message.event.type === "tool_execution_end" && FILE_MODIFYING_TOOLS.has(message.event.toolName))
            || message.event.type === "agent_end";
          if (filesChanged) setTimeout(() => this.diffStore.refresh({ trigger: "websocket" }), 500);
        },
      }),
      app.registerReconciler(() => Promise.allSettled([
        this.active?.refreshFromServer(),
        this.codeReviewStore.refresh(),
      ])),
      this.diffStore.subscribe(() => this.notify()),
      this.codeReviewStore.subscribe(() => this.notify()),
    ];
  }

  get activeSessionStore(): ActiveSessionStore | null { return this.active; }
  get sessionId(): string { return this.active?.sessionId ?? ""; }
  get projectId(): number | null { return this.active?.projectId ?? null; }
  get projectDir(): string | null {
    const projectId = this.projectId;
    return projectId == null
      ? null
      : this.app.projects.find((project) => project.id === projectId)?.path ?? null;
  }
  get activeProjectStore(): ProjectStore | null {
    const projectId = this.projectId;
    return projectId == null ? null : this.app.projectsStore.peekStore(projectId) ?? null;
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
    if (this.active) this.unsubscribeActive = this.active.subscribe(() => this.notify());

    // The old diff/review may never coexist with the newly selected session.
    this.diffStore.setScope(null, null);
    void this.codeReviewStore.setScope(null);
    this.notify();

    const active = this.active;
    if (!active) return;

    await active.initialize();
    if (!this.isCurrent(transition, active)) return;

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
  createProject(data: { name: string; path: string; base_branch: string }) {
    return this.app.projectsStore.createProject(data);
  }
  updateProject(projectId: number, data: { name: string; path: string; base_branch: string }) {
    return this.app.projectsStore.updateProject(projectId, data);
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

  private isCurrent(transition: number, active: ActiveSessionStore): boolean {
    return !this.disposed && transition === this.transition && this.active === active;
  }

  private notify(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}
