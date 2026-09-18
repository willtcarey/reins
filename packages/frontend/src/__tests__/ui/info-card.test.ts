import { describe, expect, mock, test } from "bun:test";
import { html } from "lit";
import { InfoCard } from "../../ui/info-card.js";
import { LongPressDirective } from "../../directives/long-press.js";
import { collectTemplateEventListeners, collectTemplateValues, isTemplateResult, templateToString } from "../helpers/lit-template.js";

describe("InfoCard", () => {
  test("renders linked information with template-valued leading and trailing content", () => {
    const card = new InfoCard();
    card.title = "Investigate a very long-running child session";
    card.subtitle = "Running";
    card.href = "#/session/child";
    card.primaryLabel = "Open child session";
    card.leading = html`<span data-leading>●</span>`;
    card.trailing = html`<button data-action>Delegate actions</button>`;

    const output = templateToString(card.render());

    expect(output).toContain('href=#/session/child');
    expect(output).toContain('aria-label=Open child session');
    expect(output).toContain("truncate");
    expect(output).toContain("Investigate a very long-running child session");
    expect(output).toContain("Running");
    expect(output).toContain("data-leading");
    expect(output).toContain("</a>");
    expect(output.indexOf("</a>")).toBeLessThan(output.indexOf("data-action"));
  });

  test("omits empty leading and trailing layout when Lit assigns undefined", () => {
    const card = new InfoCard();
    card.title = "Session";
    Reflect.set(card, "leading", undefined);
    Reflect.set(card, "trailing", undefined);

    const output = templateToString(card.render());

    expect(output).not.toContain('<span class="flex shrink-0 items-center">');
    expect(output).not.toContain('<span class="flex shrink-0 items-center pr-2.5">');
  });

  test("registers long press when actions are available", () => {
    const card = new InfoCard();
    card.title = "Session";
    card.actions = [{ label: "Archive", run: () => undefined }];

    const directives = collectTemplateValues(card.render()).filter((value) => (
      typeof value === "object"
      && value !== null
      && Reflect.get(value, "_$litDirective$") === LongPressDirective
    ));

    expect(directives).toHaveLength(1);
  });

  test("renders touch-sized actions in the mobile sheet", () => {
    const card = new InfoCard();
    card.title = "Session";
    card.actions = [{ label: "Mark as unread", run: () => undefined }];
    const presenter = collectTemplateValues(card.render()).find((value) => (
      isTemplateResult(value)
      && value.strings.some((part) => part.includes("<action-menu-presenter"))
    ));
    if (!isTemplateResult(presenter)) throw new Error("Expected action menu presenter template");
    const contentIndex = presenter.strings.findIndex((part) => part.includes(".content="));
    const content = presenter.values[contentIndex];
    if (typeof content !== "function") throw new Error("Expected action menu content renderer");

    const sheet = Reflect.apply(content, card, ["sheet"]);

    expect(templateToString(sheet)).toContain("min-h-12");
    expect(templateToString(sheet)).toContain("text-sm");
    expect(templateToString(sheet)).toContain("Mark as unread");
  });

  test("provides generic actions through the shared context-menu presenter", () => {
    const card = new InfoCard();
    card.title = "Session";
    card.actions = [{ label: "Archive", run: () => undefined }];
    const openContext = mock((_x: number, _y: number) => {});
    Object.defineProperty(card, "actionMenuPresenter", {
      configurable: true,
      value: { openContext, close() {} },
    });
    const preventDefault = mock(() => {});
    const contextMenuEvent = new Event("contextmenu");
    Object.defineProperties(contextMenuEvent, {
      clientX: { value: 40 },
      clientY: { value: 50 },
      preventDefault: { value: preventDefault },
    });

    const template = card.render();
    const [openContextMenu] = collectTemplateEventListeners(template, "contextmenu");
    openContextMenu?.call(card, contextMenuEvent);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(openContext).toHaveBeenCalledWith(40, 50);
    expect(templateToString(template)).toContain(".ariaLabel=Card actions");
    expect(templateToString(template)).toContain("<action-menu-presenter");
  });

  test("renders a button and emits a primary activation event", () => {
    const card = new InfoCard();
    card.title = "Session";
    let activated = false;
    card.addEventListener("info-card-activate", () => { activated = true; });

    const template = card.render();
    const [click] = collectTemplateEventListeners(template, "click");
    click?.call(card, new Event("click"));

    expect(templateToString(template)).toContain("<button");
    expect(activated).toBe(true);
  });
});
