import { afterEach, describe, expect, test } from "bun:test";
import type { Task } from "@reins/sdk";
import {
  TaskList,
  createTaskListDisclosureState,
} from "../../../../extensions/sidebar/projects/task-list.js";
import { makeSessionListItem, makeTask, makeTaskSummary } from "../../../helpers/fixtures.js";
import {
  collectTemplateValues,
  isTemplateResult,
  templateToString,
} from "../../../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../../../helpers/mock-fetch.js";
import { testSdk } from "../../../helpers/reins-sdk.js";

function expectExpanded(el: TaskList, item: Task, expanded: boolean) {
  const rendered = Reflect.apply(Reflect.get(el, "renderTask"), el, [item]);
  if (!isTemplateResult(rendered)) throw new Error("Expected task template");
  const index = rendered.strings.findIndex((part) => part.includes(".expanded="));
  expect(index).toBeGreaterThanOrEqual(0);
  expect(rendered.values[index]).toBe(expanded);
}

/** The SDK over a project 1 whose sessions `session-1` and `session-2` are of task `activeTaskId`. */
function sdkWithSessions(activeTaskId: number) {
  mockFetch(() => Response.json([]));
  const sdk = testSdk();
  sdk.sessions.setMany([makeSessionListItem("session-1", { taskId: activeTaskId }), makeSessionListItem("session-2", { taskId: activeTaskId })]);
  return sdk.reins;
}

function taskList(reins = sdkWithSessions(1)) {
  const el = new TaskList();
  el.projectId = 1;
  el.reins = reins;
  return el;
}

afterEach(restoreFetch);

describe("TaskList expansion", () => {
  test("renders only open project tasks", async () => {
    const sdk = testSdk();
    mockFetch(() => Response.json([makeTask({ id: 1, title: "Active task", status: "open" }), makeTask({ id: 2, title: "Finished task", status: "closed" })]));
    const el = taskList(sdk.reins);
    el.render();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const output = templateToString(collectTemplateValues(el.render()));
    expect(output.match(/<task-list-item/g)).toHaveLength(1);
  });

  test("restores disclosure state when the task list remounts", () => {
    const disclosureState = createTaskListDisclosureState();
    const task = makeTaskSummary({ id: 2, title: "Task 2" });
    const first = taskList();
    first.disclosureState = disclosureState;

    Reflect.apply(Reflect.get(first, "handleToggleExpand"), first, [
      new CustomEvent("toggle-expand", { detail: { taskId: task.id } }),
    ]);

    const replacement = taskList();
    replacement.disclosureState = disclosureState;
    expectExpanded(replacement, task, true);
  });

  test("does not replace a manually expanded task when remounting for the same session", () => {
    const disclosureState = createTaskListDisclosureState();
    const reins = sdkWithSessions(1);
    const firstTask = makeTaskSummary({ id: 1, title: "Task 1" });
    const secondTask = makeTaskSummary({ id: 2, title: "Task 2" });
    const first = taskList(reins);
    first.disclosureState = disclosureState;
    first.activeSessionId = "session-1";
    first.willUpdate(new Map([["activeSessionId", ""]]));
    Reflect.apply(Reflect.get(first, "handleToggleExpand"), first, [
      new CustomEvent("toggle-expand", { detail: { taskId: secondTask.id } }),
    ]);

    const replacement = taskList(reins);
    replacement.disclosureState = disclosureState;
    replacement.activeSessionId = "session-1";
    replacement.willUpdate(new Map([["activeSessionId", ""]]));

    expectExpanded(replacement, firstTask, false);
    expectExpanded(replacement, secondTask, true);
  });

  test("does not replace a manually expanded task during unrelated updates", () => {
    const el = taskList();
    const firstTask = makeTaskSummary({ id: 1, title: "Task 1" });
    const secondTask = makeTaskSummary({ id: 2, title: "Task 2" });
    el.activeSessionId = "session-1";

    el.willUpdate(new Map([["activeSessionId", ""]]));
    expectExpanded(el, firstTask, true);

    Reflect.apply(Reflect.get(el, "handleToggleExpand"), el, [
      new CustomEvent("toggle-expand", { detail: { taskId: secondTask.id } }),
    ]);
    el.willUpdate(new Map());

    expectExpanded(el, firstTask, false);
    expectExpanded(el, secondTask, true);
  });

  test("expands the active session task when activeSessionId changes", () => {
    const el = taskList(sdkWithSessions(2));
    const firstTask = makeTaskSummary({ id: 1, title: "Task 1" });
    const secondTask = makeTaskSummary({ id: 2, title: "Task 2" });
    Reflect.apply(Reflect.get(el, "handleToggleExpand"), el, [
      new CustomEvent("toggle-expand", { detail: { taskId: firstTask.id } }),
    ]);
    el.activeSessionId = "session-2";

    el.willUpdate(new Map([["activeSessionId", "session-1"]]));

    expectExpanded(el, firstTask, false);
    expectExpanded(el, secondTask, true);
  });
});
