import { createRpcPeer, RpcFailure, type WireSocket } from "./peer.js";
import { protocolVersion, helloParams, provisionParams, provisionResult, readyResult, statusParams, statusResult, type Hello, type Provision, type Ready, type Status } from "./schema.js";

export interface NodeConnectionOptions extends Hello {
  provision(input: Provision): Promise<{ provisioned: true }>;
  status(input: { sessionId: string }): Promise<Status>;
}

/** Test/integration seam: no socket creation, key material, storage, or process lifecycle. */
export function createNodeConnection(socket: WireSocket, options: NodeConnectionOptions) {
  const hello = helloParams.parse({ instanceId: options.instanceId, minVersion: options.minVersion, maxVersion: options.maxVersion, capabilities: options.capabilities });
  let negotiated: Ready | undefined;
  const peer = createRpcPeer(socket, {
    "node.provision": {
      params: provisionParams, result: provisionResult,
      async handle(value) {
        const input = provisionParams.parse(value);
        if (!negotiated || input.epoch !== negotiated.epoch || !negotiated.capabilities.includes("node.provision")) throw new RpcFailure(-32003, "Stale or unauthorized connection");
        return options.provision({ sessionId: input.sessionId, commandId: input.commandId, binding: input.binding });
      },
    },
    "node.status": {
      params: statusParams, result: statusResult,
      async handle(value) {
        const input = statusParams.parse(value);
        if (!negotiated || input.epoch !== negotiated.epoch || !negotiated.capabilities.includes("node.status")) throw new RpcFailure(-32003, "Stale or unauthorized connection");
        return options.status({ sessionId: input.sessionId });
      },
    },
  });
  const ready = peer.call("node.hello", hello, readyResult).then(value => {
    if (value.version < hello.minVersion || value.version > hello.maxVersion || value.capabilities.some(item => !hello.capabilities.includes(item))) {
      peer.close(); throw new RpcFailure(-32001, "Invalid negotiation");
    }
    negotiated = value;
    return value;
  });
  return { receive: peer.receive, close: peer.close, ready };
}

export { createRpcPeer, RpcFailure, helloParams, provisionParams, provisionResult, readyResult, statusParams, statusResult, protocolVersion };
export type { WireSocket, Provision, Ready, Hello, Status };
