/**
 * Session Cache
 *
 * Dumb shared cache for canonical session metadata. This is not a domain
 * behavior store: callers decide when to fetch or mutate server state, then
 * write the resulting session records here for keyed lookup/subscription.
 */

import type { SessionData, SessionState } from "../ws-client.js";

export type ActivityState = "running" | "finished" | null;

export interface CachedSession {
  id: string;
  projectId: number | null;
  taskId: number | null;
  parentSessionId: string | null;
  name: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  firstMessage: string | null;
  messageCount: number | null;
  activityState: ActivityState;
  runtimeType: string | null;
  state: SessionState | null;
}

export type SessionPatch = Partial<Omit<CachedSession, "id">>;
export type SessionRecord = SessionPatch & { id: string };
export type SessionCacheListener = () => void;
export type SessionCacheAnyListener = (sessionId: string) => void;

function emptyCachedSession(sessionId: string): CachedSession {
  return {
    id: sessionId,
    projectId: null,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: null,
    updatedAt: null,
    firstMessage: null,
    messageCount: null,
    activityState: null,
    runtimeType: null,
    state: null,
  };
}

function withoutUndefined(data: SessionPatch): SessionPatch {
  const result: SessionPatch = {};
  if (data.projectId !== undefined) result.projectId = data.projectId;
  if (data.taskId !== undefined) result.taskId = data.taskId;
  if (data.parentSessionId !== undefined) result.parentSessionId = data.parentSessionId;
  if (data.name !== undefined) result.name = data.name;
  if (data.createdAt !== undefined) result.createdAt = data.createdAt;
  if (data.updatedAt !== undefined) result.updatedAt = data.updatedAt;
  if (data.firstMessage !== undefined) result.firstMessage = data.firstMessage;
  if (data.messageCount !== undefined) result.messageCount = data.messageCount;
  if (data.activityState !== undefined) result.activityState = data.activityState;
  if (data.runtimeType !== undefined) result.runtimeType = data.runtimeType;
  if (data.state !== undefined) result.state = data.state;
  return result;
}

function sessionEquals(a: CachedSession, b: CachedSession): boolean {
  return a.projectId === b.projectId &&
    a.taskId === b.taskId &&
    a.parentSessionId === b.parentSessionId &&
    a.name === b.name &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.firstMessage === b.firstMessage &&
    a.messageCount === b.messageCount &&
    a.activityState === b.activityState &&
    a.runtimeType === b.runtimeType &&
    a.state === b.state;
}

export class SessionCache {
  private _entries = new Map<string, CachedSession>();
  private _detailFetches = new Map<string, Promise<SessionData | null>>();
  private _listeners = new Map<string, Set<SessionCacheListener>>();
  private _anyListeners = new Set<SessionCacheAnyListener>();

  subscribe(sessionId: string, listener: SessionCacheListener): () => void {
    let listeners = this._listeners.get(sessionId);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(sessionId, listeners);
    }

    listeners.add(listener);
    return () => {
      const current = this._listeners.get(sessionId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this._listeners.delete(sessionId);
    };
  }

  subscribeAll(listener: SessionCacheAnyListener): () => void {
    this._anyListeners.add(listener);
    return () => this._anyListeners.delete(listener);
  }

  private notify(sessionId: string): void {
    for (const listener of this._anyListeners) listener(sessionId);

    const listeners = this._listeners.get(sessionId);
    if (!listeners) return;
    for (const listener of listeners) listener();
  }

  get(sessionId: string): CachedSession | undefined {
    return this._entries.get(sessionId);
  }

  entries(): CachedSession[] {
    return Array.from(this._entries.values());
  }

  getDetail(sessionId: string): SessionData | null {
    const entry = this._entries.get(sessionId);
    if (!entry) return null;
    if (entry.projectId == null) return null;
    if (entry.createdAt == null) return null;
    if (entry.updatedAt == null) return null;
    if (entry.messageCount == null) return null;
    if (entry.state == null) return null;

    return {
      id: entry.id,
      projectId: entry.projectId,
      taskId: entry.taskId,
      parentSessionId: entry.parentSessionId,
      name: entry.name,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      runtimeType: entry.runtimeType ?? undefined,
      activityState: entry.activityState,
      messageCount: entry.messageCount,
      state: entry.state,
    };
  }

  set(sessionId: string, data: SessionPatch): void {
    const previous = this._entries.get(sessionId) ?? emptyCachedSession(sessionId);
    const next = {
      ...previous,
      ...withoutUndefined(data),
      id: sessionId,
    };
    this._entries.set(sessionId, next);
    if (!sessionEquals(previous, next)) {
      this.notify(sessionId);
    }
  }

  setMany(sessions: readonly SessionRecord[]): void {
    for (const session of sessions) {
      const { id, ...data } = session;
      this.set(id, data);
    }
  }

  removeMany(sessionIds: readonly string[]): string[] {
    const removedSessionIds: string[] = [];
    for (const sessionId of sessionIds) {
      if (!this._entries.delete(sessionId)) continue;
      this._detailFetches.delete(sessionId);
      removedSessionIds.push(sessionId);
      this.notify(sessionId);
    }
    return removedSessionIds;
  }

  async fetchDetail(sessionId: string): Promise<SessionData | null> {
    const existing = this._detailFetches.get(sessionId);
    if (existing) return existing;

    const request = this._fetchDetail(sessionId).finally(() => {
      this._detailFetches.delete(sessionId);
    });
    this._detailFetches.set(sessionId, request);
    return request;
  }

  private async _fetchDetail(sessionId: string): Promise<SessionData | null> {
    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (!resp.ok) return null;
      const data: SessionData = await resp.json();
      this.set(data.id, data);
      return data;
    } catch {
      return null;
    }
  }
}
