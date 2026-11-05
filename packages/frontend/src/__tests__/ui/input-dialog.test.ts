import { afterEach, describe, expect, test } from "bun:test";
import { InputDialog } from "../../ui/input-dialog.js";
import { collectTemplateEventListeners, submitDialog, templateToString } from "../helpers/lit-template.js";

const originalHtmlInputElement = globalThis.HTMLInputElement;
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

class TestInputElement extends EventTarget {
  value = "";
}

afterEach(() => {
  Reflect.set(globalThis, "HTMLInputElement", originalHtmlInputElement);
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

/** A document for the error toast, in case no earlier test made the toast container. */
function stubToasts() {
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ add() {} }), body: { appendChild() {} } },
  });
}

function type(dialog: InputDialog, value: string) {
  const input = new TestInputElement();
  input.value = value;
  const event = new Event("input");
  Object.defineProperty(event, "target", { value: input });
  collectTemplateEventListeners(dialog.render(), "input")[0]?.(event);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("InputDialog", () => {
  test("shows the placeholder, saves the value trimmed and resolves true; a refused save keeps it open", async () => {
    Reflect.set(globalThis, "HTMLInputElement", TestInputElement);
    stubToasts();
    const dialog = new InputDialog();
    const saves: string[] = [];
    let refuse = true;
    const answer = dialog.open({ heading: "Rename Session", label: "Name", value: "Old name", placeholder: "Investigate the release", save: async (value) => {
      saves.push(value);
      if (refuse) throw new Error("Database is locked");
    } });
    expect(templateToString(dialog.render())).toContain("Investigate the release");

    type(dialog, "  New name ");
    submitDialog(dialog.render());
    await settle();
    const openAfterRefusal = templateToString(dialog.render()).includes("Investigate the release");
    refuse = false;
    submitDialog(dialog.render());

    expect(await answer).toBe(true);
    expect(saves).toEqual(["New name", "New name"]);
    expect(openAfterRefusal).toBe(true);
    expect(templateToString(dialog.render())).not.toContain("Investigate the release");
  });

  test("resolves false when cancelled, or when another question replaces it", async () => {
    const dialog = new InputDialog();
    const ask = () => dialog.open({ heading: "Rename", label: "Name", value: "", save: async () => {} });

    const replaced = ask();
    const cancelled = ask();
    collectTemplateEventListeners(dialog.render(), "dialog-cancel")[0]?.(new Event("dialog-cancel"));

    expect([await replaced, await cancelled]).toEqual([false, false]);
  });
});
