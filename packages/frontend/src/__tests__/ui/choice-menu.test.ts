import { describe, expect, test } from "bun:test";
import type { PropertyValues } from "lit";
import { ChoiceMenu, matchingChoices } from "../../ui/choice-menu.js";

const projects = [
  { id: 1, label: "reins", detail: "/work/reins" },
  { id: 2, label: "website", detail: "/work/site" },
  { id: 3, label: "infrastructure", detail: "/work/infra" },
];

/** A menu of `projects` with `chosen` selected, the IDs it chose, and whether it closed its popover. */
function menuOf(chosen: number | null = null) {
  const choices: unknown[] = [];
  let closed = 0;
  const menu = new ChoiceMenu();
  menu.items = projects;
  menu.selected = chosen;
  menu.choose = (id) => choices.push(id);
  const changed: PropertyValues<ChoiceMenu> = new Map();
  changed.set("items", []);
  menu.willUpdate(changed);
  Reflect.set(menu, "closest", () => ({ close: () => { closed += 1; } }));
  const key = (name: string) => {
    let prevented = false;
    Reflect.get(menu, "handleKeyDown").call(menu, { key: name, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  const type = (query: string) => Reflect.get(menu, "handleInput").call(menu, { target: { value: query } });
  return { menu, choices, closed: () => closed, key, type };
}

describe("matchingChoices", () => {
  test("lists every item for no query, and otherwise those whose label or detail matches", () => {
    expect(matchingChoices("", projects).map((item) => item.id)).toEqual([1, 2, 3]);
    expect(matchingChoices("infra", projects).map((item) => item.id)).toEqual([3]);
    expect(matchingChoices("work/site", projects).map((item) => item.id)).toEqual([2]);
    expect(matchingChoices("zzz", projects)).toEqual([]);
  });
});

describe("ChoiceMenu", () => {
  test("chooses the item the arrow keys move to with Enter, then closes", () => {
    const { choices, closed, key } = menuOf(1);

    expect(key("ArrowDown")).toBe(true);
    key("ArrowDown");
    key("ArrowDown");
    key("ArrowUp");
    key("Enter");

    expect(choices).toEqual([3]);
    expect(closed()).toBe(1);
  });

  test("starts on the item chosen, and on the first match once a query is typed", () => {
    const chosen = menuOf(2);
    chosen.key("Enter");
    const filtered = menuOf(2);
    filtered.type("infra");
    filtered.key("Enter");

    expect(chosen.choices).toEqual([2]);
    expect(filtered.choices).toEqual([3]);
  });

  test("closes on Escape, and chooses nothing when nothing matches", () => {
    const escaped = menuOf();
    escaped.key("Escape");
    const unmatched = menuOf();
    unmatched.type("zzz");
    unmatched.key("Enter");

    expect([escaped.choices, escaped.closed()]).toEqual([[], 1]);
    expect([unmatched.choices, unmatched.closed()]).toEqual([[], 0]);
  });
});
