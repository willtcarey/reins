import { describe, expect, spyOn, test } from "bun:test";
import { ViewMount } from "../../components/view-mount.js";
import type { View, ViewPresentation } from "@reins/sdk";
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

  test("mounts a presentation without a view, such as an extension's Settings page, and disposes it when it leaves", async () => {
    const events: string[] = [];
    const drawn = testElement();
    const element = testDom(new ViewMount());
    element.presentation = { mount: (target) => { events.push("mount"); target.append(drawn); return { dispose: () => { events.push("dispose"); } }; } };

    setConnected(element, true);
    await element.updateComplete;
    expect([...element.childNodes]).toEqual([drawn]);

    setConnected(element, false);
    expect(events).toEqual(["mount", "dispose"]);
    expect([...element.childNodes]).toEqual([]);
  });

  test("shows a failing mount's error in its place when it has no fallback", async () => {
    const element = testDom(new ViewMount());
    element.presentation = { mount: () => { throw new Error("No servers table"); } };

    setConnected(element, true);
    await element.updateComplete;

    expect([...element.childNodes].map((node) => node.textContent).join("")).toBe("Failed to load: No servers table");
  });

  test("keeps its fallback when its view fails to mount, so a message keeps its text", async () => {
    const { element, fallback } = viewMount({ mount: () => { throw new Error("No listing"); } });
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      setConnected(element, true);
      await element.updateComplete;

      expect([...element.childNodes]).toEqual([fallback]);
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  test("leaves the page even when its view's dispose throws", async () => {
    const { element, fallback } = viewMount({ mount: () => ({ dispose: () => { throw new Error("Already gone"); } }) });
    setConnected(element, true);
    await element.updateComplete;
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      expect(() => setConnected(element, false)).not.toThrow();
      expect([...element.childNodes]).toEqual([fallback]);
    } finally {
      logged.mockRestore();
    }
  });

  test("tells a mounted view when it is hidden and shown again, and one mounted hidden at once", async () => {
    const told: unknown[] = [];
    const presentation: ViewPresentation<View, object> = {
      mount: () => ({ setVisible: (visible) => { told.push(visible); } }),
    };
    const shown = viewMount(presentation).element;
    const hidden = viewMount(presentation).element;
    hidden.visible = false;
    setConnected(shown, true);
    setConnected(hidden, true);
    await shown.updateComplete;
    await hidden.updateComplete;
    expect(told).toEqual([false]);

    shown.visible = false;
    await shown.updateComplete;
    hidden.visible = true;
    await hidden.updateComplete;

    expect(told).toEqual([false, false, true]);
  });
});
