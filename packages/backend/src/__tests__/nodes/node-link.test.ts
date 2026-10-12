import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createWebSocketLink, generateNodeKeyPair, REMOTE_LINK, REMOTE_MAX_FRAME_BYTES, type NodeKey } from "@reins/node-protocol";
import { startNode, type Node } from "@reins/node/node";
import { connectNode, type LinkState, type Transport } from "@reins/node/node-connection";
import { webSocketTransport } from "@reins/node/remote-link";
import { handleFetch } from "../../handler.js";
import { logger } from "../../logger.js";
import { Nodes } from "../../models/nodes.js";
import type { UpgradeData } from "../../state.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";
import { useTestDb } from "../helpers/test-db.js";

useTestDb();
let state: TestAppState;
let server: ReturnType<typeof serve>;
const nodes: Node[] = [];
beforeEach(() => {
  state = createAppState();
  server = serve(state);
});
afterEach(async () => {
  state.nodeLinks.close();
  await state.nodes.close();
  server.stop(true);
  for (const node of nodes.splice(0)) await node.shutdown();
});

const upgradeData: UpgradeData = {};
/** The server's HTTP server as the process owner runs it: requests go to the app's `handleFetch`, and a
 * socket whose upgrade data carries handlers is driven by them. */
function serve(app: TestAppState) {
  return Bun.serve({
    port: 0,
    fetch: async (request, bunServer) => await handleFetch(app, request, bunServer),
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
function pairedNode(): { nodeId: string; privateKey: NodeKey["privateKey"] } {
  const { publicKey, privateKey } = generateNodeKeyPair();
  const pairing = new Nodes(state, () => {}).pairing();
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

/** `nodeId`'s node linked (the node's own `connectNode`) over a WebSocket to `/nodes/link` opened with
 * `headers`, signing for `key.origin`; it does not redial. `state` is the link's first state. */
function dialWithHeaders(headers: Record<string, string>, nodeId: string, key: NodeKey) {
  const transport: Transport = {
    address: "/nodes/link", link: REMOTE_LINK,
    open: opened => new Promise((resolve, reject) => {
      const ws = nodeLinkSocket(headers);
      const wire = createWebSocketLink({ send: text => { ws.send(text); return text.length; }, bufferedAmount: () => 0, close: () => ws.close() }, { maxFrameBytes: REMOTE_MAX_FRAME_BYTES });
      ws.onmessage = event => wire.receive(String(event.data));
      ws.onclose = () => wire.ended();
      ws.onerror = reject;
      // Wired as it opens: the server's challenge may come in the same read.
      ws.onopen = () => { opened(wire); resolve(undefined); };
    }),
  };
  const first = Promise.withResolvers<LinkState>();
  const link = connectNode(newNode(), transport, { nodeId, key, onState: change => { first.resolve(change); if (change.state === "connecting") link.stop(); } });
  return { state: first.promise, stop: () => link.stop() };
}

test("a paired node dialing /nodes/link authenticates for the server's origin, negotiates and is served", async () => {
  const { nodeId, privateKey } = pairedNode();
  const client = connectNode(newNode(), webSocketTransport(serverUrl()), { nodeId, key: { origin: serverUrl(), privateKey } });
  try {
    await until(() => state.nodes.get(nodeId).connected);
    await expect(state.nodes.get(nodeId).request("pi.execKill", { execId: "none" })).rejects.toMatchObject({ data: { code: "not_found" } });
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
  expect(await forwarded.state).toEqual({ state: "connected" });
  expect(state.nodes.get(nodeId).connected).toBe(true);
  forwarded.stop();
  await until(() => !state.nodes.get(nodeId).connected);

  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const direct = await dialWithHeaders(proxied, nodeId, { origin: serverUrl(), privateKey });
    expect(await direct.state).toEqual({ state: "refused", message: "Not authenticated" });
    expect(state.nodes.get(nodeId).connected).toBe(false);
  } finally { warn.mockRestore(); }
});

test("closing the app's node links closes every connection it accepted, negotiated or not, and refuses new ones", async () => {
  const { nodeId, privateKey } = pairedNode();
  const linked = await dialWithHeaders({}, nodeId, { origin: serverUrl(), privateKey });
  expect(await linked.state).toEqual({ state: "connected" });
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
