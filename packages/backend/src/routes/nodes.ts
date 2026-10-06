/**
 * Node Routes
 *
 *   GET  /api/nodes                 — every node, in name order, with whether it is connected now
 *   POST /api/nodes/:nodeId/reload  — restart the node on its new code at a clean point ({force?}); answers
 *                                     once the reload is scheduled (409: the node refused; 503: offline)
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { listNodes, type NodeInfo } from "../node-store.js";
import { badRequest, conflict, notFound } from "../errors.js";
import { NodeNotFoundError, NodeRefusedError, reloadNode } from "../models/nodes.js";

export type NodeView = NodeInfo & { connected: boolean };

const ReloadBodySchema = Type.Object({ force: Type.Optional(Type.Boolean()) });

export function registerNodeRoutes(router: RouterGroup) {
  router.get(API.nodes, async (ctx) => {
    return Response.json(listNodes().map((node): NodeView => ({ ...node, connected: ctx.state.nodes.get(node.id).connected })));
  });

  router.post(`${API.nodes}/:nodeId/reload`, async (ctx) => {
    // The body is optional (`curl -X POST` works).
    const text = await ctx.req.text();
    let body: unknown = {};
    try { if (text.trim()) body = JSON.parse(text); } catch { badRequest("Invalid JSON in request body"); }
    if (!Value.Check(ReloadBodySchema, body)) badRequest("Invalid request body: expected {force?: boolean}");
    try {
      return Response.json(await reloadNode(ctx.state.nodes, ctx.params.nodeId, body));
    } catch (error) {
      if (error instanceof NodeNotFoundError) notFound(error.message);
      if (error instanceof NodeRefusedError) conflict(error.message);
      throw error;
    }
  });
}
