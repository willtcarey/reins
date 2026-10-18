import { describe, test, expect } from "bun:test";
import { NodeRejection } from "@reins/node-protocol";
import { getDb } from "../../app-globals.js";
import { createSource, defaultSource } from "../../node-store.js";
import { nodesGetFunction, nodesListFunction, nodesReloadFunction } from "../../scripting/nodes.js";
import type { ApiContext } from "../../scripting/define-function.js";
import { Models } from "../../models/models.js";
import { createProject } from "../project-fixture.js";
import { createAppState } from "../helpers/app-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { connectScriptedNode, SEEDED_NODE_ID } from "../helpers/loopback-node.js";

describe("nodes.list and nodes.get", () => {
  useTestDb();

  test("lists every node not removed, whether it is connected and the caller's, and how many sources it holds; get lists a node's sources", async () => {
    const state = createAppState();
    const project = createProject("Listed", "/tmp/list-local");
    getDb().exec(`INSERT INTO nodes (id, name, hostname, revoked_at) VALUES ('box', 'Box', 'box.lan', NULL), ('gone', 'Gone', NULL, NULL), ('old', 'Old', NULL, '2026-10-01T00:00:00Z');
      UPDATE nodes SET removed_at = '2026-10-02T00:00:00Z' WHERE id = 'gone'`);
    const boxSource = createSource(project.id, "box", "/srv/work").id;
    const box = connectScriptedNode(state, "box", {});
    const ctx: ApiContext = { projectId: project.id, sessionId: "caller", taskId: null, broadcast: () => {}, sourceId: boxSource, nodes: state.nodes, models: new Models(state) };
    try {
      await box.ready();
      const boxView = { id: "box", name: "Box", hostname: "box.lan", connected: true, revoked: false, current: true, sourceCount: 1 };
      const localView = { id: SEEDED_NODE_ID, name: "Internal", hostname: null, connected: false, revoked: false, current: false, sourceCount: 1 };
      expect(nodesListFunction.execute({}, ctx)).toEqual([
        boxView,
        localView,
        { id: "old", name: "Old", hostname: null, connected: false, revoked: true, current: false, sourceCount: 0 },
      ]);
      expect(nodesGetFunction.execute({}, ctx)).toEqual({ ...boxView, sources: [{ sourceId: boxSource, projectId: project.id, projectName: "Listed", path: "/srv/work" }] });
      expect(nodesGetFunction.execute({ nodeId: SEEDED_NODE_ID }, ctx)).toEqual({
        ...localView, sources: [{ sourceId: defaultSource(project.id)!.id, projectId: project.id, projectName: "Listed", path: "/tmp/list-local" }],
      });
      expect(() => nodesGetFunction.execute({ nodeId: "gone" }, ctx)).toThrow("Node removed: gone");
      expect(() => nodesGetFunction.execute({ nodeId: "nowhere" }, ctx)).toThrow("Node not found: nowhere");
    } finally { box.stop(); state.nodes.close(); }
  });
});

describe("nodes.reload", () => {
  useTestDb();

  test("reloads the calling session's node by default, or the named one, and returns once the reload is scheduled; a refusal is the script's error", async () => {
    const state = createAppState();
    const project = createProject("Reload", "/tmp/reload-script");
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
    const remoteSource = createSource(project.id, "remote", "/tmp/reload-remote").id;
    const requests: Array<{ nodeId: string; force?: boolean }> = [];
    const local = connectScriptedNode(state, SEEDED_NODE_ID, { reload: async input => { requests.push({ nodeId: SEEDED_NODE_ID, ...input }); return { scheduled: true }; } });
    const refusal = "Nothing would restart this node (it is not supervised): restart it to load new code";
    const remote = connectScriptedNode(state, "remote", { reload: async () => {
      throw new NodeRejection("unavailable", refusal);
    } });
    const ctx = (sourceId: number): ApiContext => ({ projectId: project.id, sessionId: "caller", taskId: null, broadcast: () => {}, sourceId, nodes: state.nodes, models: new Models(state) });
    try {
      await local.ready();
      await remote.ready();
      expect(await nodesReloadFunction.execute({}, ctx(defaultSource(project.id)!.id))).toEqual({ nodeId: SEEDED_NODE_ID, scheduled: true });
      expect(await nodesReloadFunction.execute({ nodeId: SEEDED_NODE_ID, force: true }, ctx(remoteSource))).toEqual({ nodeId: SEEDED_NODE_ID, scheduled: true });
      expect(requests).toEqual([{ nodeId: SEEDED_NODE_ID, force: false }, { nodeId: SEEDED_NODE_ID, force: true }]);
      await expect(nodesReloadFunction.execute({}, ctx(remoteSource))).rejects.toThrow(refusal);
    } finally { local.stop(); remote.stop(); state.nodes.close(); }
  });
});
