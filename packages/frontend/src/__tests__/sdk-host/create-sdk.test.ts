import { describe, expect, test } from "bun:test";
import type { FileReferenceView } from "../../extensions/message-file-references/message-file-references.js";
import type { DecorationSpan, MessageDecorator, Source } from "@reins/sdk";
import type { DecoratedSegment } from "../../sdk-host/decorators.js";
import { testSdk } from "../helpers/reins-sdk.js";

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
    expect(views.rendererFor(view)?.pane?.title(view)).toBe("Hello, Ada");
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
