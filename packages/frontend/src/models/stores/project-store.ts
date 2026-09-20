/**
 * Project Store
 *
 * Holds the task collection and session list data for a single project. One instance per project,
 * lazily created by ProjectsStore.
 *
 * Activity state is NOT owned here — it lives in the shared SessionCache.
 * ProjectStore derives read-only activity selectors for rendering session-level dots.
 *
 * Components subscribe via `subscribe()` and read public state directly.
 */

import type { InjectedSkillInfo, SessionListItem } from "../ws-client.js";
import type { TaskListItem } from "../tasks.js";
import type { ActivityState, CachedSession, SessionCache, SessionPatch } from "./session-cache.js";

export type ProjectStoreListener = () => void;

type CachedSessionListItem = CachedSession & SessionListItem;

function isSessionListItem(session: CachedSession): session is CachedSessionListItem {
  return session.projectId != null &&
    session.createdAt != null &&
    session.updatedAt != null &&
    session.messageCount != null;
}

function compareSessionListItems(a: SessionListItem, b: SessionListItem): number {
  const pinned = Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null);
  if (pinned !== 0) return pinned;
  const updated = b.updatedAt.localeCompare(a.updatedAt);
  return updated !== 0 ? updated : b.id.localeCompare(a.id);
}

export interface SessionMetadataUpdate {
  name?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

export class ProjectStore {
  readonly projectId: number;

  // ---- Public reactive state ------------------------------------------------

  /** Active tasks loaded for the normal project sidebar. */
  tasks: TaskListItem[] = [];
  /** IDs returned by the latest active project-session list. Metadata lives in SessionCache. */
  sessionIds: string[] = [];
  /** Task IDs whose session sublists have been explicitly loaded and should be refreshed. */
  loadedTaskSessionIds: Set<number> = new Set();
  skills: InjectedSkillInfo[] = [];
  loading = false;
  loaded = false;

  // ---- Private state --------------------------------------------------------

  private _sessionCache: SessionCache | null;
  private _sessionCacheUnsubscribe: (() => void) | null = null;
  private _listeners = new Set<ProjectStoreListener>();

  constructor(projectId: number, sessionCache: SessionCache | null = null) {
    this.projectId = projectId;
    this._sessionCache = sessionCache;
    this._sessionCacheUnsubscribe = sessionCache?.subscribeAll((sessionId) => {
      const session = sessionCache.get(sessionId);
      if (session?.projectId === this.projectId) this.notify();
    }) ?? null;
  }

  // ---- Subscription ---------------------------------------------------------

  subscribe(fn: ProjectStoreListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private notify() {
    for (const fn of this._listeners) fn();
  }

  dispose(): void {
    this._sessionCacheUnsubscribe?.();
    this._sessionCacheUnsubscribe = null;
  }

  // ---- Task selectors -------------------------------------------------------

  findTask(taskId: number): TaskListItem | undefined {
    return this.tasks.find((task) => task.id === taskId);
  }

  // ---- Session selectors ----------------------------------------------------

  getSession(sessionId: string): CachedSession | undefined {
    const session = this._sessionCache?.get(sessionId);
    return session?.projectId === this.projectId ? session : undefined;
  }

  /** Active project scratch sessions, with pinned sessions above the recency order. */
  get sessions(): SessionListItem[] {
    return this.sessionIds.flatMap((sessionId) => {
      const session = this._sessionCache?.get(sessionId);
      return session && isSessionListItem(session) && session.archivedAt === null ? [session] : [];
    }).toSorted(compareSessionListItems);
  }

  /** Task sessions derived live from SessionCache for one task, ordered like the server list endpoint. */
  taskSessionsFor(taskId: number): SessionListItem[] {
    return (this._sessionCache?.entries() ?? [])
      .filter((session) => (
        session.projectId === this.projectId &&
        session.taskId === taskId &&
        session.archivedAt === null
      ))
      .filter(isSessionListItem)
      .toSorted(compareSessionListItems);
  }

  /** Running direct children already present in the loaded project/task session data. */
  runningChildSessionsFor(parentSessionId: string): SessionListItem[] {
    return (this._sessionCache?.entries() ?? [])
      .filter((session) => (
        session.projectId === this.projectId &&
        session.parentSessionId === parentSessionId &&
        session.activityState === "running"
      ))
      .filter(isSessionListItem)
      .toSorted(compareSessionListItems);
  }

  // ---- Activity selectors ---------------------------------------------------

  activityForSession(sessionId: string): ActivityState {
    return this._sessionCache?.get(sessionId)?.activityState ?? null;
  }

  activityForTask(taskId: number): ActivityState {
    return this.activityForSessions(
      (session) => session.projectId === this.projectId && session.taskId === taskId,
    );
  }

  /** Derive the project-level activity state from SessionCache project metadata. */
  get activityState(): ActivityState {
    return this.activityForSessions((session) => session.projectId === this.projectId);
  }

  private activityForSessions(predicate: (session: CachedSession) => boolean): ActivityState {
    let hasFinished = false;
    for (const session of this._sessionCache?.entries() ?? []) {
      if (!predicate(session)) continue;
      if (session.activityState === "running") return "running";
      if (session.activityState === "finished") hasFinished = true;
    }
    return hasFinished ? "finished" : null;
  }

  // ---- Actions --------------------------------------------------------------

  /** Optimistically mark an idle session read or unread. */
  async setSessionUnread(
    sessionId: string,
    unread: boolean,
  ): Promise<{ ok: true } | { error: string }> {
    const session = this.getSession(sessionId);
    if (!session) return { error: "Session not found" };
    if (session.activityState === "running") {
      return unread ? { error: "Running sessions cannot be marked unread" } : { ok: true };
    }

    const previousState = session.activityState;
    const nextState = unread ? "finished" : null;
    if (previousState === nextState) return { ok: true };
    this._sessionCache?.set(sessionId, { activityState: nextState });

    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/activity`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unread }),
      });
      if (resp.ok) return { ok: true };

      if (this.activityForSession(sessionId) === nextState) {
        this._sessionCache?.set(sessionId, { activityState: previousState });
      }
      return { error: `HTTP ${resp.status}` };
    } catch {
      if (this.activityForSession(sessionId) === nextState) {
        this._sessionCache?.set(sessionId, { activityState: previousState });
      }
      return { error: "Network error" };
    }
  }

  /** Optimistically rename, pin/unpin, or archive/unarchive a session. */
  async updateSessionMetadata(
    sessionId: string,
    updates: SessionMetadataUpdate,
  ): Promise<{ ok: true } | { error: string }> {
    const session = this.getSession(sessionId);
    if (!session) return { error: "Session not found" };

    const optimisticAt = new Date().toISOString();
    const previous: SessionPatch = {};
    const optimistic: SessionPatch = {};
    if (updates.name !== undefined) {
      previous.name = session.name;
      optimistic.name = updates.name?.trim() || null;
    }
    if (updates.pinned !== undefined) {
      previous.pinnedAt = session.pinnedAt;
      optimistic.pinnedAt = updates.pinned ? optimisticAt : null;
    }
    if (updates.archived !== undefined) {
      previous.archivedAt = session.archivedAt;
      optimistic.archivedAt = updates.archived ? optimisticAt : null;
    }
    this._sessionCache?.set(sessionId, optimistic);

    const rollback = () => {
      const current = this.getSession(sessionId);
      const patch: SessionPatch = {};
      if (updates.name !== undefined && current?.name === optimistic.name) {
        patch.name = previous.name;
      }
      if (updates.pinned !== undefined && current?.pinnedAt === optimistic.pinnedAt) {
        patch.pinnedAt = previous.pinnedAt;
      }
      if (updates.archived !== undefined && current?.archivedAt === optimistic.archivedAt) {
        patch.archivedAt = previous.archivedAt;
      }
      this._sessionCache?.set(sessionId, patch);
    };

    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/metadata`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!resp.ok) {
        rollback();
        return { error: `HTTP ${resp.status}` };
      }

      const data: Pick<SessionListItem, "name" | "pinnedAt" | "archivedAt"> = await resp.json();
      const confirmed: SessionPatch = {};
      if (updates.name !== undefined) confirmed.name = data.name;
      if (updates.pinned !== undefined) confirmed.pinnedAt = data.pinnedAt;
      if (updates.archived !== undefined) confirmed.archivedAt = data.archivedAt;
      this._sessionCache?.set(sessionId, confirmed);
      return { ok: true };
    } catch {
      rollback();
      return { error: "Network error" };
    }
  }

  /**
   * Fetch tasks and sessions for this project in parallel.
   */
  async fetchLists(): Promise<void> {
    this.loading = true;
    this.notify();

    try {
      const [tasksResp, sessionsResp, skillsResp] = await Promise.all([
        fetch(`/api/projects/${this.projectId}/tasks?status=open`),
        fetch(`/api/projects/${this.projectId}/sessions`),
        fetch(`/api/projects/${this.projectId}/skills`),
      ]);

      if (tasksResp.ok) {
        this.tasks = await tasksResp.json();
      }
      if (sessionsResp.ok) {
        const sessions: SessionListItem[] = await sessionsResp.json();
        this._sessionCache?.setMany(sessions);
        this.sessionIds = sessions.map((session) => session.id);
      }
      if (skillsResp.ok) {
        const body = await skillsResp.json().catch(() => null);
        this.skills = Array.isArray(body?.skills) ? body.skills : [];
      }
      if (this.loadedTaskSessionIds.size > 0) {
        await Promise.all(
          [...this.loadedTaskSessionIds].map((taskId) => this.fetchTaskSessions(taskId)),
        );
      }
      this.loaded = true;
    } catch {
      // silent — leave loaded as-is (false if first attempt)
    }

    this.loading = false;
    this.notify();
  }

  /** Update a task's title and/or description. */
  async updateTask(
    taskId: number,
    updates: { title?: string; description?: string | null },
  ): Promise<{ ok: true } | { error: string }> {
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/${taskId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(updates),
        },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || `HTTP ${resp.status}` };
      }
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }

  /** Delete a task. */
  async deleteTask(taskId: number): Promise<{ ok: true } | { error: string }> {
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/${taskId}`,
        { method: "DELETE" },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || `HTTP ${resp.status}` };
      }
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }

  /** Generate a task from a freeform prompt. */
  async generateTask(prompt: string): Promise<{ ok: true } | { error: string }> {
    try {
      const resp = await fetch(
        `/api/projects/${this.projectId}/tasks/generate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        },
      );
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return { error: body.error || `Error creating task (HTTP ${resp.status})` };
      }
      return { ok: true };
    } catch {
      return { error: "Network error" };
    }
  }

  /**
   * Fetch the list of skills available for tab-completion.
   * Safe to call repeatedly; updates the `skills` field and notifies subscribers.
   */
  async fetchSkills(): Promise<void> {
    try {
      const resp = await fetch(`/api/projects/${this.projectId}/skills`);
      if (!resp.ok) return;
      const body = await resp.json();
      const skills: InjectedSkillInfo[] = Array.isArray(body.skills) ? body.skills : [];
      this.skills = skills;
      this.notify();
    } catch {
      // silent — skill autocomplete is best-effort
    }
  }

  /**
   * Fetch sessions for a specific task (for expanded task sublists).
   * Session metadata changes notify through SessionCache subscriptions; this
   * only notifies directly when the loaded state or task session ordering changes.
   */
  async fetchTaskSessions(taskId: number): Promise<void> {
    try {
      const resp = await fetch(
        `/api/tasks/${taskId}/sessions`,
      );
      if (resp.ok) {
        const sessions: SessionListItem[] = await resp.json();
        const wasLoaded = this.loadedTaskSessionIds.has(taskId);
        const previousIds = this.taskSessionsFor(taskId).map((session) => session.id);
        this.loadedTaskSessionIds.add(taskId);
        this._sessionCache?.setMany(sessions);
        const nextIds = this.taskSessionsFor(taskId).map((session) => session.id);
        if (!wasLoaded || JSON.stringify(previousIds) !== JSON.stringify(nextIds)) {
          this.notify();
        }
      }
    } catch {
      // silent
    }
  }
}
