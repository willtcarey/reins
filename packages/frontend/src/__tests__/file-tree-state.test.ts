/**
 * Tests for FileTreeState — shared UI state for collapsed directories
 * in the diff file tree.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { FileTreeState } from "../changes/file-tree-state.js";

describe("FileTreeState", () => {
  let state: FileTreeState;

  beforeEach(() => {
    state = new FileTreeState();
  });

  test("initial state has no collapsed dirs", () => {
    expect(state.collapsedDirs.size).toBe(0);
  });

  test("toggleDir adds a directory to collapsed set", () => {
    state.toggleDir("src/components");
    expect(state.collapsedDirs.has("src/components")).toBe(true);
    expect(state.collapsedDirs.size).toBe(1);
  });

  test("toggleDir twice removes the directory", () => {
    state.toggleDir("src/components");
    state.toggleDir("src/components");
    expect(state.collapsedDirs.has("src/components")).toBe(false);
    expect(state.collapsedDirs.size).toBe(0);
  });

  test("multiple directories can be collapsed independently", () => {
    state.toggleDir("src");
    state.toggleDir("lib");
    state.toggleDir("test");
    expect(state.collapsedDirs.size).toBe(3);
    expect(state.collapsedDirs.has("src")).toBe(true);
    expect(state.collapsedDirs.has("lib")).toBe(true);
    expect(state.collapsedDirs.has("test")).toBe(true);

    // toggling one doesn't affect others
    state.toggleDir("lib");
    expect(state.collapsedDirs.size).toBe(2);
    expect(state.collapsedDirs.has("src")).toBe(true);
    expect(state.collapsedDirs.has("lib")).toBe(false);
    expect(state.collapsedDirs.has("test")).toBe(true);
  });

  test("reset clears all collapsed directories", () => {
    state.toggleDir("src");
    state.toggleDir("lib");
    expect(state.collapsedDirs.size).toBe(2);

    state.reset();
    expect(state.collapsedDirs.size).toBe(0);
  });

  test("reset on already-empty state is a no-op", () => {
    expect(state.collapsedDirs.size).toBe(0);
    state.reset(); // should not throw
    expect(state.collapsedDirs.size).toBe(0);
  });

  test("subscribe receives notifications on toggleDir", () => {
    const listener = mock(() => {});
    state.subscribe(listener);

    state.toggleDir("src");
    expect(listener).toHaveBeenCalledTimes(1);

    state.toggleDir("lib");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("subscribe receives notifications on reset", () => {
    const listener = mock(() => {});
    state.subscribe(listener);

    state.toggleDir("src");
    expect(listener).toHaveBeenCalledTimes(1);

    state.reset();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("unsubscribe function stops notifications", () => {
    const listener = mock(() => {});
    const unsub = state.subscribe(listener);

    state.toggleDir("src");
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();

    state.toggleDir("lib");
    expect(listener).toHaveBeenCalledTimes(1); // no additional call
  });

  test("multiple listeners all get notified", () => {
    const listener1 = mock(() => {});
    const listener2 = mock(() => {});
    const listener3 = mock(() => {});

    state.subscribe(listener1);
    state.subscribe(listener2);
    state.subscribe(listener3);

    state.toggleDir("src");
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener3).toHaveBeenCalledTimes(1);
  });

  test("removing one listener doesn't affect others", () => {
    const listener1 = mock(() => {});
    const listener2 = mock(() => {});

    state.subscribe(listener1);
    const unsub2 = state.subscribe(listener2);

    state.toggleDir("src");
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);

    unsub2();

    state.toggleDir("lib");
    expect(listener1).toHaveBeenCalledTimes(2);
    expect(listener2).toHaveBeenCalledTimes(1); // stopped receiving
  });

  test("collapsedDirs is a new Set instance after toggleDir", () => {
    const before = state.collapsedDirs;
    state.toggleDir("src");
    const after = state.collapsedDirs;
    expect(before).not.toBe(after);
  });

  test("collapsedDirs is a new Set instance after reset", () => {
    state.toggleDir("src");
    const before = state.collapsedDirs;
    state.reset();
    const after = state.collapsedDirs;
    expect(before).not.toBe(after);
  });
});
