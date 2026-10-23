import { describe, expect, test } from "bun:test";
import type { ReactiveController } from "lit";
import { parseMarkdown } from "../../components/markdown-content.js";
import { InlineViews, decoratedMarkdown, decoratedPlainText, type DecoratedHtml, type InlineViewsHost } from "../../components/message-decorations.js";
import { ViewMount } from "../../components/view-mount.js";
import { referenceDecorations } from "../helpers/reins-sdk.js";

const files = ["README.md", "docs/TODO.md", "src/app.ts"];
const source = { nodeId: "node", path: "/work/project" };

function views({ pieces }: DecoratedHtml): unknown[] {
  return pieces.map(({ view }) => view);
}

describe("decoratedMarkdown", () => {
  test("puts files named in prose and inline code in view mounts around their text, each with its view", () => {
    const { decorations } = referenceDecorations(files);

    const decorated = decoratedMarkdown("Read README.md, then `src/app.ts:12` and /work/project/docs/TODO.md#L3-L5.", decorations);

    expect(decorated.html).toBe(
      "<p>Read <reins-view-mount data-piece=\"0\">README.md</reins-view-mount>, then <reins-view-mount data-piece=\"1\"><code>src/app.ts:12</code></reins-view-mount>"
      + " and <reins-view-mount data-piece=\"2\">/work/project/docs/TODO.md#L3-L5</reins-view-mount>.</p>\n",
    );
    expect(views(decorated)).toEqual([
      { view: "file-reference", source, path: "README.md" },
      { view: "file-reference", source, path: "src/app.ts", startLine: 12 },
      { view: "file-reference", source, path: "docs/TODO.md", startLine: 3, endLine: 5 },
    ]);
    expect(decorated.pieces.map(({ context: { text, code } }) => ({ text, code }))).toEqual([
      { text: "README.md", code: false },
      { text: "src/app.ts:12", code: true },
      { text: "/work/project/docs/TODO.md#L3-L5", code: false },
    ]);
  });

  test("decorates lists, tables and emphasis", () => {
    const { decorations } = referenceDecorations(files);

    const { html } = decoratedMarkdown("- **README.md**\n\n| file |\n|---|\n| docs/TODO.md |", decorations);

    expect(html).toContain("<strong><reins-view-mount data-piece=\"0\">README.md</reins-view-mount></strong>");
    expect(html).toContain("<td><reins-view-mount data-piece=\"1\">docs/TODO.md</reins-view-mount></td>");
  });

  test("leaves links, URLs, images, fenced code and unknown files as they are", () => {
    const { decorations } = referenceDecorations(files);
    const text = [
      "[README.md](README.md) and https://example.com/README.md and ![README.md](README.md)",
      "",
      "```",
      "cat README.md",
      "```",
      "",
      "missing.md",
    ].join("\n");

    const decorated = decoratedMarkdown(text, decorations);

    expect(decorated.html).toBe(parseMarkdown(text));
    expect(decorated.pieces).toEqual([]);
  });
});

describe("decoratedPlainText", () => {
  test("escapes a user message's text and puts the files it names in view mounts", () => {
    const { decorations } = referenceDecorations(["README.md"]);

    const decorated = decoratedPlainText("Look at <README.md:4> & missing.md", decorations);

    expect(decorated.html).toBe("Look at &lt;<reins-view-mount data-piece=\"0\">README.md:4</reins-view-mount>&gt; &amp; missing.md");
    expect(views(decorated)).toEqual([{ view: "file-reference", source, path: "README.md", startLine: 4 }]);
  });
});

/** A light-DOM element whose rendered view mounts are `viewMounts`, driven through its controllers' lifecycle. */
function fakeHost(viewMounts: ViewMount[]) {
  const controllers: ReactiveController[] = [];
  const host: InlineViewsHost = {
    addController: (controller) => { controllers.push(controller); },
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: Promise.resolve(true),
    querySelectorAll: () => viewMounts,
  };
  const inlineViews = new InlineViews(host);
  return {
    inlineViews,
    /** One update: `render` is what the element's render does with the controller. */
    update(render: () => void) {
      for (const controller of controllers) controller.hostUpdate?.();
      render();
      for (const controller of controllers) controller.hostUpdated?.();
    },
  };
}

function pieceMount(index: number): ViewMount {
  const element = new ViewMount();
  element.setAttribute("data-piece", String(index));
  return element;
}

describe("InlineViews", () => {
  test("gives each view mount its piece's view, presentation and context after the update that rendered it", () => {
    const { decorations } = referenceDecorations(files);
    const first = pieceMount(0);
    const second = pieceMount(1);
    const element = fakeHost([first, second]);
    const decorated = decoratedPlainText("README.md and src/app.ts", decorations);

    element.update(() => element.inlineViews.render(decorated));

    expect([first, second].map(({ view, presentation, context }) => ({ view, presentation, context }))).toEqual(
      decorated.pieces.map(({ view, presentation, context }) => ({ view, presentation, context })),
    );
  });

  test("gives the same HTML's view mounts their pieces again after an update that rendered none", () => {
    const { decorations } = referenceDecorations(files);
    const viewMounts = [pieceMount(0)];
    const element = fakeHost(viewMounts);
    const decorated = decoratedPlainText("README.md", decorations);
    element.update(() => element.inlineViews.render(decorated));

    element.update(() => {});
    viewMounts[0] = pieceMount(0);
    element.update(() => element.inlineViews.render(decorated));

    expect(viewMounts[0].view).toEqual({ view: "file-reference", source, path: "README.md" });
  });
});
