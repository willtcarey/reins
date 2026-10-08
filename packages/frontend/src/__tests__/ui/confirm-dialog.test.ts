import { describe, expect, test } from "bun:test";
import { ConfirmDialog } from "../../ui/confirm-dialog.js";
import { clickButton, collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

const REMOVE = { title: "Remove Laptop?", message: "This is permanent.", confirmLabel: "Remove", destructive: true };

/** Whether the confirmation shows, as its dialog shell is told. */
function shown(dialog: ConfirmDialog): boolean {
  return templateToString(dialog.render()).includes(".open=true");
}

describe("ConfirmDialog", () => {
  test("shows the question and resolves true when confirmed", async () => {
    const dialog = new ConfirmDialog();

    const answer = dialog.open(REMOVE);

    const output = templateToString(dialog.render());
    expect(output).toContain("heading=Remove Laptop?");
    expect(output).toContain("This is permanent.");
    clickButton(dialog.render(), "Remove");
    expect(await answer).toBe(true);
    expect(shown(dialog)).toBe(false);
  });

  test("resolves false when cancelled", async () => {
    const dialog = new ConfirmDialog();

    const answer = dialog.open(REMOVE);
    clickButton(dialog.render(), "Cancel");

    expect(await answer).toBe(false);
    expect(shown(dialog)).toBe(false);
  });

  test("resolves false when its dialog is dismissed (Escape, the backdrop)", async () => {
    const dialog = new ConfirmDialog();

    const answer = dialog.open(REMOVE);
    for (const listener of collectTemplateEventListeners(dialog.render(), "dialog-cancel")) listener(new CustomEvent("dialog-cancel"));

    expect(await answer).toBe(false);
  });

  test("opening another question cancels the one still open", async () => {
    const dialog = new ConfirmDialog();

    const first = dialog.open(REMOVE);
    const second = dialog.open({ title: "Discard this draft?", message: "It is lost.", confirmLabel: "Discard" });

    expect(await first).toBe(false);
    expect(templateToString(dialog.render())).toContain("Discard this draft?");
    clickButton(dialog.render(), "Discard");
    expect(await second).toBe(true);
  });
});
