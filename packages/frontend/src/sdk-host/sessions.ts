import type { Session, SessionCreation, SessionMoveTarget, SessionQuery, Sessions, SessionsChange, SessionSummary, Source } from "@reins/sdk";
import { ChangeFeed } from "./change-feed.js";
import type { AppStore } from "../models/stores/app-store.js";
import { compareSessionListItems, isSessionListItem, type CachedSessionListItem as ListedSession } from "../models/stores/project-store.js";
import type { ActivityState, CachedSession } from "../models/stores/session-cache.js";

export type SdkSessionsApp = Pick<AppStore, "sessionOperations" | "sessionCache" | "projectsStore">;

export function sdkActivity(state: ActivityState): SessionSummary["activity"] {
  return state === "finished" ? "unread" : state;
}

function matches(session: CachedSession, { projectId, taskId, archived = false }: SessionQuery): boolean {
  if (projectId !== undefined && session.projectId !== projectId) return false;
  if (taskId !== undefined && session.taskId !== taskId) return false;
  return archived || session.archivedAt === null;
}

function unwrap(result: { ok: true } | { error: string }): void {
  if ("error" in result) throw new Error(result.error);
}

/** The SDK's `sessions`, over the app's stores. */
export class SdkSessions implements Sessions {
  /** Summaries by the cache's entry, which the cache replaces when the session changes, so an unchanged session
   * keeps its summary. */
  private readonly summaries = new WeakMap<CachedSession, SessionSummary>();
  /** Tasks whose sessions a query asked for, so each is loaded once (its project's refreshes keep it current). */
  private requestedTasks = new Set<number>();

  /** Each session's summary as listeners last heard of it (null: not listed), and the project it was in. */
  private readonly heard = new Map<string, { summary: string; projectId: number | null }>();
  /** The projects each changed session was or is in, since the last event. */
  private readonly touched = new Map<string, Set<number | null>>();
  private readonly feed = new ChangeFeed<string>();
  private readonly listeners = new Set<(change: SessionsChange) => void>();

  constructor(private readonly app: SdkSessionsApp) {
    app.sessionCache.subscribeAll((sessionId) => this.cacheChanged(sessionId));
    this.feed.listen((sessionIds) => {
      const projectIds = new Set<number | null>();
      for (const sessionId of sessionIds) for (const projectId of this.touched.get(sessionId) ?? []) projectIds.add(projectId);
      this.touched.clear();
      const change: SessionsChange = { sessionIds, projectIds: [...projectIds] };
      for (const listener of this.listeners) listener(change);
    });
  }

  onDidChange(listener: (change: SessionsChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A cache entry changed: listeners hear of it only when its summary, as lists give it, did. */
  private cacheChanged(sessionId: string): void {
    const entry = this.app.sessionCache.get(sessionId);
    const listed = entry && !entry.background && isSessionListItem(entry) ? this.summary(entry) : null;
    const summary = JSON.stringify(listed);
    const before = this.heard.get(sessionId);
    if (before?.summary === summary) return;
    const projectId = entry?.projectId ?? null;
    this.heard.set(sessionId, { summary, projectId });
    const projects = this.touched.get(sessionId) ?? new Set<number | null>();
    if (before) projects.add(before.projectId);
    projects.add(projectId);
    this.touched.set(sessionId, projects);
    this.feed.add([sessionId]);
  }

  async get(sessionId: string): Promise<Session> {
    const session = await this.app.sessionCache.loadDetail(sessionId);
    const { placement } = session;
    return {
      id: session.id,
      projectId: session.projectId,
      taskId: session.taskId,
      parentSessionId: session.parentSessionId,
      name: session.name,
      source: { nodeId: placement.nodeId, path: placement.path },
    };
  }

  async create({ projectId, prompt, ...input }: SessionCreation): Promise<string> {
    const created = await this.app.projectsStore.createSession(projectId, input);
    if ("error" in created) throw new Error(created.error);
    if (prompt) await this.app.sessionOperations.submit(created.sessionId, "prompt", [{ type: "text", text: prompt }])?.admitted;
    return created.sessionId;
  }

  async send(sessionId: string, message: string): Promise<void> {
    const submission = this.app.sessionOperations.submit(sessionId, "steer", [{ type: "text", text: message }]);
    if (!submission) throw new Error("There is no session to send to");
    await submission.admitted;
  }

  async compact(sessionId: string, instructions?: string): Promise<void> {
    await this.app.sessionOperations.compact(sessionId, instructions ? { instructions } : {});
  }

  list(query: SessionQuery = {}): readonly SessionSummary[] {
    this.load(query);
    return this.listed()
      .filter((session) => matches(session, query))
      .toSorted(compareSessionListItems)
      .map((session) => this.summary(session));
  }

  async setUnread(sessionId: string, unread: boolean): Promise<void> {
    unwrap(await this.app.projectsStore.setSessionUnread(sessionId, unread));
  }

  async setPinned(sessionId: string, pinned: boolean): Promise<void> {
    unwrap(await this.app.projectsStore.updateSessionMetadata(sessionId, { pinned }));
  }

  async setArchived(sessionId: string, archived: boolean): Promise<void> {
    unwrap(await this.app.projectsStore.updateSessionMetadata(sessionId, { archived }));
  }

  async setName(sessionId: string, name: string | null): Promise<void> {
    unwrap(await this.app.projectsStore.updateSessionMetadata(sessionId, { name }));
  }

  async moveTargets(sessionId: string): Promise<readonly SessionMoveTarget[]> {
    const targets = await this.app.projectsStore.loadMoveTargets(sessionId);
    if ("error" in targets) throw new Error(targets.error);
    return targets;
  }

  async move(sessionId: string, to: Source): Promise<void> {
    unwrap(await this.app.projectsStore.moveSession(sessionId, to.nodeId, to.path));
  }

  /** A query naming a project loads its assistant's conversations; naming a task too, that task's sessions. */
  private load({ projectId, taskId }: SessionQuery): void {
    if (projectId == null) return;
    const { projectsStore } = this.app;
    if (taskId == null) {
      void projectsStore.ensureLoaded(projectId);
      return;
    }
    if (this.requestedTasks.has(taskId)) return;
    this.requestedTasks.add(taskId);
    void projectsStore.getStore(projectId).fetchTaskSessions(taskId);
  }

  private listed(): ListedSession[] {
    return this.app.sessionCache.entries().filter(isSessionListItem);
  }

  private summary(session: ListedSession): SessionSummary {
    const known = this.summaries.get(session);
    if (known) return known;
    const { placement } = session;
    const summary: SessionSummary = {
      id: session.id,
      projectId: session.projectId,
      taskId: session.taskId,
      parentSessionId: session.parentSessionId,
      name: session.name,
      firstMessage: session.firstMessage,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      activity: sdkActivity(session.activityState),
      pinned: session.pinnedAt !== null,
      archived: session.archivedAt !== null,
      startedBy: session.sourceExtension,
      source: { nodeId: placement.nodeId, path: placement.path },
      nodeName: placement.nodeName,
      nodeRemoved: placement.removed,
    };
    this.summaries.set(session, summary);
    return summary;
  }
}

