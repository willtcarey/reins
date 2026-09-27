import { afterEach, describe, expect, test } from "bun:test";
import { ProjectHistoryStore } from "../../../models/stores/project-history-store.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";

const archivedSession = {
  id: "archived",
  projectId: 42,
  taskId: 9,
  parentSessionId: null,
  name: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  messageCount: 3,
  firstMessage: "Investigate routing",
  activityState: null,
  pinnedAt: null,
  archivedAt: "2026-01-03T00:00:00Z",
  location: { state: "server" as const },
  taskTitle: "Router task",
};

const completedTask = {
  id: 9,
  title: "Router task",
  description: "Done",
  updatedAt: "2026-01-04T00:00:00Z",
  sessionCount: 1,
  sessions: null,
};

afterEach(restoreFetch);

describe("ProjectHistoryStore", () => {
  test("loads archived sessions and completed tasks from their resource endpoints", async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return Response.json({
        items: url.includes("/sessions")
          ? [archivedSession]
          : [{
              id: 9,
              title: "Router task",
              description: "Done",
              updated_at: "2026-01-04T00:00:00Z",
              session_count: 1,
            }],
        hasMore: false,
      });
    });
    const store = new ProjectHistoryStore(42);

    await store.load();

    expect(urls).toEqual([
      "/api/projects/42/sessions?archived=only&limit=20&offset=0",
      "/api/projects/42/tasks?status=closed&limit=20&offset=0",
    ]);
    expect(store.archivedSessions).toEqual([archivedSession]);
    expect(store.completedTasks).toEqual([completedTask]);
    expect(store.loaded).toBe(true);
  });

  test("loads subsequent pages and restarts pagination for a search", async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      if (url.includes("/sessions")) return Response.json({ items: [], hasMore: false });
      if (url.includes("search=router")) {
        return Response.json({
          items: [{
            id: 3,
            title: "Router result",
            description: null,
            updated_at: "2026-01-06T00:00:00Z",
            session_count: 0,
          }],
          hasMore: false,
        });
      }
      const secondPage = url.includes("offset=1");
      return Response.json({
        items: [{
          id: secondPage ? 2 : 1,
          title: secondPage ? "Second task" : "First task",
          description: null,
          updated_at: "2026-01-04T00:00:00Z",
          session_count: 0,
        }],
        hasMore: !secondPage,
      });
    });
    const store = new ProjectHistoryStore(42);
    await store.load();

    await store.loadMoreCompleted();
    expect(store.completedTasks.map((task) => task.title)).toEqual(["First task", "Second task"]);

    await store.setSearch("router");
    expect(store.completedTasks.map((task) => task.title)).toEqual(["Router result"]);
    expect(urls).toContain("/api/projects/42/tasks?status=closed&limit=20&offset=0&search=router");
  });

  test("loads a completed task's current and archived conversations on demand", async () => {
    const currentSession = {
      ...archivedSession,
      id: "current",
      archivedAt: null,
      updatedAt: "2026-01-05T00:00:00Z",
    };
    mockFetch((url) => {
      if (url.endsWith("/tasks/9?archived=include")) return Response.json({ sessions: [currentSession] });
      if (url.includes("/sessions?archived=only")) {
        return Response.json({ items: [archivedSession], hasMore: false });
      }
      return Response.json({
        items: [{
          id: 9,
          title: "Router task",
          description: "Done",
          updated_at: "2026-01-04T00:00:00Z",
          session_count: 2,
        }],
        hasMore: false,
      });
    });
    const store = new ProjectHistoryStore(42);
    await store.load();

    await store.loadTaskSessions(9);

    expect(store.completedTasks[0]?.sessions?.map((session) => session.id)).toEqual([
      "current",
      "archived",
    ]);
  });

  test("optimistically removes an unarchived session and restores it when persistence fails", async () => {
    mockFetch((url) => {
      if (url.includes("/sessions?archived=only")) {
        return Response.json({ items: [archivedSession], hasMore: false });
      }
      if (url.includes("/tasks?status=closed")) {
        return Response.json({ items: [], hasMore: false });
      }
      return Response.json({}, { status: 500 });
    });
    const store = new ProjectHistoryStore(42);
    await store.load();

    const result = await store.unarchive("archived");

    expect(result).toEqual({ error: "HTTP 500" });
    expect(store.archivedSessions).toEqual([archivedSession]);
  });
});
