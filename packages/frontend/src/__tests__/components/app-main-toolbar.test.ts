import { describe, expect, mock, test } from "bun:test";
import { AppMainToolbar } from "../../components/app-main-toolbar.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

describe("AppMainToolbar", () => {
  test("renders optional mobile sidebar and responsive connection controls", () => {
    const el = new AppMainToolbar();
    el.activePane = "changes";
    el.currentBranch = "feature/mobile-nav";
    el.showSidebarButton = true;
    el.connected = false;
    el.isStandalone = true;

    const output = templateToString(el.render());

    expect(output).toContain("Open sidebar");
    expect(output).toContain("Browse files");
    expect(output).toContain("Chat");
    expect(output).toContain("Changes");
    expect(output).toContain("translate-x-full");
    expect(output).toContain("hidden md:flex");
    expect(output).toContain("Disconnected");
    expect(output).toContain("Reload");
  });

  test("emits toolbar action events from rendered controls", () => {
    const el = new AppMainToolbar();
    el.showSidebarButton = true;
    el.isStandalone = true;
    const panes: string[] = [];
    const openFileBrowser = mock(() => {});
    const reload = mock(() => {});

    el.addEventListener("pane-select", (event) => {
      if (event instanceof CustomEvent) panes.push(event.detail.pane);
    });
    el.addEventListener("open-file-browser", openFileBrowser);
    el.addEventListener("reload-request", reload);

    const clickHandlers = collectTemplateEventListeners(el.render(), "click");
    expect(clickHandlers).toHaveLength(5);

    for (const click of clickHandlers) click(new Event("click"));

    expect(panes).toEqual(["sessions", "chat", "changes"]);
    expect(openFileBrowser).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
