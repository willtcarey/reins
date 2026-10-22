import { describe, expect, test } from "bun:test";
import { reins } from "reins-sdk";
import { ProjectFiles } from "../../models/stores/project-files.js";
import { SessionCache } from "../../models/stores/session-cache.js";
import type { DecorationSpan, MessageDecorator, View } from "../../reins-sdk/contract.js";
import type { DecoratedSegment } from "../../reins-sdk/decorations.js";
import { ReinsHost, installHost } from "../../reins-sdk/host.js";
import { installTestHost } from "../helpers/reins-sdk.js";
import { StubClient } from "../helpers/stub-client.js";

const filePane = {
  title: () => "plan.md",
  description: () => "docs/plan.md",
  icon: "file" as const,
  mount: () => {},
};
const fileRenderer = { pane: filePane };

/** Shows a file reference inline as its text. */
const inlineReference = { inline: { mount: () => {} } };

/** Decorates every occurrence of a word with a reference to a file named after it; `changed` says its data changed. */
function wordDecorator(word: string) {
  const listeners = new Set<() => void>();
  const view: View = { view: "file-reference", path: `${word}.md` };
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

/** Segments as plain text and each piece's text and view. */
function pieces(segments: DecoratedSegment[] | undefined) {
  return segments?.map((segment) => (typeof segment === "string" ? segment : { text: segment.context.text, view: segment.view }));
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

  test("refuses a second renderer for a name and a renderer without a presentation", () => {
    const { host } = installTestHost();
    reins.views.register("file", fileRenderer);

    expect(() => reins.views.register("file", fileRenderer)).toThrow();
    host.dispose();
    expect(() => reins.views.register("file", {})).toThrow();
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
  test("decorates prose, plain text and inline code with views shown inline, an earlier decorator winning an overlap", () => {
    const { host, source } = installTestHost();
    reins.views.register("file-reference", inlineReference);
    reins.messages.registerDecorator(wordDecorator("plan").decorator);
    reins.messages.registerDecorator(wordDecorator("planning").decorator);
    reins.messages.registerDecorator(wordDecorator("notes").decorator);
    const decorations = host.decorations(source);

    expect(pieces(decorations?.segments("planning notes"))).toEqual([
      { text: "plan", view: { view: "file-reference", path: "plan.md" } },
      "ning ",
      { text: "notes", view: { view: "file-reference", path: "notes.md" } },
    ]);
    expect(pieces(decorations?.plainText("Edit plan:\n```\ncat plan\n```\ndone"))).toEqual([
      "Edit ",
      { text: "plan", view: { view: "file-reference", path: "plan.md" } },
      ":\n```\ncat plan\n```\ndone",
    ]);
    const code = decorations?.code("notes");
    expect(code?.view).toEqual({ view: "file-reference", path: "notes.md" });
    expect(code?.presentation).toBe(inlineReference.inline);
    expect(code?.context).toMatchObject({ source, text: "notes", code: true });
    expect(decorations?.code("other")).toBeNull();
  });

  test("leaves the text of a view that cannot be shown inline as it is", () => {
    const { host, source } = installTestHost();
    reins.views.register("file-reference", fileRenderer);
    reins.messages.registerDecorator(wordDecorator("plan").decorator);
    const decorations = host.decorations(source);

    expect(decorations?.segments("the plan")).toEqual(["the plan"]);
    expect(decorations?.code("plan")).toBeNull();
  });

  test("keeps the same decorations until a decorator says its data changed or the source changes", () => {
    const { host, source } = installTestHost();
    const plan = wordDecorator("plan");
    reins.views.register("file-reference", inlineReference);
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
});
