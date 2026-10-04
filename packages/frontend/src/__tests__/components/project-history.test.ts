import { afterEach, describe, expect, test } from "bun:test";
import type { ArchivedSessionHistoryItem } from "@backend/routes/project-sessions.js";
import { ProjectHistory } from "../../components/project-history.js";
import { ProjectHistoryStore } from "../../models/stores/project-history-store.js";
import { collectTemplateValues, templateToString } from "../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";

function session(overrides: Partial<ArchivedSessionHistoryItem>): ArchivedSessionHistoryItem {
  return {
    id: "archived",
    projectId: 7,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    messageCount: 3,
    firstMessage: "Investigate routing",
    activityState: null,
    pinnedAt: null,
    archivedAt: "2026-01-03T00:00:00Z",
    placement: { available: true, nodeId: "internal", nodeName: "Internal", path: "" },
    taskTitle: null,
    ...overrides,
  };
}

function fullOutput(value: unknown): string {
  return `${templateToString(value)}\n${templateToString(collectTemplateValues(value))}`;
}

afterEach(restoreFetch);

describe("ProjectHistory", () => {
  test("owns and loads its route-scoped store from the project ID", async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      return Response.json({ items: [], hasMore: false });
    });
    const history = new ProjectHistory();
    history.projectId = 7;

    history.willUpdate(new Map([["projectId", 0]]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(urls).toEqual([
      "/api/projects/7/sessions?archived=only&limit=20&offset=0",
      "/api/projects/7/tasks?status=closed&limit=20&offset=0",
    ]);
    expect(fullOutput(history.render())).toContain("No project history yet");
  });

  test("separates completed tasks and archived conversations into counted views", () => {
    const store = new ProjectHistoryStore(7);
    store.archivedSessions = [
      session({ id: "scratch", name: "Archived research" }),
      session({ id: "task-session", taskId: 9, taskTitle: "Frontend router" }),
    ];
    store.completedTasks = [{
      id: 9,
      title: "Frontend router",
      description: null,
      updatedAt: "2026-01-04T00:00:00Z",
      sessionCount: 1,
      sessions: null,
    }];
    store.loaded = true;
    const history = new ProjectHistory();
    history.projectName = "Reins";
    Reflect.set(history, "store", store);

    const tasksOutput = fullOutput(history.render());

    expect(tasksOutput).toContain("History");
    expect(tasksOutput).toContain("Reins");
    expect(tasksOutput).toContain("Completed tasks");
    expect(tasksOutput).toContain("Archived conversations");
    expect(tasksOutput).toContain("2");
    expect(tasksOutput).toContain("Frontend router");
    expect(tasksOutput).toContain("1 session");
    expect(tasksOutput).not.toContain("Archived research");

    Reflect.set(history, "activeView", "sessions");
    const sessionsOutput = fullOutput(history.render());
    expect(sessionsOutput).toContain("Archived research");
    expect(sessionsOutput).not.toContain("1 session");
  });

  test("offers the next page when more completed tasks are available", () => {
    const store = new ProjectHistoryStore(7);
    store.completedTasks = Array.from({ length: 20 }, (_, index) => ({
      id: index,
      title: `Task ${index}`,
      description: null,
      updatedAt: "2026-01-04T00:00:00Z",
      sessionCount: 0,
      sessions: null,
    }));
    store.completedHasMore = true;
    store.loaded = true;
    const history = new ProjectHistory();
    Reflect.set(history, "store", store);

    const output = fullOutput(history.render());
    expect(output).toContain("Task 19");
    expect(output).toContain("20+");
    expect(output).toContain("Show more");
  });

  test("shows a useful empty state after history loads", () => {
    const store = new ProjectHistoryStore(7);
    store.loaded = true;
    const history = new ProjectHistory();
    history.projectName = "Reins";
    Reflect.set(history, "store", store);

    expect(fullOutput(history.render())).toContain("No project history yet");
  });
});
