import { afterEach, describe, expect, test } from "bun:test";
import {
  TaskList,
  createTaskListDisclosureState,
} from "../../components/task-list.js";
import { ProjectStore } from "../../models/stores/project-store.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { TaskListItem } from "../../models/tasks.js";
import { makeTask } from "../helpers/fixtures.js";
import {
  collectTemplateValues,
  isTemplateResult,
  templateToString,
} from "../helpers/lit-template.js";
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
  test("renders only active project tasks", () => {
    const el = new TaskList();
    const store = projectStore(1);
    store.tasks = [
      makeTask({ id: 1, title: "Active task", status: "open" }),
      makeTask({ id: 2, title: "Finished task", status: "closed" }),
    ];
    el.projectStore = store;

    const output = templateToString(collectTemplateValues(el.render()));
    expect(output.match(/<task-list-item/g)).toHaveLength(1);
    expect(output).not.toContain("Completed tasks");
  });

  test("restores disclosure state when the task list remounts", () => {
    mockFetch(() => Response.json([]));
    const disclosureState = createTaskListDisclosureState();
    const task = makeTask({ id: 2, title: "Task 2" });
    const first = new TaskList();
    first.disclosureState = disclosureState;
    first.projectStore = projectStore(1);

    Reflect.apply(Reflect.get(first, "handleToggleExpand"), first, [
      new CustomEvent("toggle-expand", { detail: { taskId: task.id } }),
    ]);

    const replacement = new TaskList();
    replacement.disclosureState = disclosureState;
    expectExpanded(replacement, task, true);
  });

  test("does not replace a manually expanded task when remounting for the same session", () => {
    mockFetch(() => Response.json([]));
    const disclosureState = createTaskListDisclosureState();
    const store = projectStore(1);
    const firstTask = makeTask({ id: 1, title: "Task 1" });
    const secondTask = makeTask({ id: 2, title: "Task 2" });
    const first = new TaskList();
    first.disclosureState = disclosureState;
    first.projectStore = store;
    first.activeSessionId = "session-1";
    first.willUpdate(new Map([["activeSessionId", ""]]));
    Reflect.apply(Reflect.get(first, "handleToggleExpand"), first, [
      new CustomEvent("toggle-expand", { detail: { taskId: secondTask.id } }),
    ]);

    const replacement = new TaskList();
    replacement.disclosureState = disclosureState;
    replacement.projectStore = store;
    replacement.activeSessionId = "session-1";
    replacement.willUpdate(new Map([["activeSessionId", ""]]));

    expectExpanded(replacement, firstTask, false);
    expectExpanded(replacement, secondTask, true);
  });

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
