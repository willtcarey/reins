/**
 * Tests for diff-file-card collapse behavior.
 *
 * Collapse is internal to each card — the parent does not manage it.
 * The card starts expanded and toggles via its own click handler.
 * No `toggle-collapse` event is emitted.
 */
import { describe, test, expect } from "bun:test";
import { DiffFileCard } from "../components/changes/diff-file-card.js";
import { getElementProperties } from "./helpers/lit-internals.js";

describe("DiffFileCard collapse", () => {
  test("collapsed is not a reflected property (it is internal state)", () => {
    const card = new DiffFileCard();
    // collapsed should not appear in the static properties map as a
    // user-settable @property — it's @state (internal).
    const props = getElementProperties(card);
    const descriptor = props.get("collapsed");
    // @state() properties have { state: true } — they are not settable
    // via attribute or intended for parent use.
    expect(descriptor?.state).toBe(true);
  });

  test("card starts expanded (collapsed = false)", () => {
    const card = new DiffFileCard();
    expect(card["collapsed"]).toBe(false);
  });

  test("_toggleCollapse flips collapsed without emitting an event", () => {
    const card = new DiffFileCard();
    const events: string[] = [];
    card.addEventListener("toggle-collapse", () => events.push("toggle-collapse"));

    card["_toggleCollapse"]();

    expect(card["collapsed"]).toBe(true);
    expect(events).toEqual([]);

    card["_toggleCollapse"]();

    expect(card["collapsed"]).toBe(false);
    expect(events).toEqual([]);
  });
});
