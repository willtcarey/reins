import { afterEach, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { startNode, type Node } from "./node.js";
import { connectRemoteNode } from "./remote-link.js";
import {
  authenticateResult, createRpcPeer, createWebSocketLink, generateNodeKeyPair, newNodeChallenge, protocolVersion, readyResult, verifyNodeAnswer,
  type WebSocketLink,
} from "@reins/node-protocol";

const nodes: Node[] = [];
const servers: Array<{ stop(force?: boolean): unknown }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const node of nodes.splice(0)) await node.shutdown();
});
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
const fastBackoff = { backoff: { initialMs: 5, maxMs: 5 } };

function newNode() {
  const node = startNode();
  nodes.push(node);
  return node;
}

/** A server end of the remote link: every WebSocket at any path becomes a link socket, recorded with the
 * request path, and handed to `served`. */
interface LinkData { path: string; wire?: WebSocketLink }
const linkData: LinkData = { path: "" };
function linkServer(served: (wire: WebSocketLink) => void) {
  const connections: Array<{ path: string; wire: WebSocketLink }> = [];
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      const data: LinkData = { path: new URL(request.url).pathname };
      return bunServer.upgrade(request, { data }) ? undefined : new Response("Upgrade required", { status: 426 });
    },
    websocket: {
      data: linkData,
      open(ws) {
        const wire = createWebSocketLink({ send: text => ws.send(text), bufferedAmount: () => ws.getBufferedAmount(), close: (code, reason) => ws.close(code, reason) }, { maxFrameBytes: 1024 * 1024 });
        ws.data.wire = wire;
        connections.push({ path: ws.data.path, wire });
        served(wire);
      },
      message(ws, message) { ws.data.wire?.receive(typeof message === "string" ? message : new Uint8Array(message)); },
      drain(ws) { ws.data.wire?.drain(); },
      close(ws) { ws.data.wire?.ended(); },
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, connections };
}

test("dials /node-link on its server, answers the challenge as its node for the origin it dialed, and negotiates", async () => {
  const { publicKey, privateKey } = generateNodeKeyPair();
  const verified: boolean[] = [];
  const server = linkServer(wire => {
    // As the server does: the challenge is the connection's first frame, and the hello is answered after it.
    let authenticated!: Promise<void>;
    const peer = createRpcPeer(wire, {
      "node.hello": { params: z.object({ nodeId: z.string() }).loose(), result: readyResult, handle: async () => {
        await authenticated;
        return { kind: "ready" as const, version: protocolVersion, capabilities: [], epoch: crypto.randomUUID() };
      } },
    });
    wire.onmessage = peer.receive;
    wire.onclose = peer.close;
    const challenge = newNodeChallenge();
    authenticated = peer.call("node.authenticate", challenge, authenticateResult).then(answer => {
      verified.push(answer.nodeId === "remote-1" && verifyNodeAnswer({ publicKey, origin: server.url, challenge, answer }));
    });
  });
  const statuses: string[] = [];
  const client = connectRemoteNode(newNode(), { serverUrl: `${server.url}/`, nodeId: "remote-1", identity: { origin: server.url, privateKey }, onStatus: status => statuses.push(status) });
  try {
    await until(() => statuses.includes("connected"));
    expect(server.connections.map(connection => connection.path)).toEqual(["/node-link"]);
    expect(verified).toEqual([true]);
  } finally { client.stop(); }
  await until(() => server.connections[0]!.wire.closed);
});

test("redials after its WebSocket closes, and after a dial that never opens", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  // Nothing listens on the first port the node dials.
  const port = (() => { const probe = Bun.serve({ port: 0, fetch: () => new Response() }); const free = probe.port; probe.stop(true); return free; })();
  const client = connectRemoteNode(newNode(), { serverUrl: `http://127.0.0.1:${port}`, nodeId: "remote-1", identity: { origin: "http://unused", privateKey: generateNodeKeyPair().privateKey }, ...fastBackoff });
  try {
    await Bun.sleep(50);
    // A server comes up on that port; it closes each connection at once.
    let opened = 0;
    const server = Bun.serve({
      port,
      fetch: (request, bunServer) => bunServer.upgrade(request) ? undefined : new Response("Upgrade required", { status: 426 }),
      websocket: { open(ws) { opened++; ws.close(); }, message() {} },
    });
    servers.push(server);
    await until(() => opened >= 2);
  } finally { client.stop(); warn.mockRestore(); }
});

test("closes a connection on which the server sends a message over its frame cap", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const server = linkServer(wire => wire.send(JSON.stringify({ jsonrpc: "2.0", method: "node.ping", params: { pad: "x".repeat(2048) } })));
  const client = connectRemoteNode(newNode(), { serverUrl: server.url, nodeId: "remote-1", identity: { origin: server.url, privateKey: generateNodeKeyPair().privateKey }, maxFrameBytes: 1024, backoff: { initialMs: 60_000, maxMs: 60_000 } });
  try {
    await until(() => server.connections.length === 1 && server.connections[0]!.wire.closed);
    expect(warn.mock.calls.some(([message]) => String(message).includes("exceeds 1024 bytes"))).toBe(true);
  } finally { client.stop(); warn.mockRestore(); }
});
