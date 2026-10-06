import { describe, test, expect } from "bun:test";
import type { SessionSettled } from "@reins/node-protocol";
import { getDb } from "../../db.js";
import { createProject } from "../project-fixture.js";
import { getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { createServerState } from "../helpers/server-state.js";
import { Sessions } from "../../models/sessions.js";
import { activeSessionIds, sessionActivity } from "../../models/session-activity.js";
import { createBroadcast } from "../../models/broadcast.js";
import { claimCommand, deleteFailedCommand, settleCommand } from "../../node-link/node-command-store.js";
import { buildRouter } from "../../routes/index.js";
import { sessionRuns } from "../../sessions/session-runs.js";
import type { ServerState } from "../../state.js";
import { admitInput, createNodeSession, queuePrompt } from "../helpers/node-session.js";
import { makeRequest } from "../helpers/request.js";

useTestDb();

const runsFor = (state: ServerState) => sessionRuns({ broadcast: createBroadcast(state.clients), nodes: state.nodes });
const settled = (sessionId: string, runId: string): SessionSettled => ({
  sessionId, runId, reportId: crypto.randomUUID(), status: "completed", metadata: { model: null, thinkingLevel: null }, tipId: null,
});

describe("sessionActivity / activeSessionIds (server projections only)", () => {
  test("follows queued input, the started report and settlement; health reflects it", async () => {
    const project = createProject("Activity", "/tmp/node-activity");
    createNodeSession("node", project.id);
    const state = createServerState();
    const runs = runsFor(state);
    const activity = () => sessionActivity(getSession("node")!);
    const health = async () => (await buildRouter().handle(makeRequest("GET", "/api/health"), state))!.json();
    const nodes = [{ id: "internal", name: "Internal", connected: false }];

    // A session with no run and no pending input is idle.
    expect(activity()).toBe("idle");
    expect(await health()).toEqual({ status: "ok", activeSessions: 0, streaming: false, nodes });

    // A queued prompt counts as active before any run started.
    const command = queuePrompt("node", "client-1");
    expect(activity()).toBe("queued");
    expect(activeSessionIds()).toEqual(["node"]);
    expect(await health()).toEqual({ status: "ok", activeSessions: 1, streaming: true, nodes });

    // Admitted and started: running from the durable report.
    admitInput(command, "client-1");
    runs.runStarted("node", "run-1");
    expect(activity()).toBe("running");
    expect(await health()).toEqual({ status: "ok", activeSessions: 1, streaming: true, nodes });

    runs.runSettled(settled("node", "run-1"));
    expect(activity()).toBe("idle");
    expect(activeSessionIds()).toEqual([]);
    expect(await health()).toEqual({ status: "ok", activeSessions: 0, streaming: false, nodes });
  });

  test("a failed input is not pending work", () => {
    const project = createProject("Activity failure", "/tmp/node-activity-failure");
    createNodeSession("node", project.id);
    const command = queuePrompt("node", "client-1");
    claimCommand(command);
    expect(sessionActivity(getSession("node")!)).toBe("queued");
    settleCommand(command, "failed", JSON.stringify({ ok: false, error: { code: "invalid_request", message: "rejected", retryable: false } }));
    expect(sessionActivity(getSession("node")!)).toBe("idle");
    deleteFailedCommand(command);
    expect(sessionActivity(getSession("node")!)).toBe("idle");
  });

  test("session views keep running state and hide pending operations while active; reading activity writes nothing", () => {
    const project = createProject("Activity views", "/tmp/node-activity-views");
    createNodeSession("node", project.id);
    const state = createServerState();
    runsFor(state).runStarted("node", "run-1");
    const before = getSession("node");
    const changes = () => getDb().query<{ n: number }, []>("SELECT total_changes() n").get()!.n;
    const written = changes();
    const sessions = new Sessions(state.nodes);
    // No live runtime exists on the server: durable running state is not reconciled away.
    expect(sessions.activeSessions()).toEqual([{ id: "node", projectId: project.id, taskId: null, activityState: "running" }]);
    expect(sessions.get("node")?.pendingOperation).toBeNull();
    expect(sessionActivity(before!)).toBe("running");
    expect(activeSessionIds()).toEqual(["node"]);
    expect(changes()).toBe(written);
    expect(getSession("node")).toEqual(before);
  });
});
