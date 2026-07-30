import { describe, expect, mock, test } from "bun:test";
import { html } from "lit";
import { PopoverMenu } from "../../components/popover-menu.js";
import { templateToString } from "../helpers/lit-template.js";

describe("PopoverMenu", () => {
  test("keeps the panel open on internal clicks by default", () => {
    const el = new PopoverMenu();
    // @ts-expect-error testing internal state
    el.open = true;
    // @ts-expect-error testing internal method
    el.onPanelClick();
    // @ts-expect-error testing internal state
    expect(el.open).toBe(true);
  });

  test("closes the panel on internal clicks when opted in", () => {
    const el = new PopoverMenu();
    el.closeOnPanelClick = true;
    // @ts-expect-error testing internal state
    el.open = true;
    // @ts-expect-error testing internal method
    el.onPanelClick();
    // @ts-expect-error testing internal state
    expect(el.open).toBe(false);
  });

  test("promotes an open panel to the top layer so transformed panes do not offset it", () => {
    const el = new PopoverMenu();
    const showPopover = mock(() => {});
    el.content = () => html`<button>Action</button>`;
    // @ts-expect-error testing rendered open state
    el.open = true;
    Reflect.set(el, "renderRoot", {
      querySelector: () => ({ matches: () => false, showPopover }),
    });

    const output = templateToString(el.render());
    el.updated();

    expect(output).toContain('popover="manual"');
    expect(showPopover).toHaveBeenCalledTimes(1);
  });
});
