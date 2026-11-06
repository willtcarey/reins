import { describe, expect, mock, test } from "bun:test";
import type { PaneContext } from "@reins/sdk";
import { AppMainToolbar } from "../../components/app-main-toolbar.js";
import { collectTemplateEventListeners, collectTemplateProperties, isTemplateResult, templateToString } from "../helpers/lit-template.js";

function findOverflowContent(value: unknown): (() => unknown) | undefined {
  if (!isTemplateResult(value)) return undefined;

  const contentIndex = value.strings.findIndex((part) => part.includes(".content="));
  const content = value.values[contentIndex];
  if (typeof content === "function") return () => Reflect.apply(content, undefined, []);

  for (const nestedValue of value.values) {
    const nestedContent = findOverflowContent(nestedValue);
    if (nestedContent) return nestedContent;
  }
  return undefined;
}

function renderOverflowContent(toolbar: AppMainToolbar) {
  const content = findOverflowContent(toolbar.render());
  if (!content) throw new Error("Expected overflow content renderer");
  return content();
}

const chat = { view: "session", sessionId: "s1" };
const changes = { view: "session-changes", sessionId: "s1" };

describe("AppMainToolbar", () => {
  test("shows the sidebar button and the connection, and no overflow menu in the browser", () => {
    const el = new AppMainToolbar();
    el.showSidebarButton = true;
    el.connected = false;

    const output = templateToString(el.render());

    expect(output).toContain("Open sidebar");
    expect(output).toContain("Disconnected");
    expect(output).not.toContain("<popover-menu");
  });

  test("offers Reload as the only standalone overflow action", () => {
    const el = new AppMainToolbar();
    const reloadRequest = mock(() => {});
    el.isStandalone = true;
    el.addEventListener("reload-request", reloadRequest);

    expect(templateToString(el.render())).toContain("<popover-menu");

    const content = renderOverflowContent(el);
    expect(templateToString(content)).toContain("Reload");
    expect(collectTemplateEventListeners(content, "click")).toHaveLength(1);

    collectTemplateEventListeners(content, "click")[0]?.(new Event("click"));
    expect(reloadRequest).toHaveBeenCalledTimes(1);
  });

  test("shows the main area's tabs, its own marked, and asks to open another's view, not its own", () => {
    const el = new AppMainToolbar();
    el.showSidebarButton = true;
    el.tabs = [{ view: chat, title: "Chat" }, { view: changes, title: "Changes" }];
    el.activeTab = 0;
    const opened: unknown[] = [];
    const panes: unknown[] = [];
    el.addEventListener("open-main-view", (event) => opened.push(event.detail));
    el.addEventListener("pane-select", (event) => panes.push(event.detail.pane));

    const rendered = el.render();
    for (const click of collectTemplateEventListeners(rendered, "click")) click(new Event("click"));

    expect(templateToString(rendered)).toContain("Chat");
    expect(templateToString(rendered)).toContain("Changes");
    expect(templateToString(rendered)).toContain('role="tab"');
    expect(opened).toEqual([changes]);
    expect(panes).toEqual(["sessions"]);
  });

  test("for a view alone, shows its title", () => {
    const el = new AppMainToolbar();
    el.pageTitle = "Inbox · reins";

    const output = templateToString(el.render());

    expect(output).toContain("Inbox · reins");
    expect(output).not.toContain('role="tab"');
  });

  test("mounts the view's toolbar in place of its title", () => {
    const el = new AppMainToolbar();
    const toolbar = { mount: () => {} };
    const view = { view: "test-inbox", repository: "reins" };
    const context: PaneContext = { source: null, container: "main" };
    el.pageTitle = "Inbox · reins";
    el.viewToolbar = { presentation: toolbar, view, context };

    const rendered = el.render();

    expect(templateToString(rendered)).toContain("<reins-view-mount");
    expect(templateToString(rendered)).not.toContain("Inbox · reins");
    expect(collectTemplateProperties(rendered, "presentation")).toEqual([toolbar]);
    expect(collectTemplateProperties(rendered, "view")).toEqual([view]);
    expect(collectTemplateProperties(rendered, "context")).toEqual([context]);
  });
});
