import { describe, expect, test } from "bun:test";
import { DiffRendererShell } from "../../../components/changes/diff-renderer-shell.js";
import { ReviewDiffPanel } from "../../../components/changes/review-diff-panel.js";
import { DiffStore } from "../../../models/stores/diff-store.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("DiffRendererShell", () => {
  test("selects the classic diff panel by default", () => {
    const shell = new DiffRendererShell();
    shell.store = new DiffStore();

    const output = templateToString(shell.render());

    expect(output).toContain("<diff-panel");
    expect(output).not.toContain("<review-diff-panel");
    shell.store.dispose();
  });

  test("passes visibility through to the classic diff panel", () => {
    const shell = new DiffRendererShell();
    shell.store = new DiffStore();
    shell.visible = true;

    const output = templateToString(shell.render());

    expect(output).toContain("<diff-panel");
    expect(output).toContain(".visible=true");
    shell.store.dispose();
  });

  test("forwards file navigation to the selected renderer panel", () => {
    const shell = new DiffRendererShell();
    const scrolledPaths: string[] = [];
    const panel = new ReviewDiffPanel();
    panel.scrollToFile = (path: string) => {
      scrolledPaths.push(path);
    };
    const querySelector: typeof shell.querySelector = () => panel;
    shell.querySelector = querySelector;

    shell.scrollToFile("src/example.ts");

    expect(scrolledPaths).toEqual(["src/example.ts"]);
  });

  test("selects the Reins renderer without changing the classic default", () => {
    const shell = new DiffRendererShell();
    shell.store = new DiffStore();
    shell.renderer = "virtualized";

    const output = templateToString(shell.render());
    expect(output).toContain("<review-diff-panel");
    expect(output).not.toContain("<diff-panel");
    shell.store.dispose();
  });

  test("exposes diff refresh diagnostics as DOM attributes", () => {
    const shell = new DiffRendererShell();
    const store = new DiffStore();
    store.fileData = store.fileData.asLoaded({
      files: [{ path: "a.ts", additions: 2, removals: 1 }],
      branch: "task/diagnostics",
      baseBranch: "master",
    });
    store.lastFilesRefreshAt = "2026-07-26T10:00:00.000Z";
    store.lastPayloadRefreshAt = "2026-07-26T10:00:01.000Z";
    store.lastRefreshTrigger = "poll-summary-changed";
    store.lastSummaryChanged = true;
    store.patchData = store.patchData.asLoaded({
      patch: "",
      cacheKeyPrefix: "diagnostic-v4",
      version: 4,
      branch: "task/diagnostics",
      baseBranch: "master",
    });
    shell.store = store;
    shell.renderer = "virtualized";

    const output = templateToString(shell.render());

    expect(output).toContain("data-diff-renderer=virtualized");
    expect(output).toContain("data-diff-file-count=1");
    expect(output).toContain("data-diff-additions=2");
    expect(output).toContain("data-diff-removals=1");
    expect(output).toContain("data-diff-payload-status=loaded");
    expect(output).toContain("data-diff-payload-version=4");
    expect(output).toContain("data-diff-last-refresh-trigger=poll-summary-changed");
    expect(output).toContain("data-diff-summary-changed=true");
    expect(output).toContain("data-diff-last-files-refresh-at=2026-07-26T10:00:00.000Z");
    expect(output).toContain("data-diff-last-payload-refresh-at=2026-07-26T10:00:01.000Z");
    store.dispose();
  });
});
