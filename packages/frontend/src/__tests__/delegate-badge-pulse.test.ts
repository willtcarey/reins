/**
 * Tests for delegate badge pulsing logic.
 *
 * The +N badge on sessions with delegate sub-sessions should pulse
 * (animate) when any child delegate session is in "running" state.
 */
import { describe, test, expect } from "bun:test";
import type { SessionListItem } from "../models/ws-client.js";

/** Pure helper extracted from delegate-popover: determines if any child is running. */
function hasRunningChild(children: SessionListItem[]): boolean {
  return children.some(c => c.activityState === "running");
}

function makeSession(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "s-" + Math.random().toString(36).slice(2, 8),
    projectId: 42,
    taskId: null,
    parentSessionId: null,
    name: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 0,
    firstMessage: null,
    activityState: null,
    ...overrides,
  };
}

describe("delegate badge pulse", () => {
  test("returns false when no children have activity", () => {
    const children = [makeSession({ id: "child-1" }), makeSession({ id: "child-2" })];
    expect(hasRunningChild(children)).toBe(false);
  });

  test("returns false when children are finished but not running", () => {
    const children = [
      makeSession({ id: "child-1", activityState: "finished" }),
      makeSession({ id: "child-2", activityState: "finished" }),
    ];
    expect(hasRunningChild(children)).toBe(false);
  });

  test("returns true when at least one child is running", () => {
    const children = [
      makeSession({ id: "child-1", activityState: "finished" }),
      makeSession({ id: "child-2", activityState: "running" }),
    ];
    expect(hasRunningChild(children)).toBe(true);
  });

  test("returns true when all children are running", () => {
    const children = [
      makeSession({ id: "child-1", activityState: "running" }),
      makeSession({ id: "child-2", activityState: "running" }),
    ];
    expect(hasRunningChild(children)).toBe(true);
  });

  test("returns false for empty children array", () => {
    expect(hasRunningChild([])).toBe(false);
  });
});
