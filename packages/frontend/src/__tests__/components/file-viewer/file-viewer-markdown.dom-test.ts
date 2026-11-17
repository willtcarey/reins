import { expect, test } from "bun:test";
import { FileViewerMarkdown } from "../../../components/file-viewer/file-viewer-markdown.js";

test("previews a file's Markdown as text from outside: its raw HTML and unsafe links are left out", async () => {
  const viewer = new FileViewerMarkdown();
  viewer.content = "# README\n\n<img src=x onerror=\"alert(1)\"> [run](javascript:alert(1))";
  document.body.append(viewer);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(viewer.querySelector(".prose h1")?.textContent).toBe("README");
  expect(viewer.querySelectorAll("img, a")).toHaveLength(0);
  expect(viewer.textContent).toContain("run");
  viewer.remove();
});
