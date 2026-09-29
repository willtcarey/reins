import { expect, test } from "bun:test";
import { createNodeConnection, protocolVersion } from "@reins/node-protocol";
import { scriptedCommandHandlers } from "@reins/node-protocol/testing";
import { getDb } from "../../db.js";
import { latestSettlement, runInProgress } from "../../session-runs.js";
import { createSource, defaultSource } from "../../node-store.js";
import { createProject } from "../../project-store.js";
import { createSession, getSession } from "../../session-store.js";
import { nodeSessionReports } from "../../runtimes/node-session-events.js";
import { dialLoopback, SEEDED_NODE_ID } from "../helpers/loopback-node.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();

test("a node's hello settles as interrupted every run the server sees running on it that the node does not list as live", async () => {
  const state = createServerState();
  const project = createProject("Interrupted", "/tmp/interrupted");
  getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
  const local = defaultSource(project.id)!.id;
  const remote = createSource(project.id, "remote", "/tmp/interrupted-remote").id;
  const reports = nodeSessionReports(state);
  for (const [id, sourceId] of [["cut", local], ["live", local], ["elsewhere", remote]] as const) {
    createSession(id, project.id, { agentRuntimeType: "pi", sourceId });
    reports.started({ sessionId: id, runId: `${id}-run` });
  }
  createSession("idle", project.id, { agentRuntimeType: "pi", sourceId: local });

  const link = dialLoopback(state, socket => createNodeConnection(socket, {
    nodeId: SEEDED_NODE_ID, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], liveSessions: ["live"],
    maxFrameBytes: Infinity, ...scriptedCommandHandlers({}),
  }), { redial: false });
  try {
    await link.ready();
    for (let i = 0; i < 200 && !state.nodes.connected(SEEDED_NODE_ID); i++) await Bun.sleep(5);

    expect(latestSettlement("cut")).toMatchObject({ status: "failed", error: { message: expect.stringContaining("The run was interrupted") } });
    expect(getSession("cut")?.activity_state).not.toBe("running");
    // The run is no longer in progress: Pi may resume it under its ID later, and that start applies.
    expect(runInProgress("cut")).toBeNull();
    // A run the node still has, and a run on another node, keep running; an idle session is untouched.
    expect([getSession("live")?.activity_state, getSession("elsewhere")?.activity_state]).toEqual(["running", "running"]);
    expect([latestSettlement("live"), latestSettlement("elsewhere"), latestSettlement("idle")]).toEqual([null, null, null]);
    expect(getSession("idle")?.activity_state).toBeNull();
  } finally { link.stop(); state.nodes.close(); }
});

test("a repeated start of the run in progress applies nothing; a resumed run settles again, with or without a new start", () => {
  const state = createServerState();
  const project = createProject("Lifecycle", "/tmp/lifecycle");
  const sourceId = defaultSource(project.id)!.id;
  createSession("parent", project.id, { agentRuntimeType: "pi", sourceId });
  createSession("child", project.id, { agentRuntimeType: "pi", sourceId, parentSessionId: "parent" });
  const steers = () => getDb().query<{ n: number }, []>("SELECT COUNT(*) n FROM node_command_outbox WHERE session_id = 'parent' AND json_extract(command_json, '$.op') = 'session.steer'").get()!.n;
  const settled = { sessionId: "child", runId: "r1", status: "completed" as const, metadata: { model: null, thinkingLevel: null },
    reply: { text: "Done", stopReason: "stop", errorMessage: null } };
  const reports = nodeSessionReports(state);
  try {
    reports.started({ sessionId: "child", runId: "r1" });
    const started = getSession("child")!.updated_at;
    // Pi reports `started` again for a run in progress (in-run compaction): already applied.
    reports.started({ sessionId: "child", runId: "r1" });
    expect(getSession("child")).toMatchObject({ activity_state: "running", updated_at: started });
    expect(runInProgress("child")).toBe("r1");
    reports.settled(settled);
    expect(steers()).toBe(1);
    expect(getSession("child")?.activity_state).toBeNull();
    expect(latestSettlement("child")).toEqual({ seq: 1, nextSeq: 1, status: "completed" });

    // Pi resumes the settled run (after it was settled as interrupted): it runs and settles again.
    reports.started({ sessionId: "child", runId: "r1" });
    expect(getSession("child")?.activity_state).toBe("running");
    reports.settled({ ...settled, reply: { text: "Done again", stopReason: "stop", errorMessage: null } });
    expect(steers()).toBe(2);
    // A resumed run may settle without reporting a new start.
    reports.settled({ ...settled, status: "failed", error: { message: "failed on resume" }, reply: null });
    expect(latestSettlement("child")).toMatchObject({ seq: 3, status: "failed", error: { message: "failed on resume" } });
  } finally { state.nodes.close(); }
});
