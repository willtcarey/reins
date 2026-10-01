import { describe, expect, mock, test } from "bun:test";
import { html } from "lit";
import { ActionMenuPresenter, touchMenuPlacement, type TouchMenuAnchor } from "../../ui/action-menu-presenter.js";
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
    expect(output).toContain(`role="menu"`);
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

  test("presents a touch menu without a separate cancel control and resolves when Escape dismisses it", async () => {
    const presenter = new ActionMenuPresenter();
    presenter.ariaLabel = "Message actions";
    presenter.content = (presentation) => html`<button type="button">Copy as Markdown (${presentation})</button>`;
    const dismissed = presenter.openTouch(anchor(rect(16, 200, 300, 48), 40, 220));

    const template = presenter.render();
    const output = templateToString(template);
    expect(output).toContain(`role="menu"`);
    expect(output).toContain("aria-label=Message actions");
    expect(output).toContain("Copy as Markdown (touch)");
    expect(output).not.toContain("Cancel");

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

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function anchor(itemRect: ReturnType<typeof rect>, x: number, y: number): TouchMenuAnchor {
  return { rect: itemRect, x, y };
}

describe("touchMenuPlacement", () => {
  const viewport = { viewportWidth: 400, viewportHeight: 800 };

  test("grows below a left-side item from its leading edge", () => {
    const placement = touchMenuPlacement({
      anchor: anchor(rect(16, 200, 300, 48), 40, 220),
      width: 240,
      height: 100,
      ...viewport,
    });

    expect(placement).toEqual({ left: 16, top: 256, originX: 0, originY: 0 });
  });

  test("aligns to the trailing edge of a right-side item", () => {
    const placement = touchMenuPlacement({
      anchor: anchor(rect(200, 200, 184, 48), 300, 220),
      width: 240,
      height: 100,
      ...viewport,
    });

    expect(placement).toEqual({ left: 144, top: 256, originX: 240, originY: 0 });
  });

  test("grows upward from an item near the bottom of the viewport", () => {
    const placement = touchMenuPlacement({
      anchor: anchor(rect(16, 700, 300, 48), 40, 720),
      width: 240,
      height: 100,
      ...viewport,
    });

    expect(placement).toEqual({ left: 16, top: 592, originX: 0, originY: 100 });
  });

  test("grows above the press point of a tall item even when the menu would fit beside it", () => {
    const placement = touchMenuPlacement({
      anchor: anchor(rect(16, 100, 300, 300), 60, 250),
      width: 240,
      height: 100,
      ...viewport,
    });

    expect(placement).toEqual({ left: 60, top: 142, originX: 0, originY: 100 });
  });

  test("grows above the press point when the item leaves no room above or below", () => {
    const placement = touchMenuPlacement({
      anchor: anchor(rect(16, -400, 300, 1600), 60, 300),
      width: 240,
      height: 100,
      ...viewport,
    });

    expect(placement).toEqual({ left: 60, top: 192, originX: 0, originY: 100 });
  });
});
