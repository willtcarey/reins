import { afterEach, describe, expect, test } from "bun:test";
import { SessionRenameDialog } from "../../components/session-rename-dialog.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

const originalHtmlInputElement = globalThis.HTMLInputElement;

class TestInputElement extends EventTarget {
  value = "";
}

afterEach(() => {
  Reflect.set(globalThis, "HTMLInputElement", originalHtmlInputElement);
});

describe("SessionRenameDialog", () => {
  test("prefills the custom name and saves a cleared name as the fallback", () => {
    Reflect.set(globalThis, "HTMLInputElement", TestInputElement);
    const dialog = new SessionRenameDialog();
    const saves: Array<{ sessionId: string; name: string | null }> = [];
    dialog.addEventListener("save-session-name", (event) => saves.push(event.detail));

    dialog.open({ id: "session-1", name: "Old name", firstMessage: "Investigate the release" });
    expect(templateToString(dialog.render())).toContain("Investigate the release");

    const input = new TestInputElement();
    input.value = "   ";
    const inputEvent = new Event("input");
    Object.defineProperty(inputEvent, "target", { value: input });
    collectTemplateEventListeners(dialog.render(), "input")[0]?.(inputEvent);

    const clicks = collectTemplateEventListeners(dialog.render(), "click");
    clicks[clicks.length - 1]?.(new Event("click"));

    expect(saves).toEqual([{ sessionId: "session-1", name: null }]);
  });
});
