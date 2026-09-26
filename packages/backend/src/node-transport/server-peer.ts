import { createRpcPeer, RpcFailure, helloParams, readyResult, provisionResult, statusResult, protocolVersion, type Provision, type WireSocket } from "@reins/node/protocol";

/** Not wired to an upgrade route. Authentication and source authorization must precede production use. */
export function createServerTransport(socket: WireSocket) {
  let ready: { epoch: string; capabilities: Array<"node.provision" | "node.status"> } | undefined;
  const peer = createRpcPeer(socket, {
    "node.hello": {
      params: helloParams, result: readyResult,
      async handle(value) {
        if (ready) throw new RpcFailure(-32003, "Already negotiated");
        const hello = helloParams.parse(value);
        if (hello.minVersion > protocolVersion || hello.maxVersion < protocolVersion) throw new RpcFailure(-32001, "No common protocol version");
        const capabilities = hello.capabilities.filter(item => item === "node.provision" || item === "node.status");
        ready = { epoch: crypto.randomUUID(), capabilities };
        return { version: 1, ...ready };
      },
    },
  });
  const authorized = (capability: "node.provision" | "node.status") => {
    if (!ready?.capabilities.includes(capability)) throw new RpcFailure("unavailable", "Node capability not negotiated");
    return ready.epoch;
  };
  return {
    receive: peer.receive,
    close: peer.close,
    async provision(input: Provision) { return peer.call("node.provision", { ...input, epoch: authorized("node.provision") }, provisionResult); },
    async status(sessionId: string) { return peer.call("node.status", { sessionId, epoch: authorized("node.status") }, statusResult); },
  };
}
