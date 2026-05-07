import { describe, expect, test } from "bun:test";
import { PopoverMenu } from "../components/popover-menu.js";

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
});
