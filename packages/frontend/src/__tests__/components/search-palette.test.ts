import { describe, expect, test } from "bun:test";
import { SearchPalette } from "../../components/search-palette.js";

function enter(modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}): KeyboardEvent {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperties(event, {
    key: { value: "Enter" },
    metaKey: { value: modifiers.metaKey ?? false },
    ctrlKey: { value: modifiers.ctrlKey ?? false },
  });
  // @ts-expect-error The palette reads only the key and modifier fields defined above.
  return event;
}

describe("SearchPalette", () => {
  test("Enter confirms the selected item and ⌘/Ctrl+Enter asks for its other action", () => {
    const palette = new SearchPalette();
    palette.itemCount = 3;
    const confirmed: number[] = [];
    const alternate: number[] = [];
    palette.addEventListener("confirm", (event) => { if (event instanceof CustomEvent) confirmed.push(event.detail); });
    palette.addEventListener("palette-alternate-confirm", (event) => alternate.push(event.detail));
    const keydown = Reflect.get(palette, "handleKeydown");

    keydown.call(palette, enter());
    keydown.call(palette, enter({ metaKey: true }));
    keydown.call(palette, enter({ ctrlKey: true }));

    expect(confirmed).toEqual([0]);
    expect(alternate).toEqual([0, 0]);
  });
});
