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
  taskTitle: "Router task",
};

const completedTask = {
  id: 9,
  title: "Router task",
  description: "Done",
  updatedAt: "2026-01-04T00:00:00Z",
  sessionCount: 1,
};

afterEach(restoreFetch);

describe("ProjectHistoryStore", () => {
  test("loads archived sessions and completed tasks from their resource endpoints", async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return Response.json(url.includes("/sessions")
        ? [archivedSession]
        : [{
            id: 9,
            title: "Router task",
            description: "Done",
            updated_at: "2026-01-04T00:00:00Z",
            session_count: 1,
          }]);
    });
    const store = new ProjectHistoryStore(42);

    await store.load();

    expect(urls).toEqual([
      "/api/projects/42/sessions?archived=only",
      "/api/projects/42/tasks?status=closed",
    ]);
    expect(store.archivedSessions).toEqual([archivedSession]);
    expect(store.completedTasks).toEqual([completedTask]);
    expect(store.loaded).toBe(true);
  });

  test("optimistically removes an unarchived session and restores it when persistence fails", async () => {
    mockFetch((url) => {
      if (url.includes("/sessions?archived=only")) return Response.json([archivedSession]);
      if (url.includes("/tasks?status=closed")) return Response.json([]);
      return Response.json({}, { status: 500 });
    });
    const store = new ProjectHistoryStore(42);
    await store.load();

    const result = await store.unarchive("archived");

    expect(result).toEqual({ error: "HTTP 500" });
    expect(store.archivedSessions).toEqual([archivedSession]);
  });
});
