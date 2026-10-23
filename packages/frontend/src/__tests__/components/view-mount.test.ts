import { describe, expect, test } from "bun:test";
import { ViewMount } from "../../components/view-mount.js";
import type { View, ViewPresentation } from "../../reins-sdk/contract.js";
import { setConnected, testDom, testElement } from "../helpers/test-dom.js";

const source = { nodeId: "node", path: "/work" };

/** A presentation that draws a marker element and records its lifecycle; `update` only when asked. */
function recordingPresentation({ updates = true } = {}) {
  const events: unknown[] = [];
  const drawn: HTMLElement[] = [];
  const presentation: ViewPresentation<View, object> = {
    mount(target, view, context) {
      events.push(["mount", view, context]);
      const element = testElement();
      drawn.push(element);
      target.append(element);
      return {
        update: updates ? (shown, shownFor) => { events.push(["update", shown, shownFor]); } : undefined,
        dispose: () => { events.push(["dispose"]); },
      };
    },
  };
  return { presentation, events, drawn };
}

/** A view mount holding fallback content, with a view to show. */
function viewMount(presentation: ViewPresentation<View, object>) {
  const element = testDom(new ViewMount());
  const fallback = testElement();
  element.append(fallback);
  element.presentation = presentation;
  element.view = { view: "file", source, path: "README.md" };
  element.context = { source };
  return { element, fallback };
}

describe("ViewMount", () => {
  test("mounts its view into itself in place of its fallback once it is on the page", async () => {
    const { presentation, events, drawn } = recordingPresentation();
    const { element } = viewMount(presentation);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);

    setConnected(element, true);
    await element.updateComplete;

    expect(events).toEqual([["mount", { view: "file", source, path: "README.md" }, { source }]]);
    expect([...element.childNodes]).toEqual(drawn);
  });

  test("updates its view with a new view or context, set together", async () => {
    const { presentation, events } = recordingPresentation();
    const { element } = viewMount(presentation);
    setConnected(element, true);
    await element.updateComplete;

    const view = { view: "file" as const, source, path: "README.md", startLine: 3 };
    const context = { source: { ...source } };
    element.view = view;
    element.context = context;
    await element.updateComplete;

    expect(events.slice(1)).toEqual([["update", view, context]]);
  });

  test("mounts a view without update again for a new view", async () => {
    const { presentation, events, drawn } = recordingPresentation({ updates: false });
    const { element } = viewMount(presentation);
    setConnected(element, true);
    await element.updateComplete;

    element.view = { view: "file", source, path: "docs/TODO.md" };
    await element.updateComplete;

    expect(events.slice(1)).toEqual([["dispose"], ["mount", { view: "file", source, path: "docs/TODO.md" }, { source }]]);
    expect([...element.childNodes]).toEqual([drawn[1]]);
  });

  test("disposes its view and shows its fallback when it leaves the page, and mounts it again once back", async () => {
    const { presentation, events } = recordingPresentation();
    const { element, fallback } = viewMount(presentation);
    setConnected(element, true);
    await element.updateComplete;

    setConnected(element, false);
    expect(events.slice(1)).toEqual([["dispose"]]);
    expect([...element.childNodes]).toEqual([fallback]);

    setConnected(element, true);
    setConnected(element, false);
    setConnected(element, true);
    await element.updateComplete;
    expect(events.slice(2)).toEqual([["mount", { view: "file", source, path: "README.md" }, { source }]]);
  });
});
