/**
 * Tests for markdown rendering with mermaid diagram support.
 *
 * Tests the pure markdown→HTML transformation that will back the
 * <markdown-content> component. Mermaid fenced code blocks should produce
 * <div class="mermaid"> instead of <pre><code>.
 */
import { describe, test, expect, spyOn } from "bun:test";
import { imageViewerDetailFromMarkdownTarget, MarkdownContent, parseMarkdown } from "../../components/markdown-content.js";
import { streamingTelemetry } from "../../models/streaming-telemetry.js";

/** HTML strings passed to unsafeHTML parts, in render order. */
function renderedParts(element: MarkdownContent): string[] {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const values: unknown = Reflect.get(value, "values");
    if (!Array.isArray(values)) return;
    if (Reflect.has(value, "_$litDirective$")) {
      if (typeof values[0] === "string") parts.push(values[0]);
      return;
    }
    values.forEach(visit);
  };
  visit(element.render());
  return parts;
}

function streamingElement(): MarkdownContent {
  const element = new MarkdownContent();
  element.streaming = true;
  return element;
}

// ---------------------------------------------------------------------------
// Basic markdown
// ---------------------------------------------------------------------------

describe("parseMarkdown", () => {
  test("renders a heading", () => {
    const result = parseMarkdown("# Hello");
    expect(result).toContain("<h1");
    expect(result).toContain("Hello");
  });

  test("renders inline code", () => {
    const result = parseMarkdown("use `foo()` here");
    expect(result).toContain("<code>");
    expect(result).toContain("foo()");
  });

  test("renders a paragraph", () => {
    const result = parseMarkdown("Just some text.");
    expect(result).toContain("<p>");
    expect(result).toContain("Just some text.");
  });

  // ---------------------------------------------------------------------------
  // Regular code blocks — should be unchanged
  // ---------------------------------------------------------------------------

  test("renders a javascript code block as <pre><code> with data-lang", () => {
    const md = "```javascript\nconsole.log('hi');\n```";
    const result = parseMarkdown(md);
    expect(result).toContain("<pre>");
    expect(result).toContain('<code data-lang="javascript"');
    expect(result).toContain("console.log");
  });

  test("renders a code block with no language as <pre><code> without data-lang", () => {
    const md = "```\nplain code\n```";
    const result = parseMarkdown(md);
    expect(result).toContain("<pre>");
    expect(result).toContain("<code");
    expect(result).not.toContain("data-lang");
  });

  // ---------------------------------------------------------------------------
  // Mermaid code blocks — should produce <div class="mermaid">
  // ---------------------------------------------------------------------------

  test("renders a mermaid block as <div class=\"mermaid\">", () => {
    const md = "```mermaid\ngraph TD;\n  A-->B;\n```";
    const result = parseMarkdown(md);
    expect(result).toContain('<div class="mermaid">');
    expect(result).not.toContain("<pre>");
    expect(result).not.toContain("<code");
  });

  test("mermaid div contains the diagram source", () => {
    const md = "```mermaid\ngraph TD;\n  A-->B;\n```";
    const result = parseMarkdown(md);
    expect(result).toContain("graph TD;");
    expect(result).toContain("A--&gt;B;");
  });

  test("mermaid content is HTML-escaped", () => {
    const md = '```mermaid\ngraph TD;\n  A["<script>alert(1)</script>"]-->B;\n```';
    const result = parseMarkdown(md);
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;script&gt;");
  });

  test("mermaid and regular code blocks coexist", () => {
    const md = [
      "```mermaid",
      "graph TD;",
      "  A-->B;",
      "```",
      "",
      "```javascript",
      "console.log('hi');",
      "```",
    ].join("\n");
    const result = parseMarkdown(md);
    expect(result).toContain('<div class="mermaid">');
    expect(result).toContain("<pre>");
  });

  test("multiple mermaid blocks are all rendered as divs", () => {
    const md = [
      "```mermaid",
      "graph TD; A-->B;",
      "```",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  Alice->>Bob: Hi",
      "```",
    ].join("\n");
    const result = parseMarkdown(md);
    const matches = result.match(/<div class="mermaid">/g);
    expect(matches).toHaveLength(2);
  });
});

describe("imageViewerDetailFromMarkdownTarget", () => {
  test("creates image viewer details from markdown image targets", () => {
    expect(imageViewerDetailFromMarkdownTarget({
      tagName: "IMG",
      currentSrc: "/assets/screen.png",
      src: "/fallback.png",
      alt: "Screenshot",
      title: "screen.png",
    })).toEqual({ src: "/assets/screen.png", alt: "Screenshot", title: "screen.png" });
  });

  test("falls back to src and default labels", () => {
    expect(imageViewerDetailFromMarkdownTarget({
      nodeName: "IMG",
      src: "/assets/diagram.png",
    })).toEqual({ src: "/assets/diagram.png", alt: "Image preview", title: "Image preview" });
  });

  test("ignores non-image targets", () => {
    expect(imageViewerDetailFromMarkdownTarget({ tagName: "A", src: "/assets/screen.png" })).toBeNull();
  });
});

describe("MarkdownContent streaming split", () => {
  const documents: Record<string, string> = {
    paragraphs: "First paragraph with **bold**\nand a soft break.\n\nSecond paragraph.\n\n\nThird after two blanks.\n",
    headings: "# Title\n\nIntro text.\n\nSetext heading\n---\n\n## Section\nBody right under it.\n\n---\n\nAfter a rule.\n",
    lists: "Intro.\n\n- tight one\n- tight two\n\n- now loose\n\n  continued item paragraph\n\n  1. nested\n  2. nested two\n\nAfter the list.\n\n1. ordered\n\n2. loose ordered\n\n* * *\n\nDone.\n",
    fences: "Before.\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\n~~~\nplain\n\n~~~\n\n````md\n```\ninner\n\n```\n````\n\n```mermaid\ngraph TD;\n\n  A-->B;\n```\n\nAfter.\n",
    tables: "| a | b |\n|---|---|\n| 1 | 2 |\n\nBetween tables.\n\n| c |\n|:-:|\n| 3 |\n| 4 |\n\nEnd.\n",
    blocks: "> quote one\n> still quoted\n\n> - quoted list\n\n> second quote\n\n$$\na = b\n\nc = d\n$$\n\n    indented code\n\n    more code\n\nParagraph.\n",
    references: "See [the docs][docs].\n\nMore text.\n\n[docs]: https://example.com\n",
    html: "<div>\n\nInside html.\n\n</div>\n\nAfter.\n",
  };

  for (const [name, markdown] of Object.entries(documents)) {
    test(`split output matches unsplit output at every chunk boundary: ${name}`, () => {
      const element = streamingElement();
      for (let end = 0; end <= markdown.length; end += 1) {
        const text = markdown.slice(0, end);
        element.text = text;
        expect(renderedParts(element).join("")).toBe(parseMarkdown(text));
      }
    });
  }

  test("settles completed blocks into stable parts while only the tail changes", () => {
    const element = streamingElement();
    element.text = "# Heading\n\nFirst paragraph.\n\n```js\nlet a;\n\n";
    const first = renderedParts(element);
    element.text += "let b;\n```\n\n| a |\n|---|\n| 1 |\n\nTail is stre";
    const second = renderedParts(element);

    expect(first).toEqual([parseMarkdown("# Heading\n\nFirst paragraph.\n\n"), parseMarkdown("```js\nlet a;\n\n")]);
    expect(second.slice(0, -1)).toEqual([
      first[0]!,
      parseMarkdown("```js\nlet a;\n\nlet b;\n```\n\n| a |\n|---|\n| 1 |\n\n"),
    ]);
    expect(second.at(-1)).toBe(parseMarkdown("Tail is stre"));
  });

  test("keeps lists and unterminated blocks in the live tail", () => {
    const element = streamingElement();
    element.text = "- one\n\n- two\n\n";
    expect(renderedParts(element)).toEqual([parseMarkdown("- one\n\n- two\n\n")]);
    element.text = "One huge paragraph that never reaches a blank line";
    expect(renderedParts(element)).toEqual([parseMarkdown(element.text)]);
  });

  test("reports streaming parse work: full text length and the characters parsed this render", () => {
    const parsed = spyOn(streamingTelemetry, "markdownParsed").mockImplementation(() => {});
    try {
      const element = streamingElement();
      element.text = "Para one.\n\nPara tw";
      renderedParts(element);
      element.text = "Para one.\n\nPara two.\n\nTail";
      renderedParts(element);
      element.streaming = false;
      renderedParts(element);

      expect(parsed.mock.calls.map(([, textLength, parsedLength]) => [textLength, parsedLength])).toEqual([
        [18, 18],
        [26, "Para two.\n\nTail".length],
      ]);
    } finally {
      parsed.mockRestore();
    }
  });

  test("renders the whole text unsplit once streaming ends", () => {
    const element = streamingElement();
    element.text = "Para one.\n\nPara two.\n\nPara three.";
    expect(renderedParts(element).length).toBeGreaterThan(1);
    element.streaming = false;
    expect(renderedParts(element)).toEqual([parseMarkdown(element.text)]);
  });

  test("defers code highlighting and mermaid rendering until streaming ends", async () => {
    const element = streamingElement();
    element.text = "```mermaid\ngraph TD;\n  A-->B;\n```\n\n";
    const queried: string[] = [];
    Reflect.set(element, "querySelectorAll", (selector: string) => {
      queried.push(selector);
      return [];
    });

    await element.updated();
    expect(queried).toEqual([]);

    element.streaming = false;
    await element.updated();
    expect(queried).toEqual(["pre code[data-lang]", "div.mermaid"]);
  });
});
