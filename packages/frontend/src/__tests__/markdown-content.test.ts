/**
 * Tests for markdown rendering with mermaid diagram support.
 *
 * Tests the pure markdown→HTML transformation that will back the
 * <markdown-content> component. Mermaid fenced code blocks should produce
 * <div class="mermaid"> instead of <pre><code>.
 */
import { describe, test, expect } from "bun:test";
import { parseMarkdown } from "../components/markdown-content.js";

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
