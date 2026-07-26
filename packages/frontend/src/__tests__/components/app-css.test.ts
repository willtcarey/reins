import { describe, expect, test } from "bun:test";

const appCssPath = new URL("../../components/app.css", import.meta.url);

describe("global Pierre renderer theme", () => {
  test("defines shared and renderer-specific Pierre variables on the container hosts", async () => {
    const css = await Bun.file(appCssPath).text();

    expect(css).toContain("[data-pierre-code-view] diffs-container");
    expect(css).toContain("virtualized-diff-item [data-pierre-file-diff]");
    expect(css).toContain("file-viewer-code [data-pierre-file]");
    expect(css).toContain("--diffs-dark-bg: #09090b");
    expect(css).toContain("--diffs-bg-addition-emphasis-override: rgb(46 160 67 / 0.35)");
    expect(css).toContain("--diffs-fg-number-override: #71717a");
  });

  test("uses the Pierre theme background for Reins-owned diff headers", async () => {
    const css = await Bun.file(appCssPath).text();

    expect(css).not.toContain("--reins-diff-background: #24292e");
    expect(css).toContain(".reins-diff-header");
    expect(css).toContain("background-color: var(--reins-diff-background, #24292e)");
  });

  test("spaces adjacent Reins-owned changed files", async () => {
    const css = await Bun.file(appCssPath).text();

    expect(css).toContain("virtualized-diff-item {");
    expect(css).toContain("display: block");
    expect(css).toContain("virtualized-diff-item + virtualized-diff-item");
    expect(css).toContain("margin-block-start: 1em");
  });

  test("matches Pierre's bidi-safe left truncation for Reins diff paths", async () => {
    const css = await Bun.file(appCssPath).text();

    expect(css).toContain(`.reins-diff-path {
  direction: rtl;
}`);
  });
});
