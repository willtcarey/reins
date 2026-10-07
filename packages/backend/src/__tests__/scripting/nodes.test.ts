import { describe, test, expect } from "bun:test";
import { APPLICATION_ERROR, RpcFailure, type NodeError } from "@reins/node-protocol";
import { getDb } from "../../db.js";
import { createSource, defaultSource } from "../../node-store.js";
import { nodesReloadFunction } from "../../scripting/nodes.js";
import type { ApiContext } from "../../scripting/define-function.js";
import { createProject } from "../project-fixture.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { connectScriptedNode, SEEDED_NODE_ID } from "../helpers/loopback-node.js";

describe("nodes.reload", () => {
  useTestDb();

  test("reloads the calling session's node by default, or the named one, and returns once the reload is scheduled; a refusal is the script's error", async () => {
    const state = createServerState();
    const project = createProject("Reload", "/tmp/reload-script");
    getDb().exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
    const remoteSource = createSource(project.id, "remote", "/tmp/reload-remote").id;
    const requests: Array<{ nodeId: string; force?: boolean }> = [];
    const local = connectScriptedNode(state, SEEDED_NODE_ID, { reload: async input => { requests.push({ nodeId: SEEDED_NODE_ID, ...input }); return { scheduled: true }; } });
    const refusal = "Nothing would restart this node (it is not supervised): restart it to load new code";
    const remote = connectScriptedNode(state, "remote", { reload: async () => {
      throw new RpcFailure(APPLICATION_ERROR, refusal, undefined, { code: "unavailable", message: refusal, retryable: false } satisfies NodeError);
    } });
    const ctx = (sourceId: number): ApiContext => ({ projectId: project.id, sessionId: "caller", taskId: null, broadcast: () => {}, sourceId, nodes: state.nodes });
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
