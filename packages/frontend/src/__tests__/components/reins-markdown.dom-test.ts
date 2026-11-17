// `<reins-markdown>` as an extension uses it: from plain DOM, through the page's global registry, with no Lit.
import { afterEach, describe, expect, test } from "bun:test";
import type { HighlightRequest, HighlightResponse } from "../../models/changes/highlight-worker.js";
import "../../components/markdown-content.js";
import "../../components/reins-markdown.js";

/** The Shiki worker: marks each highlighted line. */
class FakeHighlightWorker {
  onmessage: ((event: { data: HighlightResponse }) => void) | null = null;
  postMessage({ id, files }: HighlightRequest) {
    const response: HighlightResponse = {
      id,
      type: "result",
      files: files.map(({ path, hunks }) => ({
        path,
        hunks: hunks.map(({ lines }) => ({ htmlLines: lines.map((line) => `<span class="highlighted">${line}</span>`) })),
      })),
    };
    queueMicrotask(() => this.onmessage?.({ data: response }));
  }
  terminate() {}
}
globalThis.Worker = Object.assign(FakeHighlightWorker);

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function draw(tag: string, text: string): Promise<HTMLElement> {
  const element = document.createElement(tag);
  element.setAttribute("text", text);
  Reflect.set(element, "text", text);
  document.body.append(element);
  await settle();
  return element;
}

afterEach(() => document.body.replaceChildren());

describe("<reins-markdown>", () => {
  test("draws Markdown as the chat does, with its code blocks highlighted", async () => {
    const text = "# Title\n\nSome **bold** text and `code`.\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";
    const markdown = await draw("reins-markdown", `${text}\n\`\`\`ts\nconst a = 1;\n\`\`\``);
    const chat = await draw("markdown-content", text);

    const body = markdown.firstElementChild!;
    expect(body.className).toBe(chat.firstElementChild!.className);
    expect(body.querySelector("h1")?.textContent).toBe("Title");
    expect(body.querySelector("table")).not.toBeNull();
    expect(body.querySelector("code[data-lang=ts]")?.innerHTML).toBe('<span class="highlighted">const a = 1;</span>');
  });

  test("leaves out raw HTML and keeps only safe links: external ones open in a new tab", async () => {
    const markdown = await draw("reins-markdown", [
      "<script>alert(1)</script>",
      "",
      "Text <img src=x onerror=alert(1)> with <b>inline</b> tags.<!-- a comment -->",
      "",
      "<div>",
      "",
      "Markdown **inside** HTML.",
      "",
      "</div>",
      "",
      "[script](javascript:alert(1)) [entity](&#106;avascript:alert(1)) [data](data:text/html,x) <javascript:alert(1)>",
      "",
      "[web](https://example.com/a?b=1&amp;c=2) [relative](/sessions) [mail](mailto:a@example.com) www.example.org",
      "",
      "![safe](https://example.com/a.png) ![unsafe](javascript:alert(1))",
    ].join("\n"));

    expect(markdown.querySelectorAll("script, div:not(.prose), b, [onerror]")).toHaveLength(0);
    expect(markdown.innerHTML).not.toContain("a comment");
    expect(markdown.textContent).toContain("Text  with inline tags.");
    expect(markdown.querySelector("strong")?.textContent).toBe("inside");
    expect(markdown.textContent).toContain("script entity data javascript:alert(1)");

    const links = [...markdown.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("target"), link.getAttribute("rel")]);
    expect(links).toEqual([
      ["web", "https://example.com/a?b=1&c=2", "_blank", "noopener noreferrer"],
      ["relative", "/sessions", null, null],
      ["mail", "mailto:a@example.com", null, null],
      ["www.example.org", "http://www.example.org", "_blank", "noopener noreferrer"],
    ]);
    expect([...markdown.querySelectorAll("img")].map((image) => [image.getAttribute("src"), image.getAttribute("alt")])).toEqual([
      ["https://example.com/a.png", "safe"],
    ]);
    expect(markdown.textContent).toContain("unsafe");
  });

  test("draws its text again when the attribute or the property changes", async () => {
    const markdown = document.createElement("reins-markdown");
    document.body.append(markdown);

    markdown.setAttribute("text", "# From the attribute");
    await settle();
    expect(markdown.querySelector("h1")?.textContent).toBe("From the attribute");

    Reflect.set(markdown, "text", "*From the property*");
    await settle();
    expect(markdown.querySelector("h1")).toBeNull();
    expect(markdown.querySelector("em")?.textContent).toBe("From the property");

    markdown.removeAttribute("text");
    await settle();
    expect(markdown.textContent?.trim()).toBe("");
  });
});
