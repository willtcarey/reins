import { describe, expect, test } from "bun:test";
import { activeNodeSessionIds, nodeSessionActivity } from "../../models/node-session-activity.js";
import { Sessions } from "../../models/sessions.js";
import { createProject } from "../../project-store.js";
import { buildRouter } from "../../routes/index.js";
import { nodeSessionReports } from "../../runtimes/node-session-events.js";
import { claimCommand, settleCommand, deleteFailedCommand } from "../../node-command-store.js";
import { getSession } from "../session-fixture.js";
import { useTestDb } from "../helpers/test-db.js";
import { getDb } from "../../db.js";
import { createServerState } from "../helpers/server-state.js";
import { makeRequest } from "../helpers/request.js";
import { admitInput, createNodeSession, queuePrompt } from "../helpers/node-session.js";

const settledReport = { runId: "run-1", status: "completed" as const, metadata: { model: null, thinkingLevel: null }, reply: null };

describe("node session activity (server projections only)", () => {
  useTestDb();

  test("follows queued input, the durable started report and settlement; health reflects it", async () => {
    const project = createProject("Activity", "/tmp/node-activity");
    createNodeSession("node", project.id);
    const state = createServerState();
    const reports = nodeSessionReports(state);
    const activity = () => nodeSessionActivity(getSession("node")!);
    const health = async () => (await buildRouter().handle(makeRequest("GET", "/api/health"), state))!.json();

    // A session with no run and no pending input is idle.
    expect(activity()).toBe("idle");
    expect(await health()).toEqual({ status: "ok", activeSessions: 0, streaming: false, nodes: [{ id: "internal", name: "Internal", connected: false }] });

    // A queued prompt counts as active before any run started.
    const command = queuePrompt("node", "client-1");
    expect(activity()).toBe("queued");
    expect(activeNodeSessionIds()).toEqual(["node"]);
    expect(await health()).toEqual({ status: "ok", activeSessions: 1, streaming: true, nodes: [{ id: "internal", name: "Internal", connected: false }] });

    // Admitted and started: running from the durable report.
    admitInput(command, "client-1");
    reports.started({ sessionId: "node", runId: "run-1" });
    expect(activity()).toBe("running");
    expect(await health()).toEqual({ status: "ok", activeSessions: 1, streaming: true, nodes: [{ id: "internal", name: "Internal", connected: false }] });

    reports.settled({ sessionId: "node", ...settledReport });
    expect(activity()).toBe("idle");
    expect(activeNodeSessionIds()).toEqual([]);
    expect(await health()).toEqual({ status: "ok", activeSessions: 0, streaming: false, nodes: [{ id: "internal", name: "Internal", connected: false }] });
  });

  test("a failed input is not pending work", () => {
    const project = createProject("Activity failure", "/tmp/node-activity-failure");
    createNodeSession("node", project.id);
    const command = queuePrompt("node", "client-1");
    claimCommand(command);
    expect(nodeSessionActivity(getSession("node")!)).toBe("queued");
    settleCommand(command, "failed", JSON.stringify({ ok: false, error: { code: "invalid_request", message: "rejected", retryable: false } }));
    expect(nodeSessionActivity(getSession("node")!)).toBe("idle");
    deleteFailedCommand(command);
    expect(nodeSessionActivity(getSession("node")!)).toBe("idle");
  });

  test("session views keep node running state and hide pending operations while active, without a node runtime", () => {
    const project = createProject("Activity views", "/tmp/node-activity-views");
    createNodeSession("node", project.id);
    const state = createServerState();
    nodeSessionReports(state).started({ sessionId: "node", runId: "run-1" });
    const sessions = new Sessions(state.nodes);
    // No live runtime exists on the server: durable running state is not reconciled away.
    expect(sessions.activeSessions()).toContainEqual(expect.objectContaining({ id: "node", activityState: "running" }));
    expect(getSession("node")!.activity_state).toBe("running");
    expect(sessions.get("node")?.pendingOperation).toBeNull();
  });
  test("reading activity writes nothing: it is the durable column and pending input, wherever the session is", () => {
    const project = createProject("Activity reads", "/tmp/node-activity-reads");
    createNodeSession("node", project.id);
    const state = createServerState();
    nodeSessionReports(state).started({ sessionId: "node", runId: "run-1" });
    const before = getSession("node");
    const changes = () => getDb().query<{ n: number }, []>("SELECT total_changes() n").get()!.n;
    const written = changes();
    expect(new Sessions(state.nodes).activeSessions()).toEqual([{ id: "node", projectId: project.id, taskId: null, activityState: "running" }]);
    expect(nodeSessionActivity(before!)).toBe("running");
    expect(activeNodeSessionIds()).toEqual(["node"]);
    expect(changes()).toBe(written);
    expect(getSession("node")).toEqual(before);
  });
});
