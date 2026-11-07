import { expect, test } from "bun:test";
import { QuickOpenStore } from "../../../models/stores/quick-open-store.js";
import { SessionCache } from "../../../models/stores/session-cache.js";
import { shownNewSession, shownSession, testSdk } from "../../helpers/reins-sdk.js";

test("records a visit to each session the main area comes to be about, from any view of it", () => {
  const { reins, showMain } = testSdk();
  const store = new QuickOpenStore(new SessionCache());
  store.recentIds = [];
  const dispose = store.followWorkspace(reins.workspace);

  showMain(shownSession("s1"));
  // An extension's view about a session is a visit too.
  showMain({ view: { view: "timeline", sessionId: "s2" }, subject: [{ type: "session", id: "s2" }] });
  showMain(shownNewSession(1));
  showMain(shownSession("s1"));

  expect(store.recentIds).toEqual(["s1", "s2"]);
  dispose();
  showMain(shownSession("s3"));
  expect(store.recentIds).toEqual(["s1", "s2"]);
  store.dispose();
});

test("does not record the shown session again while only what else the view is about changes", () => {
  const { reins, showMain, source } = testSdk();
  const store = new QuickOpenStore(new SessionCache());
  store.recentIds = [];
  store.followWorkspace(reins.workspace);
  showMain(shownSession("s1"));
  // Opened from the palette, so it is the latest though the main area still shows s1.
  store.recordVisit("s2");

  showMain({ view: { view: "session-changes", sessionId: "s1" }, subject: [{ type: "file", id: { source, path: "a.ts" } }, { type: "session", id: "s1" }] });

  expect(store.recentIds).toEqual(["s2", "s1"]);
  store.dispose();
});
