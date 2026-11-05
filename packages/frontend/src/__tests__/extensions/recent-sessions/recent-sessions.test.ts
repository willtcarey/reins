import { afterEach, describe, expect, test } from "bun:test";
import type { HttpOutput } from "@reins/sdk";
import type { RecentSessionsApi } from "@backend/extensions/recent-sessions/api.js";
import { RecentSessions, registerRecentSessions, rowActions } from "../../../extensions/recent-sessions/recent-sessions.js";
import { makeSessionListItem } from "../../helpers/fixtures.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testSdk } from "../../helpers/reins-sdk.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
type RecentSession = HttpOutput<RecentSessionsApi["list"]>[number];
const extension = { name: "recent-sessions", label: "Recent sessions" };

const row = (id: string, overrides: Partial<RecentSession> = {}): RecentSession => ({
  id, name: `Session ${id}`, firstMessage: null, project: "Api", task: null, updatedAt: "2026-01-01T00:00:00.000Z", activity: null, ...overrides,
});

afterEach(restoreFetch);

describe("Recent sessions", () => {
  test("shows what its backend part answers, and asks again once after sessions change", async () => {
    const sdk = testSdk<RecentSessionsApi>({ extension });
    const requests: string[] = [];
    let answer = [row("a"), row("b")];
    mockFetch((url, init) => {
      requests.push(`${init?.method} ${url} ${init?.body}`);
      return json(answer);
    });
    const recent = new RecentSessions(sdk.reins, 0);

    recent.start();
    await settle();
    const first = recent.rows.map(({ id }) => id);
    answer = [row("b", { activity: "unread" }), row("a")];
    sdk.sessions.setMany([makeSessionListItem("b", { activityState: "finished" })]);
    sdk.sessions.setMany([makeSessionListItem("c")]);
    await settle();
    await settle();
    recent.stop();

    expect(first).toEqual(["a", "b"]);
    expect(recent.rows.map(({ id, activity }) => ({ id, activity }))).toEqual([{ id: "b", activity: "unread" }, { id: "a", activity: null }]);
    expect(requests).toEqual(Array(2).fill('POST /api/extensions/recent-sessions/list {"limit":8}'));
  });

  test("a row's menu copies its ID, marks it read or unread unless it runs, renames it and archives it", () => {
    const { reins } = testSdk<RecentSessionsApi>({ extension });
    const renamed: string[] = [];
    const sdk = { ...reins, ui: { renameSession: async (sessionId: string) => { renamed.push(sessionId); return true; } } };
    const recent = new RecentSessions(sdk, 0);
    mockFetch(() => json([]));
    const actions = (activity: RecentSession["activity"]) => rowActions(sdk, recent, row("s1", { activity }));
    const labels = (activity: RecentSession["activity"]) => actions(activity).map(({ label }) => label);

    void actions(null).find(({ label }) => label === "Rename")?.run();

    expect(labels(null)).toEqual(["Copy session ID", "Mark as unread", "Rename", "Archive"]);
    expect(labels("unread")).toEqual(["Copy session ID", "Mark as read", "Rename", "Archive"]);
    expect(labels("running")).toEqual(["Copy session ID", "Rename", "Archive"]);
    expect(renamed).toEqual(["s1"]);
  });

  test("is the sidebar's Recent section", () => {
    const { reins, sidebar } = testSdk<RecentSessionsApi>({ extension });

    registerRecentSessions(reins);

    expect(sidebar.shown().map(({ id, title }) => ({ id, title }))).toEqual([{ id: "recent", title: "Recent" }]);
  });
});
