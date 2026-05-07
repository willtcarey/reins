import { describe, expect, mock, test } from "bun:test";
import { ActivityStore } from "../../../models/stores/activity-store.js";

describe("ActivityStore", () => {
  test("setRunning stores project-scoped session activity", () => {
    const store = new ActivityStore();

    store.setRunning("s1");

    expect(store.getActivity("s1")).toBe("running");
    expect(store.activityMap).toEqual(new Map([["s1", "running"]]));
  });

  test("activityMap is cached until activity changes", () => {
    const store = new ActivityStore();
    store.setRunning("s1");

    const first = store.activityMap;
    expect(store.activityMap).toBe(first);

    store.setFinished("s1");

    expect(store.activityMap).not.toBe(first);
    expect(store.activityMap.get("s1")).toBe("finished");
  });

  test("setFinished clears suppressUnread sessions instead of marking unread", () => {
    const store = new ActivityStore();
    store.setRunning("s1");

    store.setFinished("s1", { suppressUnread: true });

    expect(store.getActivity("s1")).toBeUndefined();
  });

  test("setFinished clears delegate sessions instead of marking unread", () => {
    const store = new ActivityStore();
    store.trackDelegateSession("delegate-1");
    store.setRunning("delegate-1");

    store.setFinished("delegate-1");

    expect(store.getActivity("delegate-1")).toBeUndefined();
  });

  test("markSessionViewed clears only finished activity", () => {
    const store = new ActivityStore();
    store.setRunning("running");
    store.setRunning("finished");
    store.setFinished("finished");

    store.markSessionViewed("running");
    store.markSessionViewed("finished");

    expect(store.getActivity("running")).toBe("running");
    expect(store.getActivity("finished")).toBeUndefined();
  });

  test("clearActivity force-clears activity", () => {
    const store = new ActivityStore();
    store.setRunning("s1");

    store.clearActivity("s1");

    expect(store.getActivity("s1")).toBeUndefined();
  });

  test("clearSessions clears multiple sessions and delegate tracking", () => {
    const store = new ActivityStore();
    store.trackDelegateSession("delegate-1");
    store.setRunning("delegate-1");
    store.setRunning("s2");
    store.setRunning("kept");

    store.clearSessions(["delegate-1", "s2"]);
    store.setRunning("delegate-1");
    store.setFinished("delegate-1");

    expect(store.getActivity("delegate-1")).toBe("finished");
    expect(store.getActivity("s2")).toBeUndefined();
    expect(store.getActivity("kept")).toBe("running");
  });

  test("activitySummary and hasActivity reflect raw states", () => {
    const store = new ActivityStore();
    expect(store.hasActivity).toBe(false);

    store.setRunning("s1");
    store.setRunning("s2");
    store.setFinished("s2");

    expect(store.hasActivity).toBe(true);
    expect(store.activitySummary).toEqual({ running: 1, finished: 1 });
  });

  test("notifies subscribers when activity changes", () => {
    const store = new ActivityStore();
    const listener = mock(() => {});
    const unsubscribe = store.subscribe(listener);

    store.setRunning("s1");
    store.setRunning("s1");
    store.markSessionViewed("s1");
    store.setFinished("s1");
    store.clearActivity("s1");
    unsubscribe();
    store.setRunning("s2");

    expect(listener).toHaveBeenCalledTimes(3);
  });
});
