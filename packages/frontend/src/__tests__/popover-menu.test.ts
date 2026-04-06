import { describe, expect, test } from "bun:test";
import { PopoverMenu } from "../components/popover-menu.js";

describe("PopoverMenu", () => {
  test("closes the panel on internal clicks", () => {
    const el = new PopoverMenu();
    // @ts-expect-error testing internal state
    el.open = true;
    // @ts-expect-error testing internal method
    el.onPanelClick();
    // @ts-expect-error testing internal state
    expect(el.open).toBe(false);
  });
});
