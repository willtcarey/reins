import { describe, expect, test } from "bun:test";
import { html } from "lit";
import { AppDialog, dialogButton } from "../../ui/dialog.js";
import { clickButton, collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

/** The dialog's text as a user reads it: markup stripped, whitespace collapsed. */
function visibleText(dialog: AppDialog): string {
  return templateToString(dialog.render()).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

/** An open dialog, recording each request to cancel it. */
function openDialog() {
  const dialog = new AppDialog();
  dialog.open = true;
  dialog.heading = "Move Session";
  dialog.body = html`<p>Pick a node.</p>`;
  const cancels: Event[] = [];
  dialog.addEventListener("dialog-cancel", (event) => cancels.push(event));
  return { dialog, cancels };
}

/** An event as the `<dialog>` element receives it, from `target`. */
function eventAt(type: string, target: unknown, currentTarget: unknown): Event {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "target", { value: target });
  Object.defineProperty(event, "currentTarget", { value: currentTarget });
  return event;
}

/** A keydown as the panel receives it (Bun has no KeyboardEvent). */
function keydown(keys: { key: string; metaKey?: boolean; ctrlKey?: boolean }): Event {
  return Object.assign(new Event("keydown", { cancelable: true }), { metaKey: false, ctrlKey: false, ...keys });
}

describe("AppDialog", () => {
  test("shows its heading, subtitle, body and actions while open, and nothing while closed", () => {
    const { dialog } = openDialog();
    dialog.subtitle = "Investigate the release";
    let moved = 0;
    dialog.actions = html`${dialogButton({ label: "Cancel" })}${dialogButton({ label: "Move", variant: "primary", onClick: () => { moved += 1; } })}`;

    expect(visibleText(dialog)).toBe("Move Session Investigate the release Pick a node. Cancel Move");
    clickButton(dialog.render(), "Move");
    expect(moved).toBe(1);

    dialog.open = false;
    expect(visibleText(dialog)).toBe("");
  });

  test("Escape asks its owner to cancel instead of closing it", () => {
    const { dialog, cancels } = openDialog();
    const escape = new Event("cancel", { cancelable: true });

    // A modal dialog's Escape arrives as its `cancel` event.
    for (const listener of collectTemplateEventListeners(dialog.render(), "cancel")) listener(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(cancels).toHaveLength(1);
  });

  test("a click on the backdrop asks to cancel; one inside the panel does not", () => {
    const { dialog, cancels } = openDialog();
    const [onClick] = collectTemplateEventListeners(dialog.render(), "click");
    const element = {};

    onClick!(eventAt("click", {}, element));
    expect(cancels).toHaveLength(0);

    onClick!(eventAt("click", element, element));
    expect(cancels).toHaveLength(1);
  });

  test("as a form, a submit (a submit button, Enter in a field) or ⌘/Ctrl+Enter submits; other keys do not", () => {
    const { dialog } = openDialog();
    let submits = 0;
    dialog.onSubmit = () => { submits += 1; };
    const submit = new Event("submit", { cancelable: true });

    for (const listener of collectTemplateEventListeners(dialog.render(), "submit")) listener(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(submits).toBe(1);

    const [onKeydown] = collectTemplateEventListeners(dialog.render(), "keydown");
    onKeydown!(keydown({ key: "Enter", metaKey: true }));
    onKeydown!(keydown({ key: "Enter", ctrlKey: true }));
    onKeydown!(keydown({ key: "Enter" }));
    onKeydown!(keydown({ key: "a", metaKey: true }));
    expect(submits).toBe(3);
  });

  test("without onSubmit it is no form", () => {
    const { dialog } = openDialog();

    expect(templateToString(dialog.render())).not.toContain("<form");
    expect(collectTemplateEventListeners(dialog.render(), "submit")).toEqual([]);
  });

  test("once shown modally it focuses the autofocus field, and with selectOnOpen selects its text", () => {
    const { dialog } = openDialog();
    const calls: string[] = [];
    const field = { focus: () => calls.push("focus"), select: () => calls.push("select") };
    const element = { open: false, showModal() { this.open = true; calls.push("showModal"); }, querySelector: () => field };
    Reflect.set(dialog, "renderRoot", { querySelector: (selector: string) => selector === "dialog" ? element : null });

    dialog.updated();
    expect(calls).toEqual(["showModal", "focus"]);

    calls.length = 0;
    element.open = false;
    dialog.selectOnOpen = true;
    dialog.updated();
    expect(calls).toEqual(["showModal", "focus", "select"]);

    calls.length = 0;
    dialog.updated();
    expect(calls).toEqual([]);
  });
});
