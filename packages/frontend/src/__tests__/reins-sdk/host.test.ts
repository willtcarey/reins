import { describe, expect, test } from "bun:test";
import type { DecorationSpan, MessageDecorator } from "../../reins-sdk/contract.js";
import { placedHost } from "../helpers/reins-sdk.js";

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

describe("views.register", () => {
  test("gives the Inspector a view's renderer until it is disposed", () => {
    const { host, sdk } = placedHost();
    let changes = 0;
    host.subscribe(() => { changes += 1; });

    const dispose = sdk.views.register("file", fileRenderer);
    expect(host.renderer({ view: "file", path: "docs/plan.md" })).toBe(fileRenderer);

    dispose();
    expect(host.renderer({ view: "file", path: "docs/plan.md" })).toBeNull();
    expect(changes).toBe(2);
  });

  test("refuses a second renderer for a name, the changes view and an element name without a hyphen", () => {
    const { host, sdk } = placedHost();
    sdk.views.register("file", fileRenderer);

    expect(() => sdk.views.register("file", fileRenderer)).toThrow();
    expect(() => sdk.views.register("changes", { title: () => "", description: () => "", icon: "file", element: "my-changes" })).toThrow();
    host.dispose();
    expect(() => sdk.views.register("file", { ...fileRenderer, element: "fileview" })).toThrow();
  });
});

describe("workspace.open", () => {
  test("reaches the workspace on screen, in the Inspector unless another container is named", () => {
    const { sdk, opened } = placedHost();

    sdk.workspace.open({ view: "file", path: "README.md", startLine: 3 });

    expect(opened).toEqual([{ view: { view: "file", path: "README.md", startLine: 3 }, container: "inspector", projectId: null }]);
  });

  test("names the project of the source a caller names, for the workspace to ignore a view of another", () => {
    const { sdk, opened, source } = placedHost({ projectId: 7 });

    sdk.workspace.open({ view: "file", path: "README.md" }, { in: "inspector", source });

    expect(opened.map(({ projectId }) => projectId)).toEqual([7]);
  });

  test("does nothing while no workspace is on screen", () => {
    const { host, sdk, opened } = placedHost();
    const unmount = host.mountWorkspace({ open: () => { throw new Error("unmounted workspace reached"); } });
    unmount();

    sdk.workspace.open({ view: "file", path: "README.md" });

    expect(opened).toEqual([]);
  });
});

describe("messages.registerDecorator", () => {
  test("decorates prose, plain text and inline code, an earlier decorator winning an overlap", () => {
    const { host, sdk, source } = placedHost();
    sdk.messages.registerDecorator(wordDecorator("plan").decorator);
    sdk.messages.registerDecorator(wordDecorator("planning").decorator);
    sdk.messages.registerDecorator(wordDecorator("notes").decorator);
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
    const { host, sdk, source } = placedHost();
    const plan = wordDecorator("plan");
    sdk.messages.registerDecorator(plan.decorator);
    const first = host.decorations(source);

    expect(host.decorations({ ...source })).toBe(first);
    plan.changed();
    const second = host.decorations(source);
    expect(second).not.toBe(first);
    expect(host.decorations({ ...source, path: "/other" })).not.toBe(second);
  });

  test("stops applying a disposed decorator and stops listening to it", () => {
    const { host, sdk, source } = placedHost();
    const plan = wordDecorator("plan");
    const dispose = sdk.messages.registerDecorator(plan.decorator);

    dispose();

    expect(host.decorations(source)).toBeNull();
    expect(plan.listeners.size).toBe(0);
  });

  test("opens an activated decoration's view in the Inspector, for the decorations' source", () => {
    const { host, sdk, source, opened } = placedHost({ projectId: 4 });
    sdk.messages.registerDecorator(wordDecorator("plan").decorator);

    host.decorations(source)?.open({ view: "file", path: "plan.md" });

    expect(opened).toEqual([{ view: { view: "file", path: "plan.md" }, container: "inspector", projectId: 4 }]);
  });
});
