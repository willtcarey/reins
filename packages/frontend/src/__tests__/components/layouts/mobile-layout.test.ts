import { describe, expect, mock, test } from "bun:test";
import { html } from "lit";
import { MobileLayout } from "../../../components/layouts/mobile-layout.js";
import { collectTemplateValues, templateToString } from "../../helpers/lit-template.js";

describe("MobileLayout", () => {
  test("passes the caller-provided workspace panes to the swipe pager in mobile order", () => {
    const el = new MobileLayout();
    el.panes = {
      sessions: html`<session-sidebar></session-sidebar>`,
      chat: html`<chat-panel></chat-panel>`,
      changes: html`<diff-renderer-shell></diff-renderer-shell>`,
      files: html`<div>Changed files</div>`,
    };

    const rendered = el.render();
    const values = collectTemplateValues(rendered);
    const pageOutput = values
      .filter(Array.isArray)
      .flat()
      .map((page) => templateToString(page))
      .join("\n");

    expect(pageOutput).toContain("<session-sidebar");
    expect(pageOutput).toContain("<chat-panel");
    expect(pageOutput).toContain("<diff-renderer-shell");
    expect(pageOutput).toContain("Changed files");
  });

  test("translates the active pane into the swipe pager initial page", () => {
    const el = new MobileLayout();
    el.activePane = "changes";

    const values = collectTemplateValues(el.render());

    expect(values).toContain(2);
  });

  test("emits named pane changes from swipe pager page changes", () => {
    const el = new MobileLayout();
    const panes: string[] = [];
    el.addEventListener("pane-change", (event) => {
      if (event instanceof CustomEvent) panes.push(event.detail.pane);
    });

    Reflect.get(el, "handlePageChange").call(el, new CustomEvent("page-change", { detail: { page: 3 } }));

    expect(panes).toEqual(["files"]);
  });

  test("pane content updates preserve the current pager position", () => {
    const el = new MobileLayout();
    el.activePane = "chat";
    const pager = {
      goToPage: mock(() => {}),
      resetToPage: mock(() => {}),
    };
    Object.defineProperty(el, "renderRoot", {
      configurable: true,
      value: { querySelector: mock(() => pager) },
    });

    Reflect.apply(el.updated, el, [new Map<string, unknown>([["panes", {}]])]);

    expect(pager.resetToPage).not.toHaveBeenCalled();
    expect(pager.goToPage).not.toHaveBeenCalled();
  });

  test("active pane changes drive pager navigation", () => {
    const el = new MobileLayout();
    el.activePane = "chat";
    const pager = {
      goToPage: mock(() => {}),
      resetToPage: mock(() => {}),
    };
    Object.defineProperty(el, "renderRoot", {
      configurable: true,
      value: { querySelector: mock(() => pager) },
    });

    Reflect.apply(el.updated, el, [new Map<string, unknown>([
      ["panes", {}],
      ["activePane", "sessions"],
    ])]);

    expect(pager.goToPage).toHaveBeenCalledWith(1);
    expect(pager.resetToPage).not.toHaveBeenCalled();
  });
});
