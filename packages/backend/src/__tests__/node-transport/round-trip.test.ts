import { test, expect } from "bun:test";
import { createServerTransport } from "../../node-transport/server-peer.js";
import { createNodeConnection } from "@reins/node/protocol";

const unexpected = () => { throw new Error("unexpected"); };
const noServer = { committed: unexpected, started: unexpected, settled: unexpected, attachment: () => null, event: () => {}, scriptExecute: unexpected, scriptSearch: unexpected, createTask: unexpected, findAttachment: () => null, storeAttachment: unexpected, readCredential: async () => null, refreshCredential: async () => null, listCredentials: async () => [] };

test("private loopback WS negotiates and provisions then reports status", async () => {
  let serverPeer: ReturnType<typeof createServerTransport> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, instance) {
      if (new URL(request.url).pathname !== "/test-only" || !instance.upgrade(request)) return new Response("Forbidden", { status: 403 });
    },
    websocket: {
      open(ws) { serverPeer = createServerTransport({ send: data => ws.send(data), close: () => ws.close() }, noServer); },
      message(_ws, message) { serverPeer?.receive(message); },
      close() { serverPeer?.close(); },
    },
  });
  const client = new WebSocket(`ws://127.0.0.1:${server.port}/test-only`);
  let node: ReturnType<typeof createNodeConnection> | undefined;
  const sessions = new Map<string, number>();
  try {
    await new Promise<void>((resolve, reject) => { client.addEventListener("open", () => resolve(), { once: true }); client.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true }); });
    node = createNodeConnection({ send: data => client.send(data), close: () => client.close() }, {
      instanceId: "test-node", minVersion: 1, maxVersion: 2, capabilities: ["session.provision", "session.status", "future.optional"],
      provision: async ({ sessionId, binding }) => { sessions.set(sessionId, binding.sourceId); return { provisioned: true }; },
      status: async ({ sessionId }) => ({ provisioned: sessions.has(sessionId) }),
    });
    client.addEventListener("message", event => node?.receive(event.data));
    client.addEventListener("close", () => node?.close());
    expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(403);
    const ready = await node.ready;
    expect(ready.version).toBe(1);
    expect(ready.capabilities).toEqual(["session.provision", "session.status"]);
    expect(ready.epoch).toBeString();
    const peer = serverPeer!;
    expect(await peer.status("s1")).toEqual({ provisioned: false });
    expect(await peer.provision({ sessionId: "s1", commandId: "cmd-1", binding: { sourceId: 2, cwd: "/tmp/project", createdAt: "2026-01-01T00:00:00Z", parentSessionId: null }, configuration: { model: null, thinkingLevel: null, task: null } })).toEqual({ provisioned: true });
    expect(await peer.status("s1")).toEqual({ provisioned: true });
  } finally {
    node?.close(); serverPeer?.close(); client.close(); server.stop(true);
  }
});

test("server transport rejects operations before negotiation and incompatible versions", async () => {
  const sent: string[] = [];
  const peer = createServerTransport({ send: data => sent.push(data), close: () => {} }, noServer);
  await expect(peer.status("s1")).rejects.toMatchObject({ code: "unavailable" });
  peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "node.hello", params: { minVersion: 2, maxVersion: 3, capabilities: ["session.provision"], instanceId: "x" }, id: 1 }));
  await Bun.sleep(0);
  expect(JSON.parse(sent[0]!)).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32001 } });
  await expect(peer.provision({ sessionId: "s1", commandId: "c", binding: { sourceId: 1, cwd: "/tmp", createdAt: "now", parentSessionId: null }, configuration: { model: null, thinkingLevel: null, task: null } })).rejects.toMatchObject({ code: "unavailable" });
  peer.close();
});
