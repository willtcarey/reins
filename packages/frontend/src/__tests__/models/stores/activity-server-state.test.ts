import { describe, expect, mock, test } from "bun:test";
import { ActivityStore } from "../../../models/stores/activity-store.js";

describe("ActivityStore server state sync", () => {
  test("applyServerState sets 'running'", () => {
    const store = new ActivityStore();

    store.applyServerState("s1", "running");

    expect(store.getActivity("s1")).toBe("running");
  });

  test("applyServerState sets 'finished'", () => {
    const store = new ActivityStore();

    store.applyServerState("s1", "finished");

    expect(store.getActivity("s1")).toBe("finished");
  });

  test("applyServerState clears on null", () => {
    const store = new ActivityStore();
    store.setRunning("s1");

    store.applyServerState("s1", null);

    expect(store.getActivity("s1")).toBeUndefined();
  });

  test("applyServerState is a no-op when state matches", () => {
    const store = new ActivityStore();
    let callCount = 0;
    store.subscribe(() => { callCount++; });

    store.setRunning("s1");
    const countAfterSet = callCount;

    store.applyServerState("s1", "running");
    expect(callCount).toBe(countAfterSet);
  });

  test("applyServerState notifies when state changes", () => {
    const store = new ActivityStore();
    const listener = mock(() => {});
    store.subscribe(listener);

    store.applyServerState("s1", "running");
    expect(listener).toHaveBeenCalledTimes(1);

    store.applyServerState("s1", "finished");
    expect(listener).toHaveBeenCalledTimes(2);

    store.applyServerState("s1", null);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  test("applyServerState overrides local state from broadcast", () => {
    const store = new ActivityStore();
    store.setRunning("s1");

    // Server says it's finished (agent_end happened while disconnected)
    store.applyServerState("s1", "finished");

    expect(store.getActivity("s1")).toBe("finished");
  });
});
