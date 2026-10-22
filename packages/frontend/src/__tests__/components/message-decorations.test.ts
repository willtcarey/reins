import { describe, expect, test } from "bun:test";
import type { ReactiveController } from "lit";
import { parseMarkdown } from "../../components/markdown-content.js";
import { InlineViews, decoratedMarkdown, decoratedPlainText, type DecoratedHtml, type InlineViewsHost } from "../../components/message-decorations.js";
import { ViewHost } from "../../components/view-host.js";
import { referenceDecorations } from "../helpers/reins-sdk.js";

const files = ["README.md", "docs/TODO.md", "src/app.ts"];

function views({ pieces }: DecoratedHtml): unknown[] {
  return pieces.map(({ view }) => view);
}

describe("decoratedMarkdown", () => {
  test("puts files named in prose and inline code in view hosts around their text, each with its view", () => {
    const { decorations } = referenceDecorations(files);

    const decorated = decoratedMarkdown("Read README.md, then `src/app.ts:12` and /work/project/docs/TODO.md#L3-L5.", decorations);

    expect(decorated.html).toBe(
      "<p>Read <reins-view-host data-piece=\"0\">README.md</reins-view-host>, then <reins-view-host data-piece=\"1\"><code>src/app.ts:12</code></reins-view-host>"
      + " and <reins-view-host data-piece=\"2\">/work/project/docs/TODO.md#L3-L5</reins-view-host>.</p>\n",
    );
    expect(views(decorated)).toEqual([
      { view: "file-reference", path: "README.md" },
      { view: "file-reference", path: "src/app.ts", startLine: 12 },
      { view: "file-reference", path: "docs/TODO.md", startLine: 3, endLine: 5 },
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

    expect(html).toContain("<strong><reins-view-host data-piece=\"0\">README.md</reins-view-host></strong>");
    expect(html).toContain("<td><reins-view-host data-piece=\"1\">docs/TODO.md</reins-view-host></td>");
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
  test("escapes a user message's text and puts the files it names in view hosts", () => {
    const { decorations } = referenceDecorations(["README.md"]);

    const decorated = decoratedPlainText("Look at <README.md:4> & missing.md", decorations);

    expect(decorated.html).toBe("Look at &lt;<reins-view-host data-piece=\"0\">README.md:4</reins-view-host>&gt; &amp; missing.md");
    expect(views(decorated)).toEqual([{ view: "file-reference", path: "README.md", startLine: 4 }]);
  });
});

/** A light-DOM element whose rendered view hosts are `viewHosts`, driven through its controllers' lifecycle. */
function fakeHost(viewHosts: ViewHost[]) {
  const controllers: ReactiveController[] = [];
  const host: InlineViewsHost = {
    addController: (controller) => { controllers.push(controller); },
    removeController: () => {},
    requestUpdate: () => {},
    updateComplete: Promise.resolve(true),
    querySelectorAll: () => viewHosts,
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

function pieceHost(index: number): ViewHost {
  const element = new ViewHost();
  element.setAttribute("data-piece", String(index));
  return element;
}

describe("InlineViews", () => {
  test("gives each view host its piece's view, presentation and context after the update that rendered it", () => {
    const { decorations } = referenceDecorations(files);
    const first = pieceHost(0);
    const second = pieceHost(1);
    const element = fakeHost([first, second]);
    const decorated = decoratedPlainText("README.md and src/app.ts", decorations);

    element.update(() => element.inlineViews.render(decorated));

    expect([first, second].map(({ view, presentation, context }) => ({ view, presentation, context }))).toEqual(
      decorated.pieces.map(({ view, presentation, context }) => ({ view, presentation, context })),
    );
  });

  test("gives the same HTML's view hosts their pieces again after an update that rendered none", () => {
    const { decorations } = referenceDecorations(files);
    const viewHosts = [pieceHost(0)];
    const element = fakeHost(viewHosts);
    const decorated = decoratedPlainText("README.md", decorations);
    element.update(() => element.inlineViews.render(decorated));

    element.update(() => {});
    viewHosts[0] = pieceHost(0);
    element.update(() => element.inlineViews.render(decorated));

    expect(viewHosts[0].view).toEqual({ view: "file-reference", path: "README.md" });
  });
});
