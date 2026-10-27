import { afterEach, describe, expect, test } from "bun:test";
import type { PropertyValues } from "lit";
import { NewSessionPage, type NewSessionView } from "../../components/new-session-page.js";
import { SendHandoff } from "../../models/send-handoff.js";
import { templateToString } from "../helpers/lit-template.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";

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

/**
 * A page for `view` over an app that records the sessions it creates (`new-1`, `new-2`, …), the models
 * it sets and the prompts it submits; `fail` makes creating or prompting fail.
 */
function pageFor(view: NewSessionView, fail: { create?: string; prompt?: boolean } = {}) {
  const calls: unknown[] = [];
  const sendHandoff = new SendHandoff();
  let created = 0;
  const app = {
    projects: [],
    commands: null,
    sendHandoff,
    projectsStore: {
      createSession: async (projectId: number, input: object) => {
        if (fail.create) return { error: fail.create };
        calls.push({ create: projectId, ...input });
        return { sessionId: `new-${++created}` };
      },
      getStore: () => ({ tasks: [], skills: [], subscribe: () => () => {} }),
      ensureLoaded: async () => {},
      subscribe: () => () => {},
    },
    sessionOperations: {
      submit: (sessionId: string, op: string, content: unknown) => {
        calls.push({ [op]: sessionId, content });
        return fail.prompt ? null : { entry: { localId: "submission-1" }, admitted: Promise.resolve() };
      },
      setModel: async (sessionId: string, model: object) => {
        calls.push({ setModel: sessionId, ...model });
        return { id: sessionId };
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
  const upload: (attachments: object[]) => Promise<unknown> = Reflect.get(page, "upload");
  return { page, calls, sendHandoff, submit, upload, fail };
}

/** Attachment uploads recorded by session, failing while `failing.upload` is set. */
function recordUploads(calls: unknown[], failing = { upload: false }) {
  mockFetch((url) => {
    calls.push({ upload: url.match(/sessions\/([^/]+)\/attachments/)?.[1] });
    return failing.upload ? Response.json({ error: "The upload failed" }, { status: 500 }) : Response.json({ attachments: [] });
  });
  return failing;
}

const source = { rect: { left: 10, top: 500, width: 600, height: 40 } };
const content = [{ type: "text", text: "Plan the migration" }];
const image = { file: new File([""], "a.png", { type: "image/png" }), mimeType: "image/png", filename: "a.png" };
const opus = { runtimeType: "pi", provider: "anthropic", modelId: "claude-opus-4", thinkingLevel: "high" };
const opusCreated = { provider: "anthropic", modelId: "claude-opus-4", thinkingLevel: "high" };

afterEach(() => {
  for (const [key, value] of Object.entries(originals)) Reflect.set(globalThis, key, value);
  restoreFetch();
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

  test("creates the session with the model chosen in the same request, or the default without one", async () => {
    installBrowser("#/new?project=7");
    const chosen = pageFor({ view: "new-session", projectId: 7, taskId: null });
    const unchosen = pageFor({ view: "new-session", projectId: 7, taskId: null });
    Reflect.set(chosen.page, "model", opus);

    await chosen.submit({ content, source });
    await unchosen.submit({ content, source });

    expect(chosen.calls).toEqual([{ create: 7, model: opusCreated }, { prompt: "new-1", content }]);
    expect(unchosen.calls).toEqual([{ create: 7 }, { prompt: "new-1", content }]);
  });

  test("uploads attachments to the session it creates for them, then sends the message there, without setting its model again", async () => {
    installBrowser("#/new?project=7");
    const { page, calls, submit, upload } = pageFor({ view: "new-session", projectId: 7, taskId: null });
    Reflect.set(page, "model", opus);
    recordUploads(calls);

    await upload([image]);
    await submit({ content, source });

    expect(calls).toEqual([{ create: 7, model: opusCreated }, { upload: "new-1" }, { prompt: "new-1", content }]);
  });

  test("tries again in a session it created when a later step failed, unless the project or task changed", async () => {
    installBrowser("#/new?project=7");
    const { page, calls, upload } = pageFor({ view: "new-session", projectId: 7, taskId: null });
    const failing = recordUploads(calls, { upload: true });

    await expect(upload([image])).rejects.toThrow();
    failing.upload = false;
    await upload([image]);
    page.view = { view: "new-session", projectId: 7, taskId: 3 };
    await upload([image]);

    expect(calls).toEqual([{ create: 7 }, { upload: "new-1" }, { upload: "new-1" }, { create: 7, taskId: 3 }, { upload: "new-2" }]);
  });

  test("sets a model chosen after the session was created when it is sent again", async () => {
    const entries = installBrowser("#/new?project=7");
    const { page, calls, submit, fail } = pageFor({ view: "new-session", projectId: 7, taskId: null }, { prompt: true });
    const sonnet = { ...opus, modelId: "claude-sonnet-4" };
    Reflect.set(page, "model", opus);

    await expect(submit({ content, source })).rejects.toThrow("The message could not be sent");
    fail.prompt = false;
    Reflect.set(page, "model", sonnet);
    await submit({ content, source });

    expect(calls).toEqual([
      { create: 7, model: opusCreated },
      { prompt: "new-1", content },
      { setModel: "new-1", ...sonnet },
      { prompt: "new-1", content },
    ]);
    expect(entries).toEqual(["#/session/new-1"]);
  });

  test("rejects with the server's refusal to create the session, sending nothing more", async () => {
    const entries = installBrowser("#/new?project=7&task=3");
    const { calls, submit } = pageFor({ view: "new-session", projectId: 7, taskId: 3 }, { create: "Task 3 is not a task of this project" });

    await expect(submit({ content, source })).rejects.toThrow("Task 3 is not a task of this project");
    expect(calls).toEqual([]);
    expect(entries).toEqual(["#/new?project=7&task=3"]);
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
