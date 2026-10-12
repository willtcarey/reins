/**
 * Node API function definitions.
 */

import { Type } from "@sinclair/typebox";
import { getSource } from "../node-store.js";
import type { NodeView } from "../models/node.js";
import { type ApiContext, type ApiFunctionDef, defineFunction } from "./define-function.js";

export const NodeSourceSchema = Type.Object({
  sourceId: Type.Number(),
  projectId: Type.Number(),
  projectName: Type.String(),
  path: Type.String({ description: "The source's absolute path on the node." }),
});

const nodeFields = {
  id: Type.String(),
  name: Type.String(),
  hostname: Type.Union([Type.String(), Type.Null()], { description: "The machine's hostname, as it said when it paired; null for a node never paired (the local one)." }),
  connected: Type.Boolean({ description: "Whether the node is connected now." }),
  revoked: Type.Boolean({ description: "Whether the node was revoked: it may not connect." }),
  current: Type.Boolean({ description: "Whether the calling session runs its tools on this node." }),
  sourceCount: Type.Number({ description: "How many projects' sources (checkouts) are on the node; nodes.get lists them." }),
};

export const NodeSchema = Type.Object(nodeFields);

export const NodeDetailSchema = Type.Object({
  ...nodeFields,
  sources: Type.Array(NodeSourceSchema, { description: "The projects' sources (checkouts) on the node, by path." }),
});

/** The calling session's node. */
const callerNodeId = (ctx: ApiContext) => getSource(ctx.sourceId)?.node_id;

const nodeSummary = (node: NodeView, ctx: ApiContext) => ({
  id: node.id,
  name: node.name,
  hostname: node.hostname,
  connected: node.connected,
  revoked: node.revokedAt !== null,
  current: node.id === callerNodeId(ctx),
  sourceCount: node.sources.length,
});

export const nodesListFunction = defineFunction({
  name: "nodes.list",
  description:
    "List the nodes (machines that run sessions' tools: files and commands), in name order: whether each is " +
    "connected, whether it is the calling session's, and how many sources it holds (nodes.get lists them). " +
    "Removed nodes are not listed.",
  parameters: Type.Object({}),
  returns: Type.Array(NodeSchema),
  tags: ["nodes", "node", "list", "machines", "hosts", "read"],
  execute: (_params, ctx) => ctx.models.nodes.list().map(node => nodeSummary(node, ctx)),
});

export const nodesGetFunction = defineFunction({
  name: "nodes.get",
  description:
    "Get a node (by default, the calling session's) with the projects' sources on it: each source's project and " +
    "its path on the node. Throws for an unknown or removed node.",
  parameters: Type.Object({
    nodeId: Type.Optional(Type.String({ description: "The node; by default, the calling session's node." })),
  }),
  returns: NodeDetailSchema,
  tags: ["nodes", "node", "get", "sources", "checkouts", "paths", "read"],
  execute: (params, ctx) => {
    const nodeId = params.nodeId ?? callerNodeId(ctx);
    if (!nodeId) throw new Error("The calling session has no node");
    const model = ctx.models.nodes.get(nodeId);
    if (model.removed) throw new Error(`Node removed: ${nodeId}`);
    const node = model.view();
    return {
      ...nodeSummary(node, ctx),
      sources: node.sources.map(source => ({ sourceId: source.project.sourceId, projectId: source.project.id, projectName: source.project.name, path: source.path })),
    };
  },
});

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
    return { nodeId, ...await ctx.models.nodes.get(nodeId).reload({ force: params.force ?? false }) };
  },
});

export const NODE_FUNCTIONS: ApiFunctionDef[] = [nodesListFunction, nodesGetFunction, nodesReloadFunction];
