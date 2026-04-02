import { describe, test, expect } from "bun:test";
import { openInBrowserEvent } from "../components/events.js";

describe("openInBrowserEvent", () => {
  test("creates event with path only", () => {
    const event = openInBrowserEvent("src/index.ts");
    expect(event.detail).toEqual({ path: "src/index.ts" });
    expect(event.detail.startLine).toBeUndefined();
    expect(event.detail.endLine).toBeUndefined();
    expect(event.bubbles).toBe(true);
    expect(event.composed).toBe(true);
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
});
