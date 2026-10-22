import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "../../components/markdown-content.js";
import { activateDecoration, decoratedMarkdown, decoratedPlainText } from "../../components/message-decorations.js";
import { clickButton, templateToString } from "../helpers/lit-template.js";
import { referenceDecorations } from "../helpers/reins-sdk.js";

/** A decoration's button as Markdown renders it, holding its view as escaped JSON. */
function decorationButton(view: object, label: string, content: string): string {
  const json = JSON.stringify(view).replace(/"/g, "&quot;");
  return `<button type="button" class="message-decoration" data-view="${json}" title="${label}">${content}</button>`;
}

/** A click landing inside a decoration holding `view`. */
function clickOn(view: string) {
  const event = new Event("click");
  Object.defineProperty(event, "target", {
    value: { closest: (selector: string) => (selector === "[data-view]" ? { dataset: { view } } : null) },
  });
  return event;
}

const files = ["README.md", "docs/TODO.md", "src/app.ts"];

describe("decoratedMarkdown", () => {
  test("turns files named in prose and inline code into controls that keep the text", () => {
    const { decorations } = referenceDecorations(files);

    expect(decoratedMarkdown("Read README.md, then `src/app.ts:12` and /work/project/docs/TODO.md#L3-L5.", decorations)).toBe(
      "<p>Read "
      + decorationButton({ view: "file", path: "README.md" }, "Open README.md in the Inspector", "README.md")
      + ", then "
      + decorationButton({ view: "file", path: "src/app.ts", startLine: 12 }, "Open src/app.ts:12 in the Inspector", "<code>src/app.ts:12</code>")
      + " and "
      + decorationButton({ view: "file", path: "docs/TODO.md", startLine: 3, endLine: 5 }, "Open docs/TODO.md:3-5 in the Inspector", "/work/project/docs/TODO.md#L3-L5")
      + ".</p>\n",
    );
  });

  test("decorates lists, tables and emphasis", () => {
    const { decorations } = referenceDecorations(files);

    const html = decoratedMarkdown("- **README.md**\n\n| file |\n|---|\n| docs/TODO.md |", decorations);

    expect(html).toContain(`<strong>${decorationButton({ view: "file", path: "README.md" }, "Open README.md in the Inspector", "README.md")}</strong>`);
    expect(html).toContain(`<td>${decorationButton({ view: "file", path: "docs/TODO.md" }, "Open docs/TODO.md in the Inspector", "docs/TODO.md")}</td>`);
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

    expect(decoratedMarkdown(text, decorations)).toBe(parseMarkdown(text));
  });
});

describe("activateDecoration", () => {
  test("opens the view of a clicked decoration in the Inspector", () => {
    const { decorations, opened } = referenceDecorations(files);

    expect(activateDecoration(clickOn('{"view":"file","path":"src/app.ts","startLine":12,"endLine":14}'), decorations)).toBe(true);

    expect(opened.map(({ view, container }) => ({ view, container }))).toEqual([
      { view: { view: "file", path: "src/app.ts", startLine: 12, endLine: 14 }, container: "inspector" },
    ]);
  });

  test("leaves other clicks alone", () => {
    const { decorations, opened } = referenceDecorations(files);

    expect(activateDecoration(clickOn('{"view":"unknown"}'), decorations)).toBe(false);
    expect(activateDecoration(clickOn("not json"), decorations)).toBe(false);
    expect(activateDecoration(new Event("click"), decorations)).toBe(false);
    expect(opened).toEqual([]);
  });
});

describe("decoratedPlainText", () => {
  test("links files named in a user message, opening them in the Inspector", () => {
    const { decorations, opened } = referenceDecorations(["README.md"]);
    const text = decoratedPlainText("Look at README.md:4 and missing.md", decorations);

    clickButton(text, "README.md:4");

    expect(templateToString(text)).toContain("missing.md");
    expect(opened.map(({ view }) => view)).toEqual([{ view: "file", path: "README.md", startLine: 4 }]);
  });
});
