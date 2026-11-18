import { afterEach, describe, expect, test } from "bun:test";
import type { Tasks } from "@reins/sdk";
import { TaskForm } from "../../../../extensions/sidebar/projects/task-form.js";
import { collectTemplateEventListeners, submitDialog } from "../../../helpers/lit-template.js";

const originalInput = globalThis.HTMLInputElement;
const originalTextArea = globalThis.HTMLTextAreaElement;
class TestField extends EventTarget { value = ""; checked = false; }

afterEach(() => {
  Reflect.set(globalThis, "HTMLInputElement", originalInput);
  Reflect.set(globalThis, "HTMLTextAreaElement", originalTextArea);
});

/** Fires the form's only `@input` (the request) or `@change` (the branch checkbox) with `field`. */
function fire(form: TaskForm, event: "input" | "change", field: Partial<TestField>) {
  Reflect.set(globalThis, event === "input" ? "HTMLTextAreaElement" : "HTMLInputElement", TestField);
  const target = Object.assign(new TestField(), field);
  const fired = new Event(event);
  Object.defineProperty(fired, "target", { value: target });
  collectTemplateEventListeners(form.render(), event).at(-1)?.(fired);
}

describe("TaskForm", () => {
  const created: Array<{ request: string; options: unknown }> = [];
  const open = () => {
    created.length = 0;
    const form = new TaskForm();
    const tasks: Tasks = {
      list: () => [], loaded: () => true, onDidChange: () => () => {}, update: async () => {}, remove: async () => {},
      create: async (_projectId, request, options) => { created.push({ request, options }); },
    };
    form.tasks = tasks;
    form.open(7);
    return form;
  };

  test("creates a task without a branch of its own unless the user asks for one", async () => {
    const plain = open();
    fire(plain, "input", { value: "Revise the agenda" });
    submitDialog(plain.render());
    await Bun.sleep(1);
    expect(created).toEqual([{ request: "Revise the agenda", options: { branch: false } }]);

    const branched = open();
    fire(branched, "input", { value: "Add dark mode" });
    fire(branched, "change", { checked: true });
    submitDialog(branched.render());
    await Bun.sleep(1);
    expect(created).toEqual([{ request: "Add dark mode", options: { branch: true } }]);
  });
});
