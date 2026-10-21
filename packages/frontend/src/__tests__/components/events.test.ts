import { describe, test, expect } from "bun:test";
import {
  openFileBrowserEvent,
  openFileSearchEvent,
  openInBrowserEvent,
  paneSelectEvent,
  reloadRequestEvent,
} from "../../components/events.js";

const source = { projectId: 42, nodeId: "node", path: "/work/project", available: true };

function expectBubblingComposed(event: Event) {
  expect(event.bubbles).toBe(true);
  expect(event.composed).toBe(true);
}

describe("openInBrowserEvent", () => {
  test("creates a file location in a project's source", () => {
    const event = openInBrowserEvent(source, "src/index.ts");
    expect(event.detail).toEqual({ source, path: "src/index.ts" });
    expect(event.detail.startLine).toBeUndefined();
    expect(event.detail.endLine).toBeUndefined();
    expectBubblingComposed(event);
  });

  test("creates event with path and line range", () => {
    const event = openInBrowserEvent(source, "src/index.ts", { startLine: 5, endLine: 10 });
    expect(event.detail).toEqual({ source, path: "src/index.ts", startLine: 5, endLine: 10 });
  });

  test("line range is spread into detail", () => {
    const event = openInBrowserEvent(source, "a.ts", { startLine: 1, endLine: 1 });
    expect(event.detail.startLine).toBe(1);
    expect(event.detail.endLine).toBe(1);
  });

  test("can request the preview tab", () => {
    const event = openInBrowserEvent(source, "index.html", { mode: "preview" });
    expect(event.detail).toEqual({ source, path: "index.html", mode: "preview" });
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
    const event = openFileBrowserEvent(source);

    expect(event.type).toBe("open-file-browser");
    expect(event.detail).toEqual({ source });
    expectBubblingComposed(event);
  });

  test("creates open-file-search events for a source", () => {
    const event = openFileSearchEvent(source);

    expect(event.type).toBe("open-file-search");
    expect(event.detail).toEqual({ source });
    expectBubblingComposed(event);
  });

  test("creates reload-request events", () => {
    const event = reloadRequestEvent();

    expect(event.type).toBe("reload-request");
    expectBubblingComposed(event);
  });
});
