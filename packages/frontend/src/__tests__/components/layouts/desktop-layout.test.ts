import { describe, expect, test } from "bun:test";
import { html } from "lit";
import { DesktopLayout } from "../../../components/layouts/desktop-layout.js";
import { templateToString } from "../../helpers/lit-template.js";

describe("DesktopLayout", () => {
  test("arranges the caller-provided workspace panes", () => {
    const el = new DesktopLayout();
    el.panes = {
      sessions: html`<session-sidebar></session-sidebar>`,
      chat: html`<div><app-main-toolbar></app-main-toolbar><chat-panel></chat-panel></div>`,
      changes: html`<diff-renderer-shell></diff-renderer-shell>`,
      files: html`<diff-file-tree></diff-file-tree>`,
    };
    el.activePane = "chat";

    const output = templateToString(el.render());

    expect(output).toContain("<session-sidebar");
    expect(output).toContain("<app-main-toolbar");
    expect(output).not.toContain("show-connection-status");
    expect(output).toContain("<chat-panel");
    expect(output).toContain("<diff-file-tree");
    expect(output).toContain("<diff-renderer-shell");
  });

});
