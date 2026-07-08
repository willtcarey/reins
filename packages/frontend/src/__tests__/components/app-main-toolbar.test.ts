import { describe, expect, mock, test } from "bun:test";
import { AppMainToolbar } from "../../components/app-main-toolbar.js";
import { templateToString } from "../helpers/lit-template.js";

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

  test("emits toolbar action events", () => {
    const el = new AppMainToolbar();
    const panes: string[] = [];
    const openSidebar = mock(() => {});
    const openFileBrowser = mock(() => {});
    const reload = mock(() => {});

    el.addEventListener("pane-select", (event) => {
      if (event instanceof CustomEvent) panes.push(event.detail.pane);
    });
    el.addEventListener("open-sidebar", openSidebar);
    el.addEventListener("open-file-browser", openFileBrowser);
    el.addEventListener("reload-request", reload);

    Reflect.get(el, "selectPane").call(el, "changes");
    Reflect.get(el, "dispatchSimple").call(el, "open-sidebar");
    Reflect.get(el, "dispatchSimple").call(el, "open-file-browser");
    Reflect.get(el, "dispatchSimple").call(el, "reload-request");

    expect(panes).toEqual(["changes"]);
    expect(openSidebar).toHaveBeenCalledTimes(1);
    expect(openFileBrowser).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
