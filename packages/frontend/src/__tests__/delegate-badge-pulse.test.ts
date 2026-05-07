/**
 * Tests for delegate badge pulsing logic.
 *
 * The +N badge on sessions with delegate sub-sessions should pulse
 * (animate) when any child delegate session is in "running" state.
 */
import { describe, test, expect } from "bun:test";
import type { ActivityState } from "../models/stores/activity-store.js";
import type { SessionListItem } from "../models/ws-client.js";

/** Pure helper extracted from task-list: determines if any child is running. */
function hasRunningChild(
  children: SessionListItem[],
  activityMap: Map<string, ActivityState>,
): boolean {
  return children.some(c => activityMap.get(c.id) === "running");
}

function makeSession(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: "s-" + Math.random().toString(36).slice(2, 8),
    name: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    message_count: 0,
    first_message: null,
    parent_session_id: null,
    ...overrides,
  };
}

describe("delegate badge pulse", () => {
  test("returns false when no children have activity", () => {
    const children = [makeSession({ id: "child-1" }), makeSession({ id: "child-2" })];
    const activityMap = new Map<string, ActivityState>();
    expect(hasRunningChild(children, activityMap)).toBe(false);
  });

  test("returns false when children are finished but not running", () => {
    const children = [makeSession({ id: "child-1" }), makeSession({ id: "child-2" })];
    const activityMap = new Map<string, ActivityState>([
      ["child-1", "finished"],
      ["child-2", "finished"],
    ]);
    expect(hasRunningChild(children, activityMap)).toBe(false);
  });

  test("returns true when at least one child is running", () => {
    const children = [makeSession({ id: "child-1" }), makeSession({ id: "child-2" })];
    const activityMap = new Map<string, ActivityState>([
      ["child-1", "finished"],
      ["child-2", "running"],
    ]);
    expect(hasRunningChild(children, activityMap)).toBe(true);
  });

  test("returns true when all children are running", () => {
    const children = [makeSession({ id: "child-1" }), makeSession({ id: "child-2" })];
    const activityMap = new Map<string, ActivityState>([
      ["child-1", "running"],
      ["child-2", "running"],
    ]);
    expect(hasRunningChild(children, activityMap)).toBe(true);
  });

  test("returns false for empty children array", () => {
    const activityMap = new Map<string, ActivityState>([["other", "running"]]);
    expect(hasRunningChild([], activityMap)).toBe(false);
  });
});
