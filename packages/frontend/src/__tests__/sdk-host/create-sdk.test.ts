import { afterEach, describe, expect, test } from "bun:test";
import { ReinsHttpError } from "@reins/client";
import type { FileReferenceView } from "../../extensions/message-file-references/message-file-references.js";
import type { DecorationSpan, MessageDecorator, Source } from "@reins/sdk";
import type { DecoratedSegment } from "../../sdk-host/decorators.js";
import { shownNewSession, shownSession, testSdk } from "../helpers/reins-sdk.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";

const source: Source = { nodeId: "node", path: "/work" };

const filePane = {
  title: () => "plan.md",
  description: () => "docs/plan.md",
  icon: { mount: () => {} },
  mount: () => {},
};
const fileRenderer = { pane: filePane };

/** Shows a file reference inline as its text. */
const inlineReference = { inline: { mount: () => {} } };

/** Decorates every occurrence of a word with a reference to a file named after it; `changed` says its data changed. */
function wordDecorator(word: string) {
  const listeners = new Set<() => void>();
  const view: FileReferenceView = { view: "file-reference", source, path: `${word}.md` };
  const decorator: MessageDecorator = {
    decorate: (text) => [...text.matchAll(new RegExp(word, "g"))].map((match): DecorationSpan => ({ start: match.index, end: match.index + word.length, view })),
    decorateCode: (code) => (code === word ? view : null),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { decorator, changed: () => { for (const listener of listeners) listener(); }, listeners };
}

/** Segments as plain text and each piece's text and view path. */
function pieces(segments: DecoratedSegment[] | undefined) {
  return segments?.map((segment) => (typeof segment === "string" ? segment : { text: segment.context.text, path: "path" in segment.view ? segment.view.path : null }));
}

describe("views.register", () => {
  test("gives containers a view's renderer until it is disposed", () => {
    const { reins, views } = testSdk();
    let changes = 0;
    views.subscribe(() => { changes += 1; });

    const dispose = reins.views.register("file", fileRenderer);
    expect(views.rendererFor({ view: "file", source, path: "docs/plan.md" })).toBe(fileRenderer);

    dispose();
    expect(views.rendererFor({ view: "file", source, path: "docs/plan.md" })).toBeNull();
    expect(changes).toBe(2);
  });

  test("keys a view by its name and what its renderer's key tells apart", () => {
    const { reins, views } = testSdk();
    reins.views.register("file", { ...fileRenderer, key: (view) => view.path });
    reins.views.register("diff-file-tree", fileRenderer);

    expect(views.keyOf({ view: "file", source, path: "README.md", startLine: 3 })).toBe(views.keyOf({ view: "file", source, path: "README.md" }));
    expect(views.keyOf({ view: "file", source, path: "README.md" })).not.toBe(views.keyOf({ view: "file", source, path: "docs/plan.md" }));
    expect(views.keyOf({ view: "diff-file-tree", extra: 1 })).toBe(views.keyOf({ view: "diff-file-tree" }));
    expect(views.keyOf({ view: "dashboard" })).toBe("dashboard");
  });

  test("refuses a second renderer for a name and a renderer without a presentation", () => {
    const { reins } = testSdk();
    reins.views.register("file", fileRenderer);

    expect(() => reins.views.register("file", fileRenderer)).toThrow();
    expect(() => reins.views.register("file-reference", {})).toThrow();
  });

  test("registers and opens a view that only JavaScript names, as an extension without TypeScript does", async () => {
    const { reins, views, opened } = testSdk();
    // A specifier TypeScript cannot follow, so it imports the extension as the untyped code it is.
    const specifier = "../helpers/plain-javascript-extension.js";
    const { registerGreeting } = await import(specifier);

    registerGreeting(reins);

    const view = { view: "greeting", name: "Ada" };
    expect(opened).toEqual([{ view, container: "inspector" }]);
    expect(views.rendererFor(view)?.pane?.title(view, { source: null })).toBe("Hello, Ada");
    expect(views.keyOf(view)).toBe("greeting:Ada");
  });

  test("checks the views that typed features register and open against their ViewTypes entries", () => {
    const { reins, opened } = testSdk();

    // @ts-expect-error: a file view needs its path
    reins.workspace.open({ view: "file", source });
    // @ts-expect-error: no feature adds this name to ViewTypes
    reins.workspace.open({ view: "flie", source, path: "README.md" });
    // @ts-expect-error: a file view's path is a string
    reins.views.register("file", { ...fileRenderer, key: (view) => view.path.toFixed() });

    expect(opened).toHaveLength(2);
  });
});

describe("workspace.open", () => {
  test("opens the view in the Inspector unless another container is named", () => {
    const { reins, opened } = testSdk();

    reins.workspace.open({ view: "file", source, path: "README.md", startLine: 3 });

    expect(opened).toEqual([{ view: { view: "file", source, path: "README.md", startLine: 3 }, container: "inspector" }]);
  });

  test("shows a session view, or the new session page, opened in the main area by going to its route", () => {
    const { reins, opened, shownViews } = testSdk();

    reins.workspace.open({ view: "session", sessionId: "s1" }, { in: "main" });
    reins.workspace.open({ view: "new-session", projectId: 7, taskId: null }, { in: "main" });

    expect(shownViews).toEqual([{ view: "session", sessionId: "s1" }, { view: "new-session", projectId: 7, taskId: null }]);
    expect(opened).toEqual([]);
  });

  test("refuses any other view in the main area, and a session view without a session ID, as registered views are not shown there yet", () => {
    const { reins, shownViews } = testSdk();

    expect(() => reins.workspace.open({ view: "file", source, path: "README.md" }, { in: "main" })).toThrow('The main area cannot show the "file" view');
    // @ts-expect-error: as an extension without TypeScript can
    expect(() => reins.workspace.open({ view: "session" }, { in: "main" })).toThrow('The main area cannot show the "session" view');
    expect(shownViews).toEqual([]);
  });
});

describe("workspace.current", () => {
  test("gives the view the main area shows and what it is about, and the most specific subject of a type", () => {
    const { reins } = testSdk({ current: shownSession("s1", { projectId: 7, taskId: 3 }) });

    expect(reins.workspace.current()).toEqual(shownSession("s1", { projectId: 7, taskId: 3 }));
    expect([reins.workspace.currentSubject("session"), reins.workspace.currentSubject("task"), reins.workspace.currentSubject("project")]).toEqual(["s1", 3, 7]);
  });

  test("gives no subject of a type the view is not about, and nothing on a page that is not a view", () => {
    const draft = testSdk({ current: shownNewSession(7) });
    const nowhere = testSdk();

    expect([draft.reins.workspace.currentSubject("session"), draft.reins.workspace.currentSubject("project")]).toEqual([null, 7]);
    expect(nowhere.reins.workspace.current()).toBeNull();
    expect(nowhere.reins.workspace.currentSubject("session")).toBeNull();
  });
});

describe("sessions", () => {
  test("reaches the app's sessions with every operation", async () => {
    const { reins, sessionCalls } = testSdk({ sessions: { get: async (id) => ({ id, projectId: 7, taskId: null, parentSessionId: null, name: null, source }) } });

    expect((await reins.sessions.get("s1")).projectId).toBe(7);
    await reins.sessions.create({ projectId: 7 });
    await reins.sessions.send("s1", "Also cover the CLI");
    await reins.sessions.compact("s1", "Keep the API names");

    expect(sessionCalls).toEqual([
      { create: { projectId: 7 } },
      { send: "s1", message: "Also cover the CLI" },
      { compact: "s1", instructions: "Keep the API names" },
    ]);
  });
});

describe("messages.registerDecorator", () => {
  test("decorates prose, plain text and inline code with views shown inline, an earlier decorator winning an overlap", () => {
    const { reins, decorators } = testSdk();
    reins.views.register("file-reference", inlineReference);
    reins.messages.registerDecorator(wordDecorator("plan").decorator);
    reins.messages.registerDecorator(wordDecorator("planning").decorator);
    reins.messages.registerDecorator(wordDecorator("notes").decorator);
    const bound = decorators.bind(source);

    expect(pieces(bound?.segments("planning notes"))).toEqual([
      { text: "plan", path: "plan.md" },
      "ning ",
      { text: "notes", path: "notes.md" },
    ]);
    expect(pieces(bound?.plainText("Edit plan:\n```\ncat plan\n```\ndone"))).toEqual([
      "Edit ",
      { text: "plan", path: "plan.md" },
      ":\n```\ncat plan\n```\ndone",
    ]);
    const code = bound?.code("notes");
    expect(code?.view).toEqual({ view: "file-reference", source, path: "notes.md" });
    expect(code?.presentation).toBe(inlineReference.inline);
    expect(code?.context).toMatchObject({ source, text: "notes", code: true });
    expect(bound?.code("other")).toBeNull();
  });

  test("leaves the text of a view that cannot be shown inline as it is", () => {
    const { reins, decorators } = testSdk();
    reins.views.register("file-reference", fileRenderer);
    reins.messages.registerDecorator(wordDecorator("plan").decorator);
    const bound = decorators.bind(source);

    expect(bound?.segments("the plan")).toEqual(["the plan"]);
    expect(bound?.code("plan")).toBeNull();
  });

  test("keeps the same bound decorators until a decorator or a view changes or the source changes", () => {
    const { reins, decorators } = testSdk();
    const plan = wordDecorator("plan");
    let changes = 0;
    decorators.subscribe(() => { changes += 1; });
    reins.messages.registerDecorator(plan.decorator);
    const first = decorators.bind(source);

    expect(decorators.bind({ ...source })).toBe(first);
    plan.changed();
    const second = decorators.bind(source);
    expect(second).not.toBe(first);
    reins.views.register("file-reference", inlineReference);
    const third = decorators.bind(source);
    expect(third).not.toBe(second);
    expect(decorators.bind({ ...source, path: "/other" })).not.toBe(third);
    expect(changes).toBe(3);
  });

  test("stops applying a disposed decorator and stops listening to it", () => {
    const { reins, decorators } = testSdk();
    const plan = wordDecorator("plan");
    const dispose = reins.messages.registerDecorator(plan.decorator);

    dispose();

    expect(decorators.bind(source)).toBeNull();
    expect(plan.listeners.size).toBe(0);
  });
});

describe("an extension's own SDK", () => {
  afterEach(restoreFetch);

  function recordRequests(respond: (init?: RequestInit) => Response) {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    mockFetch((url, init) => {
      requests.push({ method: init?.method ?? "GET", url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return respond(init);
    });
    return requests;
  }

  test("calls its own backend part's methods, resolving with their output and nothing for a 204", async () => {
    const requests = recordRequests((init) => (String(init?.body).includes("remove") ? new Response(null, { status: 204 }) : Response.json({ id: 7 })));
    const { reins } = testSdk({ extension: { name: "mcp", label: "MCP" } });

    expect(await reins.http.call("create", { name: "executor" })).toEqual({ id: 7 });
    expect(await reins.http.call("remove", { id: "remove" })).toBeUndefined();

    expect(requests).toEqual([
      { method: "POST", url: "/api/extensions/mcp/create", body: { name: "executor" } },
      { method: "POST", url: "/api/extensions/mcp/remove", body: { id: "remove" } },
    ]);
  });

  test("rejects a refused call with the server's message and status", async () => {
    recordRequests(() => Response.json({ error: "No such server" }, { status: 404 }));
    const { reins } = testSdk({ extension: { name: "mcp", label: "MCP" } });

    const failure = await reins.http.call("get", { id: 9 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReinsHttpError);
    expect(failure).toMatchObject({ status: 404, message: "No such server" });
  });

  test("hears only its own messages, as they were sent, until disposed", () => {
    const { reins, client } = testSdk({ extension: { name: "mcp", label: "MCP" } });
    const heard: object[] = [];
    const dispose = reins.onMessage((message) => heard.push(message));

    client.fireMessage({ type: "extension", extension: "other", message: { type: "mcp_server_removed", serverId: 1 } });
    client.fireMessage({ type: "extension", extension: "mcp", message: { type: "mcp_server_removed", serverId: 2 } });
    client.fireMessage({ type: "node_removed", nodeId: "n1" });
    dispose();
    client.fireMessage({ type: "extension", extension: "mcp", message: { type: "mcp_server_removed", serverId: 3 } });

    expect(heard).toEqual([{ type: "mcp_server_removed", serverId: 2 }]);
  });

  test("is told when the connection comes back after it was lost, not when it first connects", () => {
    const { reins, client } = testSdk();
    let reconnects = 0;
    const dispose = reins.onReconnect(() => { reconnects += 1; });

    client.fireConnection(true);
    expect(reconnects).toBe(0);
    client.fireConnection(false);
    client.fireConnection(true);
    expect(reconnects).toBe(1);

    dispose();
    client.fireConnection(false);
    client.fireConnection(true);
    expect(reconnects).toBe(1);
  });
});

/** Settings that draw nothing. */
function settings() {
  return { mount: () => {} };
}

describe("settings.register", () => {
  test("gives each extension with settings one Settings page, by label", () => {
    const { sdkFor, settingsPages } = testSdk();
    const mcpSettings = settings();
    sdkFor({ name: "mcp", label: "MCP", description: "Remote MCP servers." }).settings.register(mcpSettings);
    sdkFor({ name: "todos", label: "Lists" }).settings.register(settings());
    sdkFor({ name: "quiet", label: "Has no settings" });

    expect(settingsPages.pages().map((page) => page.extension.label)).toEqual(["Lists", "MCP"]);
    expect(settingsPages.page("mcp")).toEqual({ extension: { name: "mcp", label: "MCP", description: "Remote MCP servers." }, settings: mcpSettings });
    expect(settingsPages.page("quiet")).toBeNull();
  });

  test("drops the page when its registration is disposed", () => {
    const { reins, settingsPages } = testSdk({ extension: { name: "mcp", label: "MCP" } });
    let changes = 0;
    settingsPages.subscribe(() => { changes += 1; });
    const dispose = reins.settings.register(settings());

    dispose();
    dispose();

    expect(settingsPages.pages()).toEqual([]);
    expect(changes).toBe(2);
  });

  test("refuses a second registration while the extension has one", () => {
    const { reins } = testSdk({ extension: { name: "mcp", label: "MCP" } });
    const dispose = reins.settings.register(settings());

    expect(() => reins.settings.register(settings())).toThrow();
    dispose();
    expect(() => reins.settings.register(settings())).not.toThrow();
  });
});
