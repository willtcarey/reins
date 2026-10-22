import { describe, expect, test } from "bun:test";
import { reins } from "reins-sdk";
import { ProjectFiles } from "../../models/stores/project-files.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { DecorationSpan, MessageDecorator } from "../../reins-sdk/contract.js";
import { ReinsHost, installHost } from "../../reins-sdk/host.js";
import { installTestHost } from "../helpers/reins-sdk.js";
import { StubClient } from "../helpers/stub-client.js";

const fileRenderer = {
  title: () => "plan.md",
  description: () => "docs/plan.md",
  icon: "file" as const,
  element: "test-file-view",
};

/** Decorates every occurrence of a word with a view of the file it names; `changed` says its data changed. */
function wordDecorator(word: string) {
  const listeners = new Set<() => void>();
  const decoration = { view: { view: "file" as const, path: `${word}.md` }, label: word };
  const decorator: MessageDecorator = {
    decorate: (text) => [...text.matchAll(new RegExp(word, "g"))].map((match): DecorationSpan => ({ start: match.index, end: match.index + word.length, ...decoration })),
    decorateCode: (code) => (code === word ? decoration : null),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { decorator, changed: () => { for (const listener of listeners) listener(); }, listeners };
}

describe("reins", () => {
  test("throws when used before a host is installed", () => {
    expect(() => reins.files).toThrow();
  });

  test("reaches the one installed host until it is uninstalled", () => {
    const files = new ProjectFiles(new StubClient(), new SessionCache());
    const uninstall = installHost(new ReinsHost(files));
    try {
      expect(reins.files).toBe(files);
      expect(() => installHost(new ReinsHost(files))).toThrow();
    } finally {
      uninstall();
    }
    expect(() => reins.files).toThrow();
  });
});

describe("views.register", () => {
  test("gives the Inspector a view's renderer until it is disposed", () => {
    const { host } = installTestHost();
    let changes = 0;
    host.subscribe(() => { changes += 1; });

    const dispose = reins.views.register("file", fileRenderer);
    expect(host.renderer({ view: "file", path: "docs/plan.md" })).toBe(fileRenderer);

    dispose();
    expect(host.renderer({ view: "file", path: "docs/plan.md" })).toBeNull();
    expect(changes).toBe(2);
  });

  test("refuses a second renderer for a name, the changes view and an element name without a hyphen", () => {
    const { host } = installTestHost();
    reins.views.register("file", fileRenderer);

    expect(() => reins.views.register("file", fileRenderer)).toThrow();
    expect(() => reins.views.register("changes", { title: () => "", description: () => "", icon: "file", element: "my-changes" })).toThrow();
    host.dispose();
    expect(() => reins.views.register("file", { ...fileRenderer, element: "fileview" })).toThrow();
  });
});

describe("workspace.open", () => {
  test("reaches the workspace on screen, in the Inspector unless another container is named", () => {
    const { opened } = installTestHost();

    reins.workspace.open({ view: "file", path: "README.md", startLine: 3 });

    expect(opened).toEqual([{ view: { view: "file", path: "README.md", startLine: 3 }, container: "inspector", projectId: null }]);
  });

  test("names the project of the source a caller names, for the workspace to ignore a view of another", () => {
    const { opened, source } = installTestHost({ projectId: 7 });

    reins.workspace.open({ view: "file", path: "README.md" }, { in: "inspector", source });

    expect(opened.map(({ projectId }) => projectId)).toEqual([7]);
  });

  test("does nothing while no workspace is on screen", () => {
    const { host, opened } = installTestHost();
    const unmount = host.mountWorkspace({ open: () => { throw new Error("unmounted workspace reached"); } });
    unmount();

    reins.workspace.open({ view: "file", path: "README.md" });

    expect(opened).toEqual([]);
  });
});

describe("messages.registerDecorator", () => {
  test("decorates prose, plain text and inline code, an earlier decorator winning an overlap", () => {
    const { host, source } = installTestHost();
    reins.messages.registerDecorator(wordDecorator("plan").decorator);
    reins.messages.registerDecorator(wordDecorator("planning").decorator);
    reins.messages.registerDecorator(wordDecorator("notes").decorator);
    const decorations = host.decorations(source);

    expect(decorations?.segments("planning notes")).toEqual([
      { text: "plan", view: { view: "file", path: "plan.md" }, label: "plan" },
      "ning ",
      { text: "notes", view: { view: "file", path: "notes.md" }, label: "notes" },
    ]);
    expect(decorations?.plainText("Edit plan:\n```\ncat plan\n```\ndone")).toEqual([
      "Edit ",
      { text: "plan", view: { view: "file", path: "plan.md" }, label: "plan" },
      ":\n```\ncat plan\n```\ndone",
    ]);
    expect(decorations?.code("notes")?.view).toEqual({ view: "file", path: "notes.md" });
    expect(decorations?.code("other")).toBeNull();
  });

  test("keeps the same decorations until a decorator says its data changed or the source changes", () => {
    const { host, source } = installTestHost();
    const plan = wordDecorator("plan");
    reins.messages.registerDecorator(plan.decorator);
    const first = host.decorations(source);

    expect(host.decorations({ ...source })).toBe(first);
    plan.changed();
    const second = host.decorations(source);
    expect(second).not.toBe(first);
    expect(host.decorations({ ...source, path: "/other" })).not.toBe(second);
  });

  test("stops applying a disposed decorator and stops listening to it", () => {
    const { host, source } = installTestHost();
    const plan = wordDecorator("plan");
    const dispose = reins.messages.registerDecorator(plan.decorator);

    dispose();

    expect(host.decorations(source)).toBeNull();
    expect(plan.listeners.size).toBe(0);
  });

  test("opens an activated decoration's view in the Inspector, for the decorations' source", () => {
    const { host, source, opened } = installTestHost({ projectId: 4 });
    reins.messages.registerDecorator(wordDecorator("plan").decorator);

    host.decorations(source)?.open({ view: "file", path: "plan.md" });

    expect(opened).toEqual([{ view: { view: "file", path: "plan.md" }, container: "inspector", projectId: 4 }]);
  });
});
