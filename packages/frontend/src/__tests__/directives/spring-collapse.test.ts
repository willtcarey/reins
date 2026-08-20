import { afterEach, describe, expect, test } from "bun:test";
import { html, nothing } from "lit";
import { PartType, type PartInfo } from "lit/directive.js";
import { SpringCollapseDirective } from "../../directives/spring-collapse.js";
import { templateToString } from "../helpers/lit-template.js";

const childPart: PartInfo = { type: PartType.CHILD };
const originalResizeObserver = globalThis.ResizeObserver;

function installResizeObserver() {
  Reflect.set(globalThis, "ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
}

afterEach(() => {
  Reflect.set(globalThis, "ResizeObserver", originalResizeObserver);
});

describe("springCollapse", () => {
  test("does not render a collapsed body", () => {
    let bodyRenders = 0;
    const collapse = new SpringCollapseDirective(childPart);

    const result = collapse.render(true, () => {
      bodyRenders += 1;
      return html`<p>Body</p>`;
    });

    expect(result).toBe(nothing);
    expect(bodyRenders).toBe(0);
  });

  test("lazily mounts an expanding body and retains it while collapse begins", () => {
    installResizeObserver();
    let bodyRenders = 0;
    const collapse = new SpringCollapseDirective(childPart);
    const renderBody = () => {
      bodyRenders += 1;
      return html`<p>Body</p>`;
    };

    collapse.render(true, renderBody);
    const expanded = collapse.render(false, renderBody);
    const collapsing = collapse.render(true, renderBody);

    expect(templateToString(expanded)).toContain("data-spring-collapse-content");
    expect(templateToString(expanded)).toContain("<p>Body</p>");
    expect(templateToString(collapsing)).toContain("<p>Body</p>");
    expect(bodyRenders).toBe(2);
  });

  test("reports settled DOM states when animation is unavailable", () => {
    Reflect.set(globalThis, "ResizeObserver", undefined);
    const collapse = new SpringCollapseDirective(childPart);
    const renderBody = () => html`<p>Body</p>`;
    let settled = 0;

    collapse.render(true, renderBody, { onSettled: () => { settled += 1; } });
    expect(templateToString(collapse.render(false, renderBody, { onSettled: () => { settled += 1; } })))
      .toContain("<p>Body</p>");
    expect(collapse.render(true, renderBody, { onSettled: () => { settled += 1; } })).toBe(nothing);
    expect(settled).toBe(2);
  });

  test("only accepts child expressions", () => {
    const elementPart: PartInfo = { type: PartType.ELEMENT };

    expect(() => new SpringCollapseDirective(elementPart))
      .toThrow("springCollapse must be used in a child expression");
  });
});
