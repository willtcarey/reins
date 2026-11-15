import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useTestDb } from "../../helpers/test-db.js";
import { makeRequest } from "../../helpers/request.js";
import { createAppState, type TestAppState } from "../../helpers/app-state.js";
import { persistCanonicalMessages } from "../../helpers/canonical-messages.js";
import { createProject } from "../../project-fixture.js";
import { createSession, updateActivityState, updateSessionMetadata } from "../../session-fixture.js";
import { createTask, setTaskStatus } from "../../../task-store.js";
import { getDb } from "../../../app-globals.js";
import { buildRouter } from "../../../routes/index.js";
import type { Static } from "@sinclair/typebox";
import type { launcherSessionsApi } from "../../../extensions/launcher-sessions/api.js";

const router = buildRouter();
const setUpdated = (id: string, at: string) => getDb().query("UPDATE sessions SET updated_at = ? WHERE id = ?").run(at, id);

describe("the Launcher's sessions extension", () => {
  useTestDb();
  let state: TestAppState;
  let projectId: number;
  beforeEach(() => {
    state = createAppState();
    projectId = createProject("Api", "/tmp/api").id;
  });
  afterEach(async () => { await state.nodes.close(); });

  const list = async () => {
    const res = (await router.handle(makeRequest("POST", "/api/extensions/launcher-sessions/list"), state))!;
    expect(res.status).toBe(200);
    const rows: Static<typeof launcherSessionsApi.list.output> = await res.json();
    return rows;
  };
  /** A session of the project with a first message, so it can be listed. */
  const talked = (id: string, options: { taskId?: number; parentSessionId?: string; background?: boolean; projectId?: number } = {}) => {
    createSession(id, options.projectId ?? projectId, { agentRuntimeType: "pi", ...options });
    persistCanonicalMessages(id, [{ role: "user", content: [{ type: "text", text: `About ${id}` }] }]);
  };

  test("lists each open task's sessions and each project's latest session of no task, with its name, project, task and first message", async () => {
    const task = createTask(projectId, "Dark mode", null, "task/dark-mode");
    const other = createProject("Web", "/tmp/web").id;
    talked("on-task", { taskId: task.id });
    talked("older-scratch");
    talked("scratch");
    talked("web-scratch", { projectId: other });
    setUpdated("older-scratch", "2026-01-01T00:00:00.000Z");
    setUpdated("scratch", "2026-01-02T00:00:00.000Z");
    setUpdated("web-scratch", "2026-01-03T00:00:00.000Z");
    setUpdated("on-task", "2026-01-04T00:00:00.000Z");
    updateActivityState("scratch", "finished");
    updateSessionMetadata("scratch", { name: "Triage" });
    setUpdated("scratch", "2026-01-02T00:00:00.000Z");

    expect(await list()).toEqual([
      { id: "on-task", name: null, project: "Api", task: "Dark mode", firstMessage: "About on-task", updatedAt: "2026-01-04T00:00:00.000Z", activity: null },
      { id: "web-scratch", name: null, project: "Web", task: null, firstMessage: "About web-scratch", updatedAt: "2026-01-03T00:00:00.000Z", activity: null },
      { id: "scratch", name: "Triage", project: "Api", task: null, firstMessage: "About scratch", updatedAt: "2026-01-02T00:00:00.000Z", activity: "unread" },
    ]);
  });

  test("leaves out closed tasks' sessions, sub-sessions, archived and background sessions, and sessions with no messages", async () => {
    const open = createTask(projectId, "Open", null, "task/open");
    const closed = createTask(projectId, "Closed", null, "task/closed");
    setTaskStatus(closed.id, "closed");
    talked("open", { taskId: open.id });
    talked("closed", { taskId: closed.id });
    talked("child", { taskId: open.id, parentSessionId: "open" });
    talked("archived", { taskId: open.id });
    updateSessionMetadata("archived", { archived: true });
    talked("background", { taskId: open.id, background: true });
    createSession("empty", projectId, { agentRuntimeType: "pi", taskId: open.id });

    expect((await list()).map(({ id }) => id)).toEqual(["open"]);
  });

  test("takes a pinned assistant conversation as the project's latest, and lists pinned sessions first", async () => {
    const task = createTask(projectId, "Task", null, "task/t");
    talked("pinned-scratch");
    talked("newer-scratch");
    talked("on-task", { taskId: task.id });
    setUpdated("pinned-scratch", "2026-01-01T00:00:00.000Z");
    setUpdated("newer-scratch", "2026-01-02T00:00:00.000Z");
    setUpdated("on-task", "2026-01-03T00:00:00.000Z");
    updateSessionMetadata("pinned-scratch", { pinned: true });
    setUpdated("pinned-scratch", "2026-01-01T00:00:00.000Z");

    expect((await list()).map(({ id }) => id)).toEqual(["pinned-scratch", "on-task"]);
  });

  test("an assistant conversation whose latest session is a sub-session's parent is still the parent", async () => {
    talked("parent");
    talked("child", { parentSessionId: "parent" });
    setUpdated("parent", "2026-01-01T00:00:00.000Z");
    setUpdated("child", "2026-01-02T00:00:00.000Z");

    expect((await list()).map(({ id }) => id)).toEqual(["parent"]);
  });

  test("strips leading skill blocks from the first message", async () => {
    createSession("skill", projectId, { agentRuntimeType: "pi" });
    persistCanonicalMessages("skill", [{ role: "user", content: [{ type: "text", text: `<skill name="dip" location="/p/SKILL.md">body</skill>\n\n/dip start the server` }] }]);

    expect((await list())[0]?.firstMessage).toBe("/dip start the server");
  });
});
