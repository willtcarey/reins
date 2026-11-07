/**
 * A session's diff: its changed files and patch, and the review of them, for the views that show them (the session's
 * Changes, the Inspector's changed-files tree, the session's toolbar). Each view asks for its session's
 * (`SessionDiffs.use`), so two views of one session share one answer from the server, and one view needs no other
 * (workspace-inspector.md slice 6).
 */

import { sameSource, type Disposer, type Source } from "@reins/sdk";
import type { AppStore } from "./app-store.js";
import { CodeReviewStore } from "./code-review-store.js";
import { DiffStore } from "./diff-store.js";

/** What an entry needs of the app: the session's details, its project's tasks, and the server's news. */
export type SessionDiffsHost = Pick<AppStore, "sessionCache" | "projectsStore" | "client" | "files" | "registerReconciler">;

export class SessionDiff {
  /**
   * The diff of the session's checkout, against its task's branch. What it shows (branch or uncommitted changes) is
   * the session's while the entry lives: both views read it, so they agree.
   */
  readonly files = new DiffStore();
  /** The review of the session's task, or its project's for no task; unscoped for a session of no project. */
  readonly review = new CodeReviewStore();

  private disposed = false;
  private listeners = new Set<() => void>();
  private disconnects: Disposer[];

  constructor(readonly sessionId: string, private readonly app: SessionDiffsHost) {
    this.disconnects = [
      app.sessionCache.subscribe(sessionId, () => this.notify()),
      app.client.subscribe({
        code_review_updated: ({ projectId, taskId, reviewId, revision }) => {
          void this.review.handleUpdated({ projectId, taskId, reviewId, revision });
        },
      }),
      app.files.onFilesChanged((source) => {
        if (sameSource(this.source, source)) void this.files.refresh({ trigger: "websocket" });
      }),
      app.registerReconciler(() => this.review.refresh()),
      this.files.subscribe(() => this.notify()),
      this.review.subscribe(() => this.notify()),
    ];
    void this.scope();
  }

  private lastSource: Source | null = null;

  /**
   * The session's checkout, once its details are known: the same object while it stays the same, so the views given
   * it (the review and each of its files) do not draw again on every notify.
   */
  get source(): Source | null {
    const placement = this.app.sessionCache.getDetail(this.sessionId)?.placement;
    const source = placement?.path ? { nodeId: placement.nodeId, path: placement.path } : null;
    if (!sameSource(this.lastSource, source)) this.lastSource = source;
    return this.lastSource;
  }

  get projectId(): number | null {
    return this.app.sessionCache.getDetail(this.sessionId)?.projectId || null;
  }

  get taskId(): number | null {
    return this.app.sessionCache.getDetail(this.sessionId)?.taskId ?? null;
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    for (const disconnect of this.disconnects) disconnect();
    this.files.dispose();
    void this.review.setScope(null);
    this.listeners.clear();
  }

  /** Scopes the diff and the review once the session's details and its task's branch are known, so it fetches once. */
  private async scope(): Promise<void> {
    const detail = this.app.sessionCache.getDetail(this.sessionId) ?? await this.app.sessionCache.fetchDetail(this.sessionId);
    if (this.disposed || !detail) return;
    const projectId = detail.projectId || null;
    const taskId = detail.taskId ?? null;
    if (projectId != null) {
      await this.app.projectsStore.ensureLoaded(projectId);
      if (this.disposed) return;
    }
    const branch = projectId == null || taskId == null
      ? null
      : this.app.projectsStore.peekStore(projectId)?.findTask(taskId)?.branch_name ?? null;
    this.files.setScope(this.sessionId, branch, projectId);
    if (projectId != null) void this.review.setScope({ projectId, taskId });
  }

  private notify(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }
}

/** One `SessionDiff` per session while a view uses it, on `AppStore`; dropped when the last user releases it. */
export class SessionDiffs {
  private entries = new Map<string, { diff: SessionDiff; users: number }>();

  constructor(private readonly app: SessionDiffsHost) {}

  use(sessionId: string): { diff: SessionDiff; release: Disposer } {
    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { diff: new SessionDiff(sessionId, this.app), users: 0 };
      this.entries.set(sessionId, entry);
    }
    entry.users += 1;
    const used = entry;
    let released = false;
    return {
      diff: used.diff,
      release: () => {
        if (released) return;
        released = true;
        used.users -= 1;
        if (used.users > 0) return;
        this.entries.delete(sessionId);
        used.diff.dispose();
      },
    };
  }

  dispose(): void {
    for (const { diff } of this.entries.values()) diff.dispose();
    this.entries.clear();
  }
}
