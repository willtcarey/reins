import { afterEach, describe, expect, test } from "bun:test";
import { makeProject, makeSessionListItem, makeTask } from "../helpers/fixtures.js";
import { mockFetch, restoreFetch } from "../helpers/mock-fetch.js";
import type { ProjectsChange, SessionsChange, TasksChange } from "@reins/sdk";
import { testSdk } from "../helpers/reins-sdk.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(restoreFetch);

describe("reins.sessions: live lists", () => {
  test("a session finishing is told once, with its project, and lists then have it unread", async () => {
    const { reins, client, sessions } = testSdk();
    sessions.setMany([makeSessionListItem("work", { activityState: "running" })]);
    await settle();
    mockFetch((url) => url === "/api/sessions/work"
      ? json({ ...makeSessionListItem("work", { activityState: "finished", updatedAt: "2026-01-02T00:00:00.000Z" }), background: false, pendingOperation: null, state: { model: null, thinkingLevel: "high" } })
      : json([]));
    const heard: SessionsChange[] = [];
    reins.sessions.onDidChange((change) => heard.push(change));

    client.fireMessage({ type: "session_updated", sessionId: "work", projectId: 1 });
    await settle();

    expect(heard).toEqual([{ sessionIds: ["work"], projectIds: [1] }]);
    expect(reins.sessions.list().map(({ id, activity, updatedAt }) => ({ id, activity, updatedAt }))).toEqual([
      { id: "work", activity: "unread", updatedAt: "2026-01-02T00:00:00.000Z" },
    ]);
  });

  test("tells nothing for a change lists do not show, and both projects for a session that moved", async () => {
    const { reins, sessions } = testSdk();
    sessions.setMany([makeSessionListItem("work")]);
    await settle();
    const heard: SessionsChange[] = [];
    reins.sessions.onDidChange((change) => heard.push(change));

    sessions.set("work", { state: { model: null, thinkingLevel: "low" }, pendingOperation: { kind: "run" } });
    await settle();
    sessions.set("work", { projectId: 2 });
    await settle();

    expect(heard).toEqual([{ sessionIds: ["work"], projectIds: [1, 2] }]);
  });

  test("lists a project's or a task's sessions, pinned first then the latest, never archived ones unless asked", () => {
    const { reins, sessions } = testSdk();
    mockFetch(() => json([]));
    sessions.setMany([
      makeSessionListItem("older", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeSessionListItem("newer", { updatedAt: "2026-01-03T00:00:00.000Z" }),
      makeSessionListItem("pinned", { pinnedAt: "2026-01-01T00:00:00.000Z" }),
      makeSessionListItem("archived", { archivedAt: "2026-01-04T00:00:00.000Z" }),
      makeSessionListItem("on-task", { taskId: 5 }),
      makeSessionListItem("elsewhere", { projectId: 2 }),
    ]);

    expect(reins.sessions.list({ projectId: 1, taskId: null }).map(({ id }) => id)).toEqual(["pinned", "newer", "older"]);
    expect(reins.sessions.list({ projectId: 1, taskId: 5 }).map(({ id }) => id)).toEqual(["on-task"]);
    expect(reins.sessions.list({ projectId: 1, taskId: null, archived: true }).map(({ id }) => id)).toContain("archived");
  });

  test("naming a task loads its sessions once", async () => {
    const { reins } = testSdk();
    const requests: string[] = [];
    mockFetch((url) => {
      requests.push(url);
      return json(url === "/api/tasks/5/sessions" ? [makeSessionListItem("on-task", { taskId: 5 })] : []);
    });

    reins.sessions.list({ projectId: 1, taskId: 5 });
    reins.sessions.list({ projectId: 1, taskId: 5 });
    await settle();

    expect(requests).toEqual(["/api/tasks/5/sessions"]);
    expect(reins.sessions.list({ projectId: 1, taskId: 5 }).map(({ id }) => id)).toEqual(["on-task"]);
  });

  test("tells a project's tasks starting to load and loaded, and changing in a project not loaded", async () => {
    const { reins, client, projectsStore } = testSdk();
    projectsStore.projects = [makeProject(1, "Api")];
    mockFetch((url) => json(url === "/api/projects/1/tasks?status=open" ? [makeTask({ id: 5, title: "Sidebar" })] : []));
    const heard: TasksChange[] = [];
    reins.tasks.onDidChange((change) => heard.push(change));

    reins.tasks.list(1);
    await settle();
    await settle();
    client.fireMessage({ type: "task_updated", projectId: 9 });
    await settle();

    expect(heard).toEqual([{ projectIds: [1] }, { projectIds: [1] }, { projectIds: [9] }]);
  });

});

describe("reins.sessions: actions", () => {
  test("marking a session read shows at once, and is sent to the server", async () => {
    const { reins, sessions } = testSdk();
    sessions.setMany([makeSessionListItem("done", { activityState: "finished" })]);
    const writes: string[] = [];
    mockFetch((url, init) => {
      writes.push(`${init?.method} ${url} ${init?.body}`);
      return json({ ok: true });
    });

    const marking = reins.sessions.setUnread("done", false);
    const shownAtOnce = reins.sessions.list().find(({ id }) => id === "done")?.activity;
    await marking;

    expect(shownAtOnce).toBeNull();
    expect(writes).toEqual(['PATCH /api/sessions/done/activity {"unread":false}']);
  });

  test("acting on a session no list loaded reads its details first", async () => {
    const { reins } = testSdk();
    const requests: string[] = [];
    mockFetch((url, init) => {
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/sessions/far") {
        return json({ ...makeSessionListItem("far", { projectId: 7, activityState: "finished" }), background: false, pendingOperation: null, state: { model: null, thinkingLevel: "high" } });
      }
      return json({ ok: true });
    });

    await reins.sessions.setUnread("far", false);

    expect(requests).toEqual(["GET /api/sessions/far", "PATCH /api/sessions/far/activity"]);
  });

  test("pinning, archiving and naming send the session's metadata; a refusal rejects and puts it back", async () => {
    const { reins, sessions } = testSdk();
    sessions.setMany([makeSessionListItem("plan")]);
    const writes: string[] = [];
    mockFetch((url, init) => {
      writes.push(`${init?.method} ${url} ${init?.body}`);
      if (String(init?.body).includes("archived")) return json({ error: "Database is locked" }, 500);
      return json({ ...makeSessionListItem("plan"), name: "Plan", pinnedAt: "2026-01-05T00:00:00.000Z" });
    });

    await reins.sessions.setPinned("plan", true);
    await reins.sessions.setName("plan", "Plan");
    await expect(reins.sessions.setArchived("plan", true)).rejects.toThrow("HTTP 500");

    expect(writes).toEqual([
      'PATCH /api/sessions/plan/metadata {"pinned":true}',
      'PATCH /api/sessions/plan/metadata {"name":"Plan"}',
      'PATCH /api/sessions/plan/metadata {"archived":true}',
    ]);
    expect(reins.sessions.list({ projectId: 1, taskId: null }).map(({ id, name, pinned, archived }) => ({ id, name, pinned, archived }))).toEqual([
      { id: "plan", name: "Plan", pinned: true, archived: false },
    ]);
  });
});

describe("reins.projects and reins.tasks", () => {
  test("lists projects by name with their sessions' activity", () => {
    const { reins, projectsStore, sessions } = testSdk();
    projectsStore.projects = [makeProject(2, "web"), makeProject(1, "Api")];
    sessions.setMany([makeSessionListItem("busy", { projectId: 2, activityState: "running" })]);

    expect(reins.projects.list().map(({ id, name, activity }) => ({ id, name, activity }))).toEqual([
      { id: 1, name: "Api", activity: null },
      { id: 2, name: "web", activity: "running" },
    ]);
  });

  test("tells only the projects whose row changed: one whose session starts running", async () => {
    const { reins, projectsStore, sessions } = testSdk();
    projectsStore.projects = [makeProject(1, "Api"), makeProject(2, "web")];
    const heard: ProjectsChange[] = [];
    reins.projects.onDidChange((change) => heard.push(change));

    sessions.setMany([makeSessionListItem("busy", { projectId: 2, activityState: "running" })]);
    await settle();

    expect(heard).toEqual([{ projectIds: [2] }]);
  });

  test("a project's tasks load the first time they are asked for", async () => {
    const { reins } = testSdk();
    mockFetch((url) => json(url === "/api/projects/1/tasks?status=open" ? [makeTask({ id: 5, title: "Sidebar", branch_name: "task/sidebar" })] : []));

    expect(reins.tasks.list(1)).toEqual([]);
    expect(reins.tasks.loaded(1)).toBe(false);
    await settle();

    expect(reins.tasks.loaded(1)).toBe(true);
    expect(reins.tasks.list(1).map(({ id, title, branchName, closed }) => ({ id, title, branchName, closed }))).toEqual([
      { id: 5, title: "Sidebar", branchName: "task/sidebar", closed: false },
    ]);
  });
});
