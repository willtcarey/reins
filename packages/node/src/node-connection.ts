import type { Node } from "./node.js";
import { createNodeConnection, MAX_ERROR_MESSAGE, RpcFailure, APPLICATION_ERROR, NodeRejection, methods, protocolVersion, type NodeCommandHandlers, type WireSocket, type NodeError, type LinkOptions } from "@reins/node-protocol";

const rejection = (error: NodeError) => {
  const message = error.message.slice(0, MAX_ERROR_MESSAGE);
  return new RpcFailure(APPLICATION_ERROR, message, undefined, { ...error, message });
};
/** A `NodeRejection` keeps its code; any other exception thrown by node code is `internal`. */
const served = <I, O>(handle: (input: I) => Promise<O>) => async (input: I): Promise<O> => {
  try { return await handle(input); }
  catch (error) {
    if (error instanceof NodeRejection) throw rejection(error.error);
    throw rejection({ code: "internal", message: error instanceof Error ? error.message : String(error), retryable: false });
  }
};

/** Node half of the wire protocol: every server→node command is served by its `Node` method, and
 * `node.hello` announces the node's live sessions. Rejections are application errors whose data is the `NodeError`. The connection serves
 * the node's server calls from creation (calls await negotiation) until closed, and the streams
 * `process.run` opens on it (it advertises `stream.cancel`). */
export function connectNode(node: Node, socket: WireSocket, nodeId: string, options: LinkOptions = {}) {
  const handlers: NodeCommandHandlers = {
    prompt: served(input => node.prompt(input)), steer: served(input => node.steer(input)),
    setModel: served(input => node.setModel(input)), abort: served(input => node.abort(input)),
    resumePending: served(input => node.resumePending(input)), close: served(input => node.close(input)),
    listSkills: served(input => node.listSkills(input)),
    runProcess: served(input => node.runProcess(input)), listDirectory: served(input => node.listDirectory(input)),
    readFile: served(input => node.readFile(input)), writeFile: served(input => node.writeFile(input)),
    credentialsChanged: input => node.credentialsChanged(input),
    reload: served(input => node.reload(input)),
  };
  const connection = createNodeConnection(socket, {
    nodeId, minVersion: protocolVersion, maxVersion: protocolVersion, ...options,
    capabilities: [methods.sessionPrompt, methods.sessionSteer, methods.sessionSetModel, methods.sessionAbort, methods.sessionResumePending,
      methods.sessionClose, methods.skillsList, methods.processRun, methods.fsList, methods.fsRead, methods.fsWrite, methods.streamCancel, methods.credentialsChanged, methods.nodeReload],
    // Read when dialing: the runs this node still has in progress (see `Node.liveSessions`).
    liveSessions: node.liveSessions(),
    ...handlers,
  });
  const detach = node.attach(connection);
  connection.ready.catch(detach);
  return { ...connection, close() { detach(); connection.close(); } };
}
