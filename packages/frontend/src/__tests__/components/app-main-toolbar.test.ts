import { describe, expect, mock, test } from "bun:test";
import { AppMainToolbar } from "../../components/app-main-toolbar.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

function renderSessionActions(toolbar: AppMainToolbar): string {
  const render: unknown = Reflect.get(toolbar, "renderSessionActions");
  if (typeof render !== "function") throw new Error("Expected session action renderer");
  return templateToString(Reflect.apply(render, toolbar, []));
}

describe("AppMainToolbar", () => {
  test("places active-session actions at the far right while preserving responsive status", () => {
    const el = new AppMainToolbar();
    el.activePane = "changes";
    el.currentBranch = "feature/mobile-nav";
    el.showSidebarButton = true;
    el.connected = false;
    el.sessionId = "session-123";

    const output = templateToString(el.render());

    expect(output).toContain("Open sidebar");
    expect(output).toContain("Browse files");
    expect(output).toContain("translate-x-full");
    expect(output).toContain("hidden md:flex");
    expect(output).toContain("Disconnected");
    expect(output).toContain("<popover-menu");
    expect(output.indexOf("Disconnected")).toBeLessThan(output.indexOf("<popover-menu"));
  });

  test("offers read and unread controls for the active idle session", () => {
    const el = new AppMainToolbar();
    el.sessionId = "session-123";
    el.onSetSessionUnread = mock(async () => ({ ok: true }));
    el.activityState = "finished";

    expect(renderSessionActions(el)).toContain("Mark as read");

    el.activityState = null;

    expect(renderSessionActions(el)).toContain("Mark as unread");
  });

  test("emits navigation events from toolbar controls", () => {
    const el = new AppMainToolbar();
    el.showSidebarButton = true;
    const panes: string[] = [];
    const openFileBrowser = mock(() => {});

    el.addEventListener("pane-select", (event) => {
      if (event instanceof CustomEvent) panes.push(event.detail.pane);
    });
    el.addEventListener("open-file-browser", openFileBrowser);

    for (const click of collectTemplateEventListeners(el.render(), "click")) {
      click(new Event("click"));
    }

    expect(panes).toEqual(["sessions", "chat", "changes"]);
    expect(openFileBrowser).toHaveBeenCalledTimes(1);
  });
});
