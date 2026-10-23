import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "../../components/markdown-content.js";
import { decoratedMarkdown, decoratedPlainText, type DecoratedHtml } from "../../models/decorated-html.js";
import { referenceDecorators } from "../helpers/reins-sdk.js";

const files = ["README.md", "docs/TODO.md", "src/app.ts"];
const source = { nodeId: "node", path: "/work/project" };

function views({ pieces }: DecoratedHtml): unknown[] {
  return pieces.map(({ view }) => view);
}

describe("decoratedMarkdown", () => {
  test("puts files named in prose and inline code in view mounts around their text, each with its view", () => {
    const { decorators } = referenceDecorators(files);

    const decorated = decoratedMarkdown("Read ./README.md, then `src/app.ts:12` and /work/project/docs/TODO.md#L3-L5.", decorators);

    expect(decorated.html).toBe(
      "<p>Read <reins-view-mount data-piece=\"0\">./README.md</reins-view-mount>, then <reins-view-mount data-piece=\"1\"><code>src/app.ts:12</code></reins-view-mount>"
      + " and <reins-view-mount data-piece=\"2\">/work/project/docs/TODO.md#L3-L5</reins-view-mount>.</p>\n",
    );
    expect(views(decorated)).toEqual([
      { view: "file-reference", source, path: "README.md" },
      { view: "file-reference", source, path: "src/app.ts", startLine: 12 },
      { view: "file-reference", source, path: "docs/TODO.md", startLine: 3, endLine: 5 },
    ]);
    expect(decorated.pieces.map(({ context: { text, code } }) => ({ text, code }))).toEqual([
      { text: "./README.md", code: false },
      { text: "src/app.ts:12", code: true },
      { text: "/work/project/docs/TODO.md#L3-L5", code: false },
    ]);
  });

  test("decorates lists, tables and emphasis", () => {
    const { decorators } = referenceDecorators(files);

    const { html } = decoratedMarkdown("- **src/app.ts**\n\n| file |\n|---|\n| docs/TODO.md |", decorators);

    expect(html).toContain("<strong><reins-view-mount data-piece=\"0\">src/app.ts</reins-view-mount></strong>");
    expect(html).toContain("<td><reins-view-mount data-piece=\"1\">docs/TODO.md</reins-view-mount></td>");
  });

  test("leaves links, URLs, images, fenced code and unknown files as they are", () => {
    const { decorators } = referenceDecorators(files);
    const text = [
      "[README.md](README.md) and https://example.com/README.md and ![README.md](README.md)",
      "",
      "```",
      "cat README.md",
      "```",
      "",
      "missing.md",
    ].join("\n");

    const decorated = decoratedMarkdown(text, decorators);

    expect(decorated.html).toBe(parseMarkdown(text));
    expect(decorated.pieces).toEqual([]);
  });
});

describe("decoratedPlainText", () => {
  test("escapes a user message's text and puts the files it names in view mounts", () => {
    const { decorators } = referenceDecorators(["README.md"]);

    const decorated = decoratedPlainText("Look at <README.md:4> & missing.md", decorators);

    expect(decorated.html).toBe("Look at &lt;<reins-view-mount data-piece=\"0\">README.md:4</reins-view-mount>&gt; &amp; missing.md");
    expect(views(decorated)).toEqual([{ view: "file-reference", source, path: "README.md", startLine: 4 }]);
  });
});
