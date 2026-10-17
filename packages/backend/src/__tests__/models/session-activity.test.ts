import { describe, test, expect } from "bun:test";
import { getDb } from "../../db.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState, stubRuntime } from "../helpers/app-state.js";
import { useFakeModel } from "../helpers/fake-model.js";
import { until } from "../helpers/session-host.js";
import { Sessions } from "../../models/sessions.js";
import { activeSessionIds, sessionActivity } from "../../models/session-activity.js";
import { buildRouter } from "../../routes/index.js";
import { makeRequest } from "../helpers/request.js";

useTestDb();
const model = useFakeModel();

describe("sessionActivity / activeSessionIds", () => {
  test("a submission is running from its arrival until its run's end is applied; health and the row reflect it, and browsers hear each change", async () => {
    // A scratch session of a utility kind: no checkout, so no node is needed.
    const project = createProject("Activity", "/tmp/node-activity");
    const state = createAppState();
    createSession("utility", project.id, { agentRuntimeType: "pi", kind: "task-generator", modelProvider: model.model.provider, modelId: model.model.modelId });
    const activity = () => sessionActivity(getSession("utility")!, state.process.sessions);
    const health = async () => (await buildRouter().handle(makeRequest("GET", "/api/health"), state))!.json();
    // What a browser fetching the session on each `session_updated` would see.
    const seen: unknown[] = [];
    state.process.clients.add({ ws: { send: frame => {
      const message = JSON.parse(frame);
      if (message.type === "session_updated" && message.sessionId === "utility") seen.push(getSession("utility")!.activity_state);
      return 0;
    } } });
    expect(activity()).toBe("idle");
    expect(await health()).toMatchObject({ activeSessions: 0, streaming: false });

    const submitted = new Sessions(state, () => {}).submit("utility", { op: "prompt", content: [{ type: "text", text: "Work" }], clientId: "c" });
    expect(activity()).toBe("running");
    expect(getSession("utility")?.activity_state).toBe("running");
    expect(activeSessionIds(state.process.sessions)).toEqual(["utility"]);
    expect(await health()).toMatchObject({ activeSessions: 1, streaming: true });
    await submitted;
    expect(activity()).toBe("running");
    (await model.nextTurn("utility")).finish();
    await until(() => activity() === "idle", "the run's end was applied");
    expect(getSession("utility")?.activity_state).toBe("finished");
    expect(activeSessionIds(state.process.sessions)).toEqual([]);
    expect(await health()).toMatchObject({ activeSessions: 0, streaming: false });
    expect(seen[0]).toBe("running");
    expect(seen.at(-1)).toBe("finished");
    // Nothing durable says it ran.
    expect(getDb().query("SELECT activity_state FROM sessions WHERE id = 'utility'").get()).toEqual({ activity_state: "finished" });
  });

  test("session views keep running state and hide pending operations while active; reading activity writes nothing", () => {
    const project = createProject("Activity views", "/tmp/node-activity-views");
    createSession("node", project.id, { agentRuntimeType: "pi" });
    const state = createAppState();
    stubRuntime(state.process, "node");
    const before = getSession("node");
    const changes = () => getDb().query<{ n: number }, []>("SELECT total_changes() n").get()!.n;
    const written = changes();
    const sessions = new Sessions(state, () => {});
    expect(sessions.activeSessions()).toEqual([{ id: "node", projectId: project.id, taskId: null, activityState: "running" }]);
    expect(sessions.getDetail("node")?.pendingOperation).toBeNull();
    expect(sessionActivity(before!, state.process.sessions)).toBe("running");
    expect(activeSessionIds(state.process.sessions)).toEqual(["node"]);
    expect(changes()).toBe(written);
    expect(getSession("node")).toEqual(before);
  });
});
