import { describe, expect, test } from "bun:test";
import { html } from "lit";
import { ChoiceSelector } from "../../ui/choice-selector.js";
import { collectTemplateProperties, templateToString } from "../helpers/lit-template.js";

describe("ChoiceSelector", () => {
  test("shows its value as the trigger of a popover with the content it is given", () => {
    const el = new ChoiceSelector();
    el.label = "reins";
    el.content = () => html`<choice-menu></choice-menu>`;

    const template = el.render();

    expect(templateToString(template)).toContain("reins");
    expect(collectTemplateProperties(template, "content")).toEqual([el.content]);
  });

  test("marks a choice still to make", () => {
    const el = new ChoiceSelector();
    expect(templateToString(el.render())).not.toContain("text-blue-300");

    el.prompt = true;
    expect(templateToString(el.render())).toContain("text-blue-300");
  });
});
