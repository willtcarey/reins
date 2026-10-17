import { describe, test, expect } from "bun:test";
import { getDb } from "../../db.js";
import { createProject } from "../project-fixture.js";
import { createSession, getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { createAppState } from "../helpers/app-state.js";
import { useFakeModel } from "../helpers/fake-model.js";
import { until } from "../helpers/session-host.js";
import { Sessions } from "../../models/sessions.js";
import { activeSessionIds, sessionActivity } from "../../models/session-activity.js";
import { buildRouter } from "../../routes/index.js";
import { runSettled, runStarted, type SessionSettled } from "../../sessions/session-runs.js";
import { makeRequest } from "../helpers/request.js";

useTestDb();
const model = useFakeModel();

const settled = (sessionId: string, runId: string): SessionSettled => ({
  sessionId, runId, source: "pi", status: "completed", metadata: { model: null, thinkingLevel: null }, tipId: null,
});

describe("sessionActivity / activeSessionIds", () => {
  test("follows the started report and settlement; health reflects it", async () => {
    const project = createProject("Activity", "/tmp/node-activity");
    createSession("node", project.id, { agentRuntimeType: "pi" });
    const state = createAppState();
    const activity = () => sessionActivity(getSession("node")!, state.process.sessions);
    const health = async () => (await buildRouter().handle(makeRequest("GET", "/api/health"), state))!.json();
    const nodes = [{ id: "internal", name: "Internal", connected: false }];

    expect(activity()).toBe("idle");
    expect(await health()).toEqual({ status: "ok", activeSessions: 0, streaming: false, nodes });

    runStarted(state.process, "node", "run-1");
    expect(activity()).toBe("running");
    expect(activeSessionIds(state.process.sessions)).toEqual(["node"]);
    expect(await health()).toEqual({ status: "ok", activeSessions: 1, streaming: true, nodes });

    await runSettled(state.process, settled("node", "run-1"));
    expect(activity()).toBe("idle");
    expect(activeSessionIds(state.process.sessions)).toEqual([]);
    expect(await health()).toEqual({ status: "ok", activeSessions: 0, streaming: false, nodes });
  });

  test("a submission is running from its arrival, before its run reports started, until the run settles", async () => {
    // A scratch session of a utility kind: no checkout, so no node is needed.
    const project = createProject("Activity", "/tmp/node-activity");
    const state = createAppState();
    createSession("utility", project.id, { agentRuntimeType: "pi", kind: "task-generator", modelProvider: model.model.provider, modelId: model.model.modelId });
    const activity = () => sessionActivity(getSession("utility")!, state.process.sessions);
    const submitted = new Sessions(state, () => {}).submit("utility", { op: "prompt", content: [{ type: "text", text: "Work" }], clientId: "c" });
    expect(getSession("utility")?.activity_state).toBeNull();
    expect(activity()).toBe("running");
    expect(activeSessionIds(state.process.sessions)).toEqual(["utility"]);
    await submitted;
    expect(activity()).toBe("running");
    (await model.nextTurn("utility")).finish();
    await until(() => activity() === "idle", "the run settled");
    expect(getSession("utility")?.activity_state).toBe("finished");
  });

  test("session views keep running state and hide pending operations while active; reading activity writes nothing", () => {
    const project = createProject("Activity views", "/tmp/node-activity-views");
    createSession("node", project.id, { agentRuntimeType: "pi" });
    const state = createAppState();
    runStarted(state.process, "node", "run-1");
    const before = getSession("node");
    const changes = () => getDb().query<{ n: number }, []>("SELECT total_changes() n").get()!.n;
    const written = changes();
    const sessions = new Sessions(state, () => {});
    // No live runtime: durable running state is not reconciled away.
    expect(sessions.activeSessions()).toEqual([{ id: "node", projectId: project.id, taskId: null, activityState: "running" }]);
    expect(sessions.getDetail("node")?.pendingOperation).toBeNull();
    expect(sessionActivity(before!, state.process.sessions)).toBe("running");
    expect(activeSessionIds(state.process.sessions)).toEqual(["node"]);
    expect(changes()).toBe(written);
    expect(getSession("node")).toEqual(before);
  });
});
