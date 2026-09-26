import type { Node } from "./node.js";
import { APPLICATION_ERROR, createNodeConnection, methods, protocolVersion, RpcFailure, type NodeError, type PeerOptions, type WireSocket } from "./protocol/connection.js";
import { MAX_ERROR_MESSAGE } from "./protocol/peer.js";

const rejection = (error: NodeError) => {
  const message = error.message.slice(0, MAX_ERROR_MESSAGE);
  return new RpcFailure(APPLICATION_ERROR, message, undefined, { ...error, message });
};

/** Node half of the wire protocol. Only provision is served; other ops still use `Node` directly.
 * Rejections and thrown errors are application errors whose data is the NodeResult error.
 * The connection serves the node's server calls from creation (calls await negotiation) until closed. */
export function connectNode(node: Node, socket: WireSocket, instanceId: string, options: PeerOptions = {}) {
  const connection = createNodeConnection(socket, {
    instanceId, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [methods.sessionProvision], ...options,
    async provision({ sessionId, commandId, binding, configuration }) {
      let result;
      // Rebuilt in the stored command's shape, so the receipt payload of a replay matches byte-for-byte.
      const command = { op: "session.provision" as const, sessionId, sourceId: binding.sourceId,
        configuration: { model: configuration.model, thinkingLevel: configuration.thinkingLevel, task: configuration.task } };
      try { result = await node.send(command, binding, commandId); }
      catch (error) { throw rejection({ code: "internal", message: error instanceof Error ? error.message : String(error), retryable: false }); }
      if (!result.ok) throw rejection(result.error);
      return { provisioned: true };
    },
    async status() { throw new RpcFailure(-32601, "Method not found"); },
  });
  const detach = node.attach(connection);
  connection.ready.catch(detach);
  return { ...connection, close() { detach(); connection.close(); } };
}
