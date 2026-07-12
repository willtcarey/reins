import { afterEach, describe, expect, test } from "bun:test";
import { TaskList } from "../../components/task-list.js";
import { ProjectStore } from "../../models/stores/project-store.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { TaskListItem } from "../../models/tasks.js";
import { makeTask } from "../helpers/fixtures.js";
import { isTemplateResult } from "../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";

function expectExpanded(el: TaskList, item: TaskListItem, expanded: boolean) {
  const rendered = Reflect.apply(Reflect.get(el, "renderTask"), el, [item]);
  if (!isTemplateResult(rendered)) throw new Error("Expected task template");
  const index = rendered.strings.findIndex((part) => part.includes(".expanded="));
  expect(index).toBeGreaterThanOrEqual(0);
  expect(rendered.values[index]).toBe(expanded);
}

function projectStore(activeTaskId: number) {
  const sessionCache = new SessionCache();
  sessionCache.set("session-1", { projectId: 1, taskId: activeTaskId });
  sessionCache.set("session-2", { projectId: 1, taskId: activeTaskId });
  return new ProjectStore(1, sessionCache);
}

afterEach(restoreFetch);

describe("TaskList expansion", () => {
  test("does not replace a manually expanded task during unrelated updates", () => {
    mockFetch(() => Response.json([]));
    const el = new TaskList();
    const firstTask = makeTask({ id: 1, title: "Task 1" });
    const secondTask = makeTask({ id: 2, title: "Task 2" });
    el.projectStore = projectStore(1);
    el.activeSessionId = "session-1";

    el.willUpdate(new Map([
      ["projectStore", null],
      ["activeSessionId", ""],
    ]));
    expectExpanded(el, firstTask, true);

    Reflect.apply(Reflect.get(el, "handleToggleExpand"), el, [
      new CustomEvent("toggle-expand", { detail: { taskId: secondTask.id } }),
    ]);
    el.willUpdate(new Map());

    expectExpanded(el, firstTask, false);
    expectExpanded(el, secondTask, true);
  });

  test("expands the active session task when activeSessionId changes", () => {
    mockFetch(() => Response.json([]));
    const el = new TaskList();
    const firstTask = makeTask({ id: 1, title: "Task 1" });
    const secondTask = makeTask({ id: 2, title: "Task 2" });
    el.projectStore = projectStore(2);
    Reflect.apply(Reflect.get(el, "handleToggleExpand"), el, [
      new CustomEvent("toggle-expand", { detail: { taskId: firstTask.id } }),
    ]);
    el.activeSessionId = "session-2";

    el.willUpdate(new Map([["activeSessionId", "session-1"]]));

    expectExpanded(el, firstTask, false);
    expectExpanded(el, secondTask, true);
  });
});
