import { describe, expect, mock, test } from "bun:test";
import type { ActionMenuPresentation } from "../../ui/action-menu-presenter.js";
import { MessageActionMenuElement } from "../../components/message-action-menu.js";
import { collectTemplateEventListeners, isTemplateResult, templateToString } from "../helpers/lit-template.js";

function menuContent(element: MessageActionMenuElement): (presentation: ActionMenuPresentation) => unknown {
  const rendered = element.render();
  if (!isTemplateResult(rendered)) throw new Error("Expected message action menu template");
  const index = rendered.strings.findIndex((part) => part.includes(".content="));
  const content = rendered.values[index];
  if (typeof content !== "function") throw new Error("Expected action content renderer");
  return (presentation) => Reflect.apply(content, element, [presentation]);
}

describe("MessageActionMenuElement", () => {
  test("copies the message and dismisses the shared presenter immediately", async () => {
    const element = new MessageActionMenuElement();
    const copyMessage = mock(async (_text: string) => true);
    const openContext = mock((_x: number, _y: number) => {});
    const close = mock(() => {});
    element.copyMessage = copyMessage;
    Object.defineProperty(element, "actionMenuPresenter", {
      configurable: true,
      value: { isOpen: true, openContext, close },
    });

    element.openContext("**raw markdown**", 40, 50);
    expect(openContext).toHaveBeenCalledWith(40, 50);
    close.mockClear();

    const action = menuContent(element)("context");
    expect(templateToString(action)).toContain("Copy as Markdown");
    await collectTemplateEventListeners(action, "click")[0]?.call(element, new Event("click"));

    expect(copyMessage).toHaveBeenCalledWith("**raw markdown**");
    expect(close).toHaveBeenCalledTimes(1);
    expect(templateToString(menuContent(element)("context"))).not.toContain("Copied");
  });
});
