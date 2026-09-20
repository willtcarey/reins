import { describe, expect, mock, test } from "bun:test";
import { AppMainToolbar } from "../../components/app-main-toolbar.js";
import { collectTemplateEventListeners, isTemplateResult, templateToString } from "../helpers/lit-template.js";

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

describe("AppMainToolbar", () => {
  test("shows no overflow menu in the browser", () => {
    const el = new AppMainToolbar();
    el.activePane = "changes";
    el.currentBranch = "feature/mobile-nav";
    el.showSidebarButton = true;
    el.connected = false;

    const output = templateToString(el.render());

    expect(output).toContain("Open sidebar");
    expect(output).toContain("Browse files");
    expect(output).toContain("translate-x-full");
    expect(output).toContain("hidden md:flex");
    expect(output).toContain("Disconnected");
    expect(output).not.toContain("<popover-menu");
  });

  test("offers Reload as the only standalone overflow action", () => {
    const el = new AppMainToolbar();
    const reloadRequest = mock(() => {});
    Reflect.set(el, "sessionId", "session-123");
    el.isStandalone = true;
    el.addEventListener("reload-request", reloadRequest);

    expect(templateToString(el.render())).toContain("<popover-menu");

    const content = renderOverflowContent(el);
    expect(templateToString(content)).toContain("Reload");
    expect(collectTemplateEventListeners(content, "click")).toHaveLength(1);

    collectTemplateEventListeners(content, "click")[0]?.(new Event("click"));
    expect(reloadRequest).toHaveBeenCalledTimes(1);
  });

  test("emits navigation events from toolbar controls", () => {
    const el = new AppMainToolbar();
    el.showSidebarButton = true;
    const panes: string[] = [];
    const openFileBrowserDetails: unknown[] = [];
    el.projectId = 42;

    el.addEventListener("pane-select", (event) => {
      if (event instanceof CustomEvent) panes.push(event.detail.pane);
    });
    el.addEventListener("open-file-browser", (event) => openFileBrowserDetails.push(event.detail));

    for (const click of collectTemplateEventListeners(el.render(), "click")) {
      click(new Event("click"));
    }

    expect(panes).toEqual(["sessions", "chat", "changes"]);
    expect(openFileBrowserDetails).toEqual([{ projectId: 42 }]);
  });
});
