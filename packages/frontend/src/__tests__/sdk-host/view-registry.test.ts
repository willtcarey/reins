import { describe, expect, test } from "bun:test";
import { ViewRegistry } from "../../sdk-host/view-registry.js";

declare module "@reins/sdk" {
  interface ViewTypes {
    "test-timeline": { view: "test-timeline"; id: string };
    "test-board": { view: "test-board"; projectId: number };
    "test-alone": { view: "test-alone" };
  }
}

const pane = { title: () => "", description: () => "", icon: { mount: () => {} }, mount: () => {} };

describe("ViewRegistry.tabsFor", () => {
  test("gives a view's tabs, the views of every renderer that is a tab of its subject, for the same ID: the app's first, then extensions' in registration order", () => {
    const views = new ViewRegistry();
    views.register("test-timeline", { tabOf: { type: "session", parameter: "id" }, pane }, "timeline-extension");
    views.register("session", { tabOf: { type: "session", parameter: "sessionId" }, pane });
    views.register("session-changes", { tabOf: { type: "session", parameter: "sessionId" }, pane });
    views.register("test-board", { tabOf: { type: "project", parameter: "projectId" }, pane });

    const changes = { view: "session-changes", sessionId: "s1", focus: "README.md" };

    expect(views.tabsFor(changes)).toEqual([
      { view: "session", sessionId: "s1" },
      changes,
      { view: "test-timeline", id: "s1" },
    ]);
    expect(views.tabsFor(changes)[1]).toBe(changes);
  });

  test("gives a view that is no tab, or has no renderer yet, alone", () => {
    const views = new ViewRegistry();
    views.register("test-alone", { pane });
    const inbox = { view: "test-alone" };
    const unknown = { view: "unknown" };

    expect(views.tabsFor(inbox)).toEqual([inbox]);
    expect(views.tabsFor(unknown)).toEqual([unknown]);
  });
});
