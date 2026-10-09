/**
 * Node API function definitions.
 */

import { Type } from "@sinclair/typebox";
import { getSource } from "../node-store.js";
import { Nodes } from "../models/nodes.js";
import { type ApiFunctionDef, defineFunction } from "./define-function.js";

export const NodeReloadSchema = Type.Object({
  nodeId: Type.String({ description: "The node being reloaded." }),
  scheduled: Type.Literal(true, { description: "The reload is scheduled; it has not happened yet." }),
});

export const nodesReloadFunction = defineFunction({
  name: "nodes.reload",
  description:
    "Restart a node on its current code, to load node code you changed (packages/node). Returns as soon as the " +
    "reload is scheduled, before it happens: do not wait for it in the same script. The node holds every run, " +
    "including the calling session's, at its next model request or tool call, restarts once nothing is in flight " +
    "and the runs continue on the new code, so the caller's next request is the first to run on it. Fails at once " +
    "when the node's new code does not build or nothing would restart it. A long tool call elsewhere can hold the " +
    "reload up for up to 60 seconds; then it is cancelled, unless `force` cuts that call off.",
  parameters: Type.Object({
    nodeId: Type.Optional(Type.String({ description: "The node to reload; by default, the calling session's node." })),
    force: Type.Optional(Type.Boolean({ description: "At the 60 second bound, cut off calls still in flight instead of cancelling the reload." })),
  }),
  returns: NodeReloadSchema,
  async: true,
  tags: ["nodes", "node", "reload", "restart", "code", "deploy", "hot reload"],
  execute: async (params, ctx) => {
    const nodeId = params.nodeId ?? getSource(ctx.sourceId)?.node_id;
    if (!nodeId) throw new Error("The calling session has no node");
    return { nodeId, ...await new Nodes(ctx.nodes, ctx.broadcast).get(nodeId).reload({ force: params.force ?? false }) };
  },
});

export const NODE_FUNCTIONS: ApiFunctionDef[] = [nodesReloadFunction];
