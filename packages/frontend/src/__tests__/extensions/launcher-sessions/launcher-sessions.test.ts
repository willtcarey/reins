import { afterEach, expect, test } from "bun:test";
import type { HttpOutput, LauncherItem } from "@reins/sdk";
import type { LauncherSessionsApi } from "@backend/extensions/launcher-sessions/api.js";
import { registerLauncherSessions } from "../../../extensions/launcher-sessions/launcher-sessions.js";
import { makeSessionListItem } from "../../helpers/fixtures.js";
import { mockFetch, restoreFetch } from "../../helpers/mock-fetch.js";
import { testSdk } from "../../helpers/reins-sdk.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
type Row = HttpOutput<LauncherSessionsApi["list"]>[number];
const extension = { name: "launcher-sessions", label: "Sessions in the Launcher" };
const row = (id: string, overrides: Partial<Row> = {}): Row => ({
  id, name: null, project: "Api", task: null, firstMessage: null, updatedAt: "2026-01-01T00:00:00.000Z", activity: null, ...overrides,
});

afterEach(restoreFetch);

async function items(rows: Row[]) {
  const sdk = testSdk<LauncherSessionsApi>({ extension });
  const requests: string[] = [];
  mockFetch((url, init) => {
    requests.push(`${init?.method} ${url}`);
    return json(rows);
  });
  registerLauncherSessions(sdk.reins);
  const [source] = sdk.launcher.providers();
  const given: readonly LauncherItem[] = await source!.provide({ current: null, session: null });
  return { ...sdk, given, requests };
}

test("gives an item for each session its backend part lists: a task's session by its task, with its project and first message", async () => {
  const { given, requests } = await items([row("s1", { task: "Dark mode", name: "Named", firstMessage: "Make the\nsidebar dark" })]);

  expect(requests).toEqual(["POST /api/extensions/launcher-sessions/list"]);
  expect(given.map(({ id, title, detail, status }) => ({ id, title, detail, status }))).toEqual([
    { id: "session:s1", title: "Dark mode", detail: "Api · Make the sidebar dark", status: undefined },
  ]);
});

test("titles a session of no task as the sidebar does: its name, else its first message, else Empty session", async () => {
  const { given } = await items([
    row("named", { name: "Triage", firstMessage: "Look at the failing builds" }),
    row("unnamed", { firstMessage: "Look at the\nfailing builds" }),
    row("empty"),
  ]);

  expect(given.map(({ title, detail }) => ({ title, detail }))).toEqual([
    { title: "Triage", detail: "Api · Look at the failing builds" },
    { title: "Look at the failing builds", detail: "Api" },
    { title: "Empty session", detail: "Api" },
  ]);
});

test("shows a running session as active and one with unread activity as needing attention, as the app knows them now", async () => {
  const sdk = await items([row("running", { activity: "running" }), row("unread", { activity: "unread" }), row("read-since", { activity: "unread" })]);
  // The app has seen the session read since its backend part answered.
  sdk.sessions.setMany([makeSessionListItem("read-since", { activityState: null })]);
  const again = await sdk.launcher.providers()[0]!.provide({ current: null, session: null });

  expect(again.map(({ status }) => status)).toEqual(["active", "attention", undefined]);
});

test("opens the session in the main area", async () => {
  const { given, shownViews } = await items([row("s1")]);

  await given[0]!.run();

  expect(shownViews).toEqual([{ view: "session", sessionId: "s1" }]);
});
