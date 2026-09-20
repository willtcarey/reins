import type { SessionListItem } from "../ws-client.js";

const PAGE_SIZE = 20;

export interface ArchivedSessionHistoryItem extends SessionListItem {
  taskTitle: string | null;
}

export interface CompletedTaskHistoryItem {
  id: number;
  title: string;
  description: string | null;
  updatedAt: string;
  sessionCount: number;
  sessions: SessionListItem[] | null;
}

interface CompletedTaskResponse {
  id: number;
  title: string;
  description: string | null;
  updated_at: string;
  session_count: number;
}

interface CollectionPage<T> {
  items: T[];
  hasMore: boolean;
}

export class ProjectHistoryStore {
  archivedSessions: ArchivedSessionHistoryItem[] = [];
  completedTasks: CompletedTaskHistoryItem[] = [];
  archivedHasMore = false;
  completedHasMore = false;
  loading = false;
  loaded = false;
  loadingArchived = false;
  loadingCompleted = false;

  private search = "";
  private generation = 0;
  private archivedOffset = 0;
  private completedOffset = 0;
  private listeners = new Set<() => void>();

  constructor(readonly projectId: number) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.generation++;
    this.listeners.clear();
  }

  async load(): Promise<void> {
    const generation = ++this.generation;
    this.archivedSessions = [];
    this.completedTasks = [];
    this.archivedOffset = 0;
    this.completedOffset = 0;
    this.archivedHasMore = false;
    this.completedHasMore = false;
    this.loading = true;
    this.notify();

    await Promise.all([
      this.loadArchivedPage(generation, true),
      this.loadCompletedPage(generation, true),
    ]);
    if (generation !== this.generation) return;

    this.loading = false;
    this.loaded = true;
    this.notify();
  }

  async setSearch(search: string): Promise<void> {
    const normalized = search.trim();
    if (normalized === this.search) return;
    this.search = normalized;
    await this.load();
  }

  async loadMoreArchived(): Promise<void> {
    if (this.loadingArchived || !this.archivedHasMore) return;
    await this.loadArchivedPage(this.generation, false);
  }

  async loadMoreCompleted(): Promise<void> {
    if (this.loadingCompleted || !this.completedHasMore) return;
    await this.loadCompletedPage(this.generation, false);
  }

  async loadTaskSessions(taskId: number): Promise<void> {
    const task = this.completedTasks.find((candidate) => candidate.id === taskId);
    if (!task || task.sessions !== null) return;

    const response = await fetch(`/api/projects/${this.projectId}/tasks/${taskId}?archived=include`);
    if (!response.ok) return;
    const detail: { sessions: SessionListItem[] } = await response.json();
    const archived = this.archivedSessions.filter((session) => session.taskId === taskId);
    const sessions = new Map(
      [...detail.sessions, ...archived].map((session) => [session.id, session]),
    );
    task.sessions = [...sessions.values()].toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    this.completedTasks = [...this.completedTasks];
    this.notify();
  }

  async unarchive(sessionId: string): Promise<{ ok: true } | { error: string }> {
    const index = this.archivedSessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return { error: "Session not found" };
    const session = this.archivedSessions[index]!;
    const archivedAt = session.archivedAt;
    session.archivedAt = null;
    this.archivedSessions = this.archivedSessions.filter((candidate) => candidate.id !== sessionId);
    this.archivedOffset--;
    this.completedTasks = [...this.completedTasks];
    this.notify();

    const rollback = () => {
      session.archivedAt = archivedAt;
      const restored = [...this.archivedSessions];
      restored.splice(Math.min(index, restored.length), 0, session);
      this.archivedSessions = restored;
      this.archivedOffset++;
      this.completedTasks = [...this.completedTasks];
      this.notify();
    };

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/metadata`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      if (response.ok) return { ok: true };
      rollback();
      return { error: `HTTP ${response.status}` };
    } catch {
      rollback();
      return { error: "Network error" };
    }
  }

  private async loadArchivedPage(generation: number, reset: boolean): Promise<void> {
    this.loadingArchived = true;
    this.notify();
    try {
      const response = await fetch(this.collectionUrl("sessions", reset ? 0 : this.archivedOffset, {
        archived: "only",
      }));
      if (!response.ok) return;
      const page: CollectionPage<ArchivedSessionHistoryItem> = await response.json();
      if (generation !== this.generation) return;
      this.archivedSessions = reset ? page.items : [...this.archivedSessions, ...page.items];
      this.archivedOffset = (reset ? 0 : this.archivedOffset) + page.items.length;
      this.archivedHasMore = page.hasMore;
    } catch {
      // Retain prior data so the request can be retried.
    } finally {
      if (generation === this.generation) {
        this.loadingArchived = false;
        this.notify();
      }
    }
  }

  private async loadCompletedPage(generation: number, reset: boolean): Promise<void> {
    this.loadingCompleted = true;
    this.notify();
    try {
      const response = await fetch(this.collectionUrl("tasks", reset ? 0 : this.completedOffset, {
        status: "closed",
      }));
      if (!response.ok) return;
      const page: CollectionPage<CompletedTaskResponse> = await response.json();
      if (generation !== this.generation) return;
      const items = page.items.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        updatedAt: task.updated_at,
        sessionCount: task.session_count,
        sessions: null,
      }));
      this.completedTasks = reset ? items : [...this.completedTasks, ...items];
      this.completedOffset = (reset ? 0 : this.completedOffset) + page.items.length;
      this.completedHasMore = page.hasMore;
    } catch {
      // Retain prior data so the request can be retried.
    } finally {
      if (generation === this.generation) {
        this.loadingCompleted = false;
        this.notify();
      }
    }
  }

  private collectionUrl(
    resource: "sessions" | "tasks",
    offset: number,
    params: Record<string, string>,
  ): string {
    const query = new URLSearchParams({
      ...params,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (this.search) query.set("search", this.search);
    return `/api/projects/${this.projectId}/${resource}?${query}`;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
