import { openInBrowserEvent } from "../../components/events.js";
import { sameSource, type Source } from "@reins/sdk";
import type { Inspector } from "../inspector.js";
import type { AppStore } from "./app-store.js";
import { ActiveSessionStore } from "./active-session-store.js";
import type { ProjectStore } from "./project-store.js";

export type WorkspaceStoreListener = () => void;

/**
 * Route-scoped workspace state and coordination.
 *
 * It follows the shown view's session for the session's Chat: its active session store. The session's diff and review
 * are the views' own (`app.diffs`).
 */
export class WorkspaceStore {
  private active: ActiveSessionStore | null = null;
  private listeners = new Set<WorkspaceStoreListener>();
  private unsubscribers: Array<() => void> = [];
  private unsubscribeActive: (() => void) | null = null;
  private disposed = false;
  private _source: Source | null = null;

  constructor(readonly app: AppStore) {
    this.unsubscribers = [
      app.subscribe(() => this.notify()),
      app.client.subscribe({
        open_file: (message) => {
          if (message.sessionId !== this.sessionId) return;
          const lineRange = message.startLine != null && message.endLine != null
            ? { startLine: message.startLine, endLine: message.endLine }
            : undefined;
          document.dispatchEvent(openInBrowserEvent(message.source, message.path, lineRange));
        },
      }),
      app.registerReconciler(() => this.active?.refreshFromServer()),
      app.inspector.subscribe(() => this.notify()),
    ];
  }

  get activeSessionStore(): ActiveSessionStore | null { return this.active; }
  get sessionId(): string { return this.active?.sessionId ?? ""; }
  get projectId(): number | null { return this.active?.projectId ?? null; }
  /** The viewed session's source, once its details are known; the same object while it is unchanged. */
  get source(): Source | null {
    const placement = this.active?.sessionData.placement;
    if (!placement?.path) return null;
    const source = { nodeId: placement.nodeId, path: placement.path };
    if (!sameSource(this._source, source)) this._source = source;
    return this._source;
  }
  get activeProjectStore(): ProjectStore | null {
    const projectId = this.projectId;
    return projectId == null ? null : this.app.projectsStore.peekStore(projectId) ?? null;
  }

  get inspector(): Inspector { return this.app.inspector; }

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

    this.unsubscribeActive?.();
    this.unsubscribeActive = null;
    this.active?.dispose();
    this.active = nextSessionId
      ? new ActiveSessionStore(
          nextSessionId,
          this.app.client,
          this.app.sessionCache,
          this.app.activeConversationsStore,
          this.app.sessionOperations,
        )
      : null;
    if (this.active) {
      this.unsubscribeActive = this.active.subscribe(() => this.notify());
    }

    this.notify();

    await this.active?.initialize();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeActive?.();
    this.active?.dispose();
    this.active = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.listeners.clear();
  }

  private notify(): void {
    if (this.disposed) return;
    this.app.inspector.setViewedSource(this.source);
    for (const listener of this.listeners) listener();
  }
}
