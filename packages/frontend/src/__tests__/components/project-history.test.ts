import { afterEach, describe, expect, test } from "bun:test";
import { ProjectHistory } from "../../components/project-history.js";
import {
  ProjectHistoryStore,
  type ArchivedSessionHistoryItem,
} from "../../models/stores/project-history-store.js";
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
      return Response.json([]);
    });
    const history = new ProjectHistory();
    history.projectId = 7;

    history.willUpdate(new Map([["projectId", 0]]));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(urls).toEqual([
      "/api/projects/7/sessions?archived=only",
      "/api/projects/7/tasks?status=closed",
    ]);
    expect(fullOutput(history.render())).toContain("No archived sessions or completed tasks yet");
  });

  test("renders archived sessions and completed tasks with project context", () => {
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
    }];
    store.loaded = true;
    const history = new ProjectHistory();
    history.projectName = "Reins";
    Reflect.set(history, "store", store);

    const output = fullOutput(history.render());

    expect(output).toContain("Reins History");
    expect(output).toContain("Archived sessions");
    expect(output).toContain("Archived research");
    expect(output).toContain("Frontend router");
    expect(output).toContain("Completed tasks");
    expect(output).toContain("1 session");
  });

  test("shows a useful empty state after history loads", () => {
    const store = new ProjectHistoryStore(7);
    store.loaded = true;
    const history = new ProjectHistory();
    history.projectName = "Reins";
    Reflect.set(history, "store", store);

    expect(fullOutput(history.render())).toContain("No archived sessions or completed tasks yet");
  });
});
