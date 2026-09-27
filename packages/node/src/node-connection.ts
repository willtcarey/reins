import type { Node } from "./node.js";
import { nodeCommand, type NodeCommand, type NodeResult } from "./contract.js";
import type { NodeSessionBinding } from "./storage.js";
import { APPLICATION_ERROR, createNodeConnection, methods, protocolVersion, RpcFailure, type NodeError, type PeerOptions, type SessionInput, type WireSocket } from "./protocol/connection.js";
import { MAX_ERROR_MESSAGE } from "./protocol/peer.js";

const rejection = (error: NodeError) => {
  const message = error.message.slice(0, MAX_ERROR_MESSAGE);
  return new RpcFailure(APPLICATION_ERROR, message, undefined, { ...error, message });
};
type Admitted = Extract<NodeResult, { ok: true }>["value"];

/** Node half of the wire protocol: every server→node session command is served here.
 * Rejections and thrown errors are application errors whose data is the NodeResult error.
 * The connection serves the node's server calls from creation (calls await negotiation) until closed. */
export function connectNode(node: Node, socket: WireSocket, instanceId: string, options: PeerOptions = {}) {
  /** Commands are rebuilt through the contract schema, so the receipt payload of a replay (the same wire
   * params) matches the first delivery byte-for-byte. */
  const execute = async <K extends Admitted["kind"]>(command: NodeCommand, binding: NodeSessionBinding, kind: K, commandId?: string): Promise<Extract<Admitted, { kind: K }>> => {
    let result;
    try { result = await node.send(nodeCommand.parse(command), binding, commandId); }
    catch (error) { throw rejection({ code: "internal", message: error instanceof Error ? error.message : String(error), retryable: false }); }
    if (!result.ok) throw rejection(result.error);
    if (result.value.kind !== kind) throw rejection({ code: "internal", message: `Unexpected node result: ${result.value.kind}`, retryable: false });
    return result.value as Extract<Admitted, { kind: K }>; // eslint-disable-line typescript-eslint/consistent-type-assertions -- narrowed by the kind check above
  };
  const input = (op: "session.prompt" | "session.steer") => async ({ sessionId, commandId, binding, clientId, content, sourceSessionId }: SessionInput) =>
    ({ inputId: (await execute({ op, sessionId, clientId, content, sourceSessionId }, binding, "admitted", commandId)).inputId });
  const connection = createNodeConnection(socket, {
    instanceId, minVersion: protocolVersion, maxVersion: protocolVersion, ...options,
    capabilities: [methods.sessionProvision, methods.sessionPrompt, methods.sessionSteer, methods.sessionSetModel, methods.sessionAbort, methods.sessionResumePending],
    async provision({ sessionId, commandId, binding, configuration }) {
      await execute({ op: "session.provision", sessionId, sourceId: binding.sourceId,
        configuration: { model: configuration.model, thinkingLevel: configuration.thinkingLevel, task: configuration.task } }, binding, "provisioned", commandId);
      return { provisioned: true };
    },
    prompt: input("session.prompt"),
    steer: input("session.steer"),
    async setModel({ sessionId, commandId, binding, provider, modelId, thinkingLevel }) {
      await execute({ op: "session.setModel", sessionId, provider, modelId, ...(thinkingLevel === undefined ? {} : { thinkingLevel }) }, binding, "modelSet", commandId);
      return { modelSet: true };
    },
    async abort({ sessionId, binding }) { return { aborted: (await execute({ op: "session.abort", sessionId }, binding, "aborted")).aborted }; },
    async resumePending({ sessionId, binding }) { return { started: (await execute({ op: "session.resumePending", sessionId }, binding, "resumed")).started }; },
    async status() { throw new RpcFailure(-32601, "Method not found"); },
  });
  const detach = node.attach(connection);
  connection.ready.catch(detach);
  return { ...connection, close() { detach(); connection.close(); } };
}
