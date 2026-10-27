import { afterEach, describe, expect, test } from "bun:test";
import type { PropertyValues } from "lit";
import { NewSessionPage, type NewSessionView } from "../../components/new-session-page.js";
import { SendHandoff } from "../../models/send-handoff.js";
import { templateToString } from "../helpers/lit-template.js";

const originals = {
  navigator: globalThis.navigator,
  location: globalThis.location,
  history: globalThis.history,
  window: globalThis.window,
  HashChangeEvent: Reflect.get(globalThis, "HashChangeEvent"),
};

/** A browser whose history entries are recorded, so a replaced entry is observable. */
function installBrowser(hash: string) {
  const entries = [hash];
  const location = { hash };
  Reflect.set(globalThis, "location", new Proxy(location, {
    set(target, key, value) {
      if (key === "hash") entries.push(value);
      return Reflect.set(target, key, value);
    },
  }));
  Reflect.set(globalThis, "history", {
    replaceState: (_state: unknown, _title: string, url: string) => {
      entries[entries.length - 1] = url;
      location.hash = url;
    },
  });
  Reflect.set(globalThis, "window", { dispatchEvent() {} });
  Reflect.set(globalThis, "HashChangeEvent", class extends Event {});
  return entries;
}

/** A page for `view` over an app that records the sessions it creates and the prompts it submits. */
function pageFor(view: NewSessionView) {
  const calls: unknown[] = [];
  const sendHandoff = new SendHandoff();
  const app = {
    projects: [],
    commands: null,
    sendHandoff,
    projectsStore: {
      createSession: async (projectId: number, input: object) => { calls.push({ create: projectId, ...input }); return { sessionId: "new-1" }; },
      getStore: () => ({ tasks: [], skills: [], subscribe: () => () => {} }),
      ensureLoaded: async () => {},
      subscribe: () => () => {},
    },
    sessionOperations: {
      submit: (sessionId: string, op: string, content: unknown) => {
        calls.push({ [op]: sessionId, content });
        return { entry: { localId: "submission-1" }, admitted: Promise.resolve() };
      },
    },
    sessionCache: { set() {}, fetchDetail: async () => {} },
  };
  const page = new NewSessionPage();
  Reflect.set(page, "app", app);
  page.view = view;
  const changed: PropertyValues<NewSessionPage> = new Map();
  changed.set("app", null);
  changed.set("view", view);
  page.willUpdate(changed);
  const submit: (detail: object) => Promise<void> = Reflect.get(page, "submit");
  return { page, calls, sendHandoff, submit };
}

const source = { rect: { left: 10, top: 500, width: 600, height: 40 } };
const content = [{ type: "text", text: "Plan the migration" }];

afterEach(() => {
  for (const [key, value] of Object.entries(originals)) Reflect.set(globalThis, key, value);
});

describe("NewSessionPage", () => {
  test("creates the session when its first message is sent, hands the message to the session's page, and replaces itself with it", async () => {
    const entries = installBrowser("#/new?project=7&task=3");
    const { calls, sendHandoff, submit } = pageFor({ view: "new-session", projectId: 7, taskId: 3 });

    await submit({ content, source });

    expect(calls).toEqual([{ create: 7, taskId: 3 }, { prompt: "new-1", content }]);
    expect(sendHandoff.take("new-1")).toEqual({ sessionId: "new-1", messageKey: "submission-1", source });
    expect(entries).toEqual(["#/session/new-1"]);
  });

  test("shows its choices under the composer, not in it", () => {
    const { page } = pageFor({ view: "new-session", projectId: 7, taskId: null });

    const output = templateToString(page.render());

    expect(output.indexOf("</chat-composer>")).toBeLessThan(output.indexOf('data-role="choices"'));
    expect(output.indexOf('data-role="choices"')).toBeLessThan(output.indexOf('data-role="project-choice"'));
    expect(output.indexOf('data-role="project-choice"')).toBeLessThan(output.indexOf('data-role="task-choice"'));
    expect(output.indexOf('data-role="task-choice"')).toBeLessThan(output.indexOf("<model-picker"));
  });

  test("refuses to send before a project is chosen", async () => {
    const entries = installBrowser("#/new");
    const { calls, submit } = pageFor({ view: "new-session", projectId: null, taskId: null });

    await expect(submit({ content, source })).rejects.toThrow("Choose a project to start a session in");
    expect(calls).toEqual([]);
    expect(entries).toEqual(["#/new"]);
  });

  test("focuses its composer when it opens and when a choice changes, except on a touch screen, where that would open the keyboard", () => {
    const focusFor = (maxTouchPoints: number) => {
      Reflect.set(globalThis, "window", {});
      Reflect.set(globalThis, "navigator", { maxTouchPoints });
      const { page } = pageFor({ view: "new-session", projectId: 7, taskId: null });
      let focused = 0;
      Object.defineProperty(page, "composer", { value: { focusInput: () => { focused += 1; } } });
      const changed: PropertyValues<NewSessionPage> = new Map();
      changed.set("view", { view: "new-session", projectId: null, taskId: null });
      page.updated(changed);
      page.updated(new Map());
      return focused;
    };

    expect(focusFor(0)).toBe(1);
    expect(focusFor(5)).toBe(0);
  });

  test("keeps the project and task chosen in its URL, in place of its history entry", () => {
    const entries = installBrowser("#/new?project=7&task=3");
    const { page } = pageFor({ view: "new-session", projectId: 7, taskId: 3 });
    const choose: (projectId: number | null, taskId: number | null) => void = Reflect.get(page, "choose").bind(page);

    choose(9, null);

    expect(entries).toEqual(["#/new?project=9"]);
  });
});
