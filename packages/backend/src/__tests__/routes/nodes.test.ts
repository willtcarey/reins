import { describe, test, expect } from "bun:test";
import { APPLICATION_ERROR, RpcFailure, type NodeError } from "@reins/node-protocol";
import { buildRouter } from "../../routes/index.js";
import { makeRequest } from "../helpers/request.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";
import { connectScriptedNode, SEEDED_NODE_ID } from "../helpers/loopback-node.js";

describe("POST /api/nodes/:nodeId/reload", () => {
  useTestDb();
  const router = buildRouter();

  test("asks the node to reload and answers once it is scheduled; force is passed on, and a body is optional", async () => {
    const state = createServerState();
    const requests: unknown[] = [];
    const link = connectScriptedNode(state, SEEDED_NODE_ID, { reload: async input => { requests.push(input); return { scheduled: true }; } });
    try {
      await link.ready();
      const forced = await router.handle(makeRequest("POST", `/api/nodes/${SEEDED_NODE_ID}/reload`, { force: true }), state);
      expect(forced!.status).toBe(200);
      expect(await forced!.json()).toEqual({ scheduled: true });
      const plain = await router.handle(makeRequest("POST", `/api/nodes/${SEEDED_NODE_ID}/reload`), state);
      expect(plain!.status).toBe(200);
      expect(requests).toEqual([{ force: true }, { force: false }]);
    } finally { link.stop(); state.nodes.close(); }
  });

  test("answers 409 with the node's refusal, 503 when the node is not connected and 404 for an unknown node", async () => {
    const state = createServerState();
    const offline = await router.handle(makeRequest("POST", `/api/nodes/${SEEDED_NODE_ID}/reload`), state);
    expect(offline!.status).toBe(503);
    expect(await router.handle(makeRequest("POST", "/api/nodes/nowhere/reload"), state).then(res => res!.status)).toBe(404);

    const refusal = "The node's new code does not build: Unexpected token";
    const link = connectScriptedNode(state, SEEDED_NODE_ID, { reload: async () => {
      throw new RpcFailure(APPLICATION_ERROR, refusal, undefined, { code: "invalid_request", message: refusal, retryable: false } satisfies NodeError);
    } });
    try {
      await link.ready();
      const refused = await router.handle(makeRequest("POST", `/api/nodes/${SEEDED_NODE_ID}/reload`), state);
      expect(refused!.status).toBe(409);
      expect(await refused!.json()).toEqual({ error: refusal });
    } finally { link.stop(); state.nodes.close(); }
  });
});
