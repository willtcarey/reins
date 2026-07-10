import { describe, test, expect } from "bun:test";
import {
  openFileBrowserEvent,
  openInBrowserEvent,
  paneSelectEvent,
  reloadRequestEvent,
} from "../../components/events.js";

function expectBubblingComposed(event: Event) {
  expect(event.bubbles).toBe(true);
  expect(event.composed).toBe(true);
}

describe("openInBrowserEvent", () => {
  test("creates event with path only", () => {
    const event = openInBrowserEvent("src/index.ts");
    expect(event.detail).toEqual({ path: "src/index.ts" });
    expect(event.detail.startLine).toBeUndefined();
    expect(event.detail.endLine).toBeUndefined();
    expectBubblingComposed(event);
  });

  test("creates event with path and line range", () => {
    const event = openInBrowserEvent("src/index.ts", { startLine: 5, endLine: 10 });
    expect(event.detail).toEqual({ path: "src/index.ts", startLine: 5, endLine: 10 });
  });

  test("line range is spread into detail", () => {
    const event = openInBrowserEvent("a.ts", { startLine: 1, endLine: 1 });
    expect(event.detail.startLine).toBe(1);
    expect(event.detail.endLine).toBe(1);
  });

  test("can request the preview tab", () => {
    const event = openInBrowserEvent("index.html", { viewMode: "preview" });
    expect(event.detail).toEqual({ path: "index.html", viewMode: "preview" });
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
    const event = openFileBrowserEvent();

    expect(event.type).toBe("open-file-browser");
    expectBubblingComposed(event);
  });

  test("creates reload-request events", () => {
    const event = reloadRequestEvent();

    expect(event.type).toBe("reload-request");
    expectBubblingComposed(event);
  });
});
