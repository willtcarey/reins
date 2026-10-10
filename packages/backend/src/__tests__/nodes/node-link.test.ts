import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createWebSocketLink, generateNodeKeyPair, NODE_REFUSED, REMOTE_LINK, REMOTE_MAX_FRAME_BYTES, type NodeIdentity } from "@reins/node-protocol";
import { startNode, type Node } from "@reins/node/node";
import { connectNode } from "@reins/node/node-connection";
import { connectRemoteNode } from "@reins/node/remote-link";
import { handleFetch } from "../../handler.js";
import { logger } from "../../logger.js";
import { Nodes } from "../../models/nodes.js";
import type { ServerState, UpgradeData } from "../../state.js";
import { createServerState } from "../helpers/server-state.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();
let state: ServerState;
let server: ReturnType<typeof serve>;
const nodes: Node[] = [];
beforeEach(() => {
  state = createServerState();
  server = serve(state);
});
afterEach(async () => {
  state.nodeLinks.close();
  await state.nodes.close();
  server.stop(true);
  for (const node of nodes.splice(0)) await node.shutdown();
});

const upgradeData: UpgradeData = {};
/** The server's HTTP server as the process owner runs it: requests go to the load's `handleFetch`, and a
 * socket whose upgrade data carries handlers is driven by them. */
function serve(load: ServerState) {
  return Bun.serve({
    port: 0,
    fetch: async (request, bunServer) => await handleFetch(load, request, bunServer),
    websocket: {
      data: upgradeData,
      maxPayloadLength: REMOTE_MAX_FRAME_BYTES,
      open(ws) { ws.data.handlers?.open(ws); },
      message(ws, message) { ws.data.handlers?.message(ws, message); },
      drain(ws) { ws.data.handlers?.drain(ws); },
      close(ws, code, reason) { ws.data.handlers?.close(ws, code, reason); },
    },
  });
}
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };
const serverUrl = () => `http://127.0.0.1:${server.port}`;

function newNode(): Node {
  const node = startNode();
  nodes.push(node);
  return node;
}

/** Pairs a node through the real pairing code flow. */
function pairedNode(): { nodeId: string; privateKey: NodeIdentity["privateKey"] } {
  const { publicKey, privateKey } = generateNodeKeyPair();
  const pairing = new Nodes(state.nodes, () => {}).pairing();
  const { nodeId } = pairing.redeem({ code: pairing.createCode().code, publicKey, hostname: "remote-host" });
  return { nodeId, privateKey };
}

/** A WebSocket to `/nodes/link` sending `headers` (Bun's constructor option, which the DOM typing of
 * `WebSocket` does not know). */
function nodeLinkSocket(headers: Record<string, string>): WebSocket {
  return Reflect.construct(WebSocket, [`ws://127.0.0.1:${server.port}/nodes/link`, { headers }]);
}

/** One WebSocket to `/nodes/link` sending `headers`, as a proxy in front of the server would. */
async function openSocket(headers: Record<string, string> = {}): Promise<{ ws: WebSocket; frames: string[]; closed: () => boolean }> {
  const ws = nodeLinkSocket(headers);
  const frames: string[] = [];
  let closed = false;
  ws.addEventListener("message", event => frames.push(String(event.data)));
  ws.addEventListener("close", () => { closed = true; });
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  return { ws, frames, closed: () => closed };
}

/** Runs `nodeId`'s node protocol over a WebSocket opened with `headers`, signing for `identity.origin`. */
async function dialWithHeaders(headers: Record<string, string>, nodeId: string, identity: NodeIdentity) {
  const ws = nodeLinkSocket(headers);
  const wire = createWebSocketLink({ send: text => { ws.send(text); return text.length; }, bufferedAmount: () => 0, close: () => ws.close() }, { maxFrameBytes: REMOTE_MAX_FRAME_BYTES });
  ws.onmessage = event => wire.receive(String(event.data));
  ws.onclose = () => wire.ended();
  // Wired as it opens: the server's challenge may come in the same read.
  const connection = await new Promise<ReturnType<typeof connectNode>>((resolve, reject) => {
    ws.onerror = reject;
    ws.onopen = () => {
      const opened = connectNode(newNode(), wire, nodeId, { ...REMOTE_LINK, identity });
      wire.onmessage = opened.receive;
      wire.onclose = opened.close;
      resolve(opened);
    };
  });
  return { connection, ws };
}

test("a paired node dialing /nodes/link authenticates for the server's origin, negotiates and is served", async () => {
  const { nodeId, privateKey } = pairedNode();
  const client = connectRemoteNode(newNode(), { serverUrl: serverUrl(), nodeId, identity: { origin: serverUrl(), privateKey } });
  try {
    await until(() => state.nodes.get(nodeId).connected);
    expect(await state.nodes.get(nodeId).request("session.close", { sessionId: "none" })).toEqual({ closed: false });
  } finally { client.stop(); }
});

test("the server challenges first: the connection's first frame is node.authenticate", async () => {
  const { frames, ws } = await openSocket();
  await until(() => frames.length > 0);
  expect(JSON.parse(frames[0]!)).toMatchObject({ jsonrpc: "2.0", method: "node.authenticate", params: { challengeId: expect.any(String), nonce: expect.any(String) } });
  ws.close();
});

test("behind a proxy the origin is the forwarded one: a signature for it is accepted, one for the address the proxy dialed is refused", async () => {
  const { nodeId, privateKey } = pairedNode();
  // Each header's first value counts, as a chain of proxies appends theirs.
  const proxied = { "X-Forwarded-Proto": "https, http", "X-Forwarded-Host": "reins.example.ts.net, 127.0.0.1" };

  const forwarded = await dialWithHeaders(proxied, nodeId, { origin: "https://reins.example.ts.net", privateKey });
  expect(await forwarded.connection.ready).toMatchObject({ epoch: expect.any(String) });
  expect(state.nodes.get(nodeId).connected).toBe(true);
  forwarded.ws.close();
  await until(() => !state.nodes.get(nodeId).connected);

  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const direct = await dialWithHeaders(proxied, nodeId, { origin: serverUrl(), privateKey });
    await expect(direct.connection.ready).rejects.toMatchObject({ code: NODE_REFUSED, message: "Not authenticated" });
    expect(state.nodes.get(nodeId).connected).toBe(false);
  } finally { warn.mockRestore(); }
});

test("closing the load's node links closes every connection it accepted, negotiated or not, and refuses new ones", async () => {
  const { nodeId, privateKey } = pairedNode();
  const linked = await dialWithHeaders({}, nodeId, { origin: serverUrl(), privateKey });
  await linked.connection.ready;
  const pending = await openSocket();

  state.nodeLinks.close();
  await until(() => pending.closed() && !state.nodes.get(nodeId).connected);
  const refused = await fetch(`${serverUrl()}/nodes/link`, { headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" } });
  expect(refused.status).toBe(503);
});

test("a request to /nodes/link that is not a WebSocket upgrade is refused, not served the web app", async () => {
  const response = await fetch(`${serverUrl()}/nodes/link`);
  expect(response.status).toBe(426);
});
