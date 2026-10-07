/**
 * What the server asks of a node as a whole, rather than of one of its sessions or checkouts.
 */
import type { NodeHub } from "../state.js";
import { getNode } from "../node-store.js";
import { nodeRefusal } from "../errors.js";

/** The node checks that its new code builds before it answers. */
const RELOAD_TIMEOUT_MS = 30_000;

export class NodeNotFoundError extends Error {
  constructor(nodeId: string) {
    super(`Node not found: ${nodeId}`);
    this.name = "NodeNotFoundError";
  }
}

/** The node's refusal of a request, as it worded it. */
export class NodeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeRefusedError";
  }
}

/**
 * Asks node `nodeId` to reload (ADR-021) and resolves once the reload is scheduled, before it happens:
 * the node holds every run at its next pause point, restarts on its new code once nothing is in flight,
 * and the server resumes the runs when it reconnects. `force` cuts off what is still in flight at the
 * node's drain bound instead of cancelling the reload. Throws `NodeNotFoundError` for an unknown node,
 * `NodeRefusedError` when the node refuses (nothing would restart it, its new code does not build), and
 * the call's `RpcFailure` (`unavailable`) when it is not connected.
 */
export async function reloadNode(nodes: NodeHub, nodeId: string, { force = false }: { force?: boolean } = {}): Promise<{ scheduled: true }> {
  if (!getNode(nodeId)) throw new NodeNotFoundError(nodeId);
  try {
    return await nodes.get(nodeId).request("node.reload", { force }, { timeoutMs: RELOAD_TIMEOUT_MS });
  } catch (error) {
    const refusal = nodeRefusal(error);
    if (refusal) throw new NodeRefusedError(refusal.message);
    throw error;
  }
}
