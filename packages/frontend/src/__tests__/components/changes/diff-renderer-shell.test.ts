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
    expect(output).not.toContain("<codeview-diff-panel");
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

  test("selects each non-default renderer without changing the classic fallback", () => {
    const shell = new DiffRendererShell();
    shell.store = new DiffStore();
    shell.renderer = "codeview";

    expect(templateToString(shell.render())).toContain("<codeview-diff-panel");

    shell.renderer = "virtualized";
    const output = templateToString(shell.render());
    expect(output).toContain("<virtualized-diff-panel");
    expect(output).not.toContain("<codeview-diff-panel");
    expect(output).not.toContain("<diff-panel");
    shell.store.dispose();
  });
});
