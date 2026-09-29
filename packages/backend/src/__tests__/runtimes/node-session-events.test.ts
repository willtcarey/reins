import { expect, test } from "bun:test";
import { createNodeConnection, protocolVersion } from "@reins/node-protocol";
import { scriptedCommandHandlers } from "@reins/node-protocol/testing";
import { getDb } from "../../db.js";
import { latestNodeSettlement } from "../../node-replica.js";
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

    expect(latestNodeSettlement(getDb(), "cut")).toMatchObject({ status: "failed", error: { message: expect.stringContaining("The run was interrupted") } });
    expect(getSession("cut")?.activity_state).not.toBe("running");
    // The settled run is the one the node started (Pi may resume it under that ID later).
    expect(getDb().query("SELECT report_run_id, report_kind FROM node_session_watermarks WHERE session_id = 'cut'").get()).toEqual({ report_run_id: "cut-run", report_kind: "settled" });
    // A run the node still has, and a run on another node, keep running; an idle session is untouched.
    expect([getSession("live")?.activity_state, getSession("elsewhere")?.activity_state]).toEqual(["running", "running"]);
    expect([latestNodeSettlement(getDb(), "live"), latestNodeSettlement(getDb(), "elsewhere"), latestNodeSettlement(getDb(), "idle")]).toEqual([null, null, null]);
    expect(getSession("idle")?.activity_state).toBeNull();
  } finally { link.stop(); state.nodes.close(); }
});
