import { describe, expect, mock, test } from "bun:test";
import { MessageActionMenuElement } from "../../components/message-action-menu.js";
import { collectTemplateEventListeners, templateToString } from "../helpers/lit-template.js";

describe("MessageActionMenuElement", () => {
  test("opens a mobile sheet whose promise resolves on dismissal", async () => {
    const element = new MessageActionMenuElement();
    const dismissed = element.openSheet("raw markdown");

    const template = element.render();
    const output = templateToString(template);

    expect(output).toContain("role=dialog");
    expect(output).toContain("Copy as Markdown");
    expect(output).toContain("Cancel");
    expect(output).not.toContain("left:");
    expect(output).not.toContain("top:");

    collectTemplateEventListeners(template, "click")[0]?.call(element, new Event("click"));
    await dismissed;
    expect(templateToString(element.render())).toBe("");
  });

  test("renders a positioned desktop menu", () => {
    const element = new MessageActionMenuElement();
    element.openContext("raw markdown", 80, 120);

    const output = templateToString(element.render());
    expect(output).toContain("role=menu");
    expect(output).toContain("role=menuitem");
  });

  test("copies its active message through the shared operation and owns confirmation", async () => {
    const element = new MessageActionMenuElement();
    const copyMessage = mock(async (_text: string) => true);
    element.copyMessage = copyMessage;
    element.openContext("raw markdown", 80, 120);

    const clickListeners = collectTemplateEventListeners(element.render(), "click");
    await clickListeners.at(-1)?.call(element, new Event("click"));

    expect(copyMessage).toHaveBeenCalledWith("raw markdown");
    const output = templateToString(element.render());
    expect(output).toContain("Copied");
    expect(output).toContain("?disabled=true");
    element.close();
  });
});
