/**
 * Node Routes
 *
 *   GET /api/nodes — every node, in name order, with whether it is connected now
 */

import type { RouterGroup } from "../router.js";
import { API } from "../api-paths.js";
import { listNodes, type NodeInfo } from "../node-store.js";

export type NodeView = NodeInfo & { connected: boolean };

export function registerNodeRoutes(router: RouterGroup) {
  router.get(API.nodes, async (ctx) => {
    return Response.json(listNodes().map((node): NodeView => ({ ...node, connected: ctx.state.nodes.get(node.id).connected })));
  });
}
