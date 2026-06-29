import { describe, expect, test } from "bun:test";
import { DiffRendererShell } from "../../../components/changes/diff-renderer-shell.js";
import { DiffStore } from "../../../models/stores/diff-store.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("DiffRendererShell", () => {
  test("selects the classic diff panel by default", () => {
    const shell = new DiffRendererShell();
    shell.store = new DiffStore();

    const output = templateToString(shell.render());

    expect(output).toContain("<diff-panel");
    expect(output).not.toContain("<virtual-diff-panel");
    shell.store.dispose();
  });

  test("selects the virtual diff panel when requested", () => {
    const shell = new DiffRendererShell();
    shell.store = new DiffStore();
    shell.renderer = "virtual";

    const output = templateToString(shell.render());

    expect(output).toContain("<virtual-diff-panel");
    expect(output).not.toContain("<diff-panel");
    shell.store.dispose();
  });
});
