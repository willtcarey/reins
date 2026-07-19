import { describe, expect, test } from "bun:test";

const appCssPath = new URL("../../components/app.css", import.meta.url);

describe("global Pierre renderer theme", () => {
  test("defines shared and renderer-specific Pierre variables on the container hosts", async () => {
    const css = await Bun.file(appCssPath).text();

    expect(css).toContain("[data-pierre-code-view] diffs-container");
    expect(css).toContain("file-viewer-code [data-pierre-file]");
    expect(css).toContain("--diffs-dark-bg: #09090b");
    expect(css).toContain("--diffs-bg-addition-emphasis-override: rgb(46 160 67 / 0.35)");
    expect(css).toContain("--diffs-fg-number-override: #71717a");
  });
});
