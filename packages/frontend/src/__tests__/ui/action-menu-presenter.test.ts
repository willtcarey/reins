import { describe, expect, mock, test } from "bun:test";
import { html } from "lit";
import { ActionMenuPresenter } from "../../ui/action-menu-presenter.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

describe("ActionMenuPresenter", () => {
  test("presents context actions at a viewport-clamped cursor position", () => {
    const presenter = new ActionMenuPresenter();
    presenter.ariaLabel = "Card actions";
    presenter.contextWidth = 160;
    presenter.contextHeight = 64;
    presenter.content = () => html`<button type="button">Archive</button>`;

    presenter.openContext(10_000, 10_000);

    const output = templateToString(presenter.render());
    expect(output).toContain('popover="manual"');
    expect(output).toContain("role=menu");
    expect(output).toContain("aria-label=Card actions");
    expect(output).toContain("left: 856px");
    expect(output).toContain("top: 704px");
    expect(output).toContain("Archive");
  });

  test("focuses the first action when presenting the popover", () => {
    const presenter = new ActionMenuPresenter();
    const focus = mock(() => {});
    const showPopover = mock(() => {});
    Object.defineProperty(presenter, "querySelector", {
      value: () => ({
        matches: () => false,
        showPopover,
        querySelector: () => ({ focus }),
      }),
    });
    presenter.openContext(20, 30);

    presenter.updated();

    expect(showPopover).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  test("presents a mobile sheet and resolves when Escape dismisses it", async () => {
    const presenter = new ActionMenuPresenter();
    presenter.ariaLabel = "Message actions";
    presenter.content = () => html`<button type="button">Copy as Markdown</button>`;
    const dismissed = presenter.openSheet();

    const template = presenter.render();
    const output = templateToString(template);
    expect(output).toContain("role=dialog");
    expect(output).toContain("bg-black/40");
    expect(output).toContain("Copy as Markdown");
    expect(output).toContain("Cancel");

    const keydown = collectTemplateEventListeners(template, "keydown")[0];
    const escape = new Event("keydown");
    Object.defineProperty(escape, "key", { value: "Escape" });
    keydown?.call(presenter, escape);
    await dismissed;
    expect(templateToString(presenter.render())).toBe("");
  });

  test("dismisses when the backdrop is activated", () => {
    const presenter = new ActionMenuPresenter();
    presenter.content = () => html`<button type="button">Archive</button>`;
    presenter.openContext(20, 30);

    const click = collectTemplateEventListeners(presenter.render(), "click")[0];
    click?.call(presenter, new Event("click"));

    expect(templateToString(presenter.render())).toBe("");
  });
});
