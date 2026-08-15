import { describe, expect, mock, test } from "bun:test";
import type { ReactiveController, ReactiveControllerHost } from "lit";
import { MessageActionsController } from "../../controllers/message-actions-controller.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

function fakeHost(): ReactiveControllerHost {
  return {
    addController(_controller: ReactiveController) {},
    removeController(_controller: ReactiveController) {},
    requestUpdate() {},
    updateComplete: Promise.resolve(true),
  };
}

describe("MessageActionsController", () => {
  test("renders direct copy only when requested and copies the message Markdown", async () => {
    const writeText = mock(async (_text: string) => undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const controller = new MessageActionsController(fakeHost());
    const message = { toMarkdown: () => "**raw markdown**" };

    try {
      expect(templateToString(controller.for(message).render())).not.toContain("Copy as Markdown");

      const template = controller.for(message).render({ directCopy: true });
      expect(templateToString(template)).toContain("Copy as Markdown");
      await collectTemplateEventListeners(template, "click")[0]?.call(controller, new Event("click"));

      expect(writeText).toHaveBeenCalledWith("**raw markdown**");
      expect(templateToString(controller.for(message).render({ directCopy: true }))).toContain("Copied");
    } finally {
      controller.hostDisconnected();
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
    }
  });

  test("does not show copied feedback when the clipboard operation fails", async () => {
    const writeText = mock(async (_text: string) => { throw new Error("denied"); });
    const toast = { add(_message: string, _level: string) {} };
    const textarea = { value: "", style: {}, select() {} };
    const originalClipboard = navigator.clipboard;
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    if (globalThis.document === undefined) {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: {
          createElement: (tag: string) => tag === "textarea" ? textarea : toast,
          body: { appendChild() {}, removeChild() {} },
        },
      });
    }
    const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    const controller = new MessageActionsController(fakeHost());
    const message = { toMarkdown: () => "answer" };

    try {
      const template = controller.for(message).render({ directCopy: true });
      await collectTemplateEventListeners(template, "click")[0]?.call(controller, new Event("click"));

      expect(templateToString(controller.for(message).render({ directCopy: true }))).not.toContain("Copied");
    } finally {
      controller.hostDisconnected();
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
      if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
      else Reflect.deleteProperty(document, "execCommand");
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
    }
  });

  test("does not render actions for a message without Markdown", () => {
    const controller = new MessageActionsController(fakeHost());
    const actions = controller.for({ toMarkdown: () => null });

    expect(actions.enabled).toBe(false);
    expect(templateToString(actions.render({ directCopy: true }))).toBe("");
  });
});
