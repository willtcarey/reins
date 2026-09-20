import type { SessionListItem } from "../ws-client.js";

export interface ArchivedSessionHistoryItem extends SessionListItem {
  taskTitle: string | null;
}

export interface CompletedTaskHistoryItem {
  id: number;
  title: string;
  description: string | null;
  updatedAt: string;
  sessionCount: number;
}

interface CompletedTaskResponse {
  id: number;
  title: string;
  description: string | null;
  updated_at: string;
  session_count: number;
}

export class ProjectHistoryStore {
  archivedSessions: ArchivedSessionHistoryItem[] = [];
  completedTasks: CompletedTaskHistoryItem[] = [];
  loading = false;
  loaded = false;

  private listeners = new Set<() => void>();

  constructor(readonly projectId: number) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
  }

  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.notify();

    try {
      const [sessionsResponse, tasksResponse] = await Promise.all([
        fetch(`/api/projects/${this.projectId}/sessions?archived=only`),
        fetch(`/api/projects/${this.projectId}/tasks?status=closed`),
      ]);
      if (sessionsResponse.ok && tasksResponse.ok) {
        const archivedSessions: ArchivedSessionHistoryItem[] = await sessionsResponse.json();
        const completedTasks: CompletedTaskResponse[] = await tasksResponse.json();
        this.archivedSessions = archivedSessions.toSorted((a, b) =>
          (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
        this.completedTasks = completedTasks.map((task) => ({
          id: task.id,
          title: task.title,
          description: task.description,
          updatedAt: task.updated_at,
          sessionCount: task.session_count,
        }));
        this.loaded = true;
      }
    } catch {
      // Retain prior data so revisiting the route can retry.
    }

    this.loading = false;
    this.notify();
  }

  async unarchive(sessionId: string): Promise<{ ok: true } | { error: string }> {
    const index = this.archivedSessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return { error: "Session not found" };
    const session = this.archivedSessions[index]!;
    this.archivedSessions = this.archivedSessions.filter((candidate) => candidate.id !== sessionId);
    this.notify();

    const rollback = () => {
      const restored = [...this.archivedSessions];
      restored.splice(Math.min(index, restored.length), 0, session);
      this.archivedSessions = restored;
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

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
