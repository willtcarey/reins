import { describe, test, expect } from "bun:test";
import {
  openFileBrowserEvent,
  openFileSearchEvent,
  openInBrowserEvent,
  paneSelectEvent,
  reloadRequestEvent,
} from "../../components/events.js";

function expectBubblingComposed(event: Event) {
  expect(event.bubbles).toBe(true);
  expect(event.composed).toBe(true);
}

describe("openInBrowserEvent", () => {
  test("creates an explicitly project-scoped file location", () => {
    const event = openInBrowserEvent(42, "src/index.ts");
    expect(event.detail).toEqual({ projectId: 42, path: "src/index.ts" });
    expect(event.detail.startLine).toBeUndefined();
    expect(event.detail.endLine).toBeUndefined();
    expectBubblingComposed(event);
  });

  test("creates event with path and line range", () => {
    const event = openInBrowserEvent(42, "src/index.ts", { startLine: 5, endLine: 10 });
    expect(event.detail).toEqual({ projectId: 42, path: "src/index.ts", startLine: 5, endLine: 10 });
  });

  test("line range is spread into detail", () => {
    const event = openInBrowserEvent(42, "a.ts", { startLine: 1, endLine: 1 });
    expect(event.detail.startLine).toBe(1);
    expect(event.detail.endLine).toBe(1);
  });

  test("can request the preview tab", () => {
    const event = openInBrowserEvent(42, "index.html", { viewMode: "preview" });
    expect(event.detail).toEqual({ projectId: 42, path: "index.html", viewMode: "preview" });
  });
});

describe("toolbar event factories", () => {
  test("creates pane-select events", () => {
    const event = paneSelectEvent("sessions");

    expect(event.type).toBe("pane-select");
    expect(event.detail).toEqual({ pane: "sessions" });
    expectBubblingComposed(event);
  });

  test("creates open-file-browser events", () => {
    const event = openFileBrowserEvent(42);

    expect(event.type).toBe("open-file-browser");
    expect(event.detail).toEqual({ projectId: 42 });
    expectBubblingComposed(event);
  });

  test("creates project-scoped open-file-search events", () => {
    const event = openFileSearchEvent(42);

    expect(event.type).toBe("open-file-search");
    expect(event.detail).toEqual({ projectId: 42 });
    expectBubblingComposed(event);
  });

  test("creates reload-request events", () => {
    const event = reloadRequestEvent();

    expect(event.type).toBe("reload-request");
    expectBubblingComposed(event);
  });
});
