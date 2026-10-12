import { test, expect, spyOn } from "bun:test";
import { z } from "zod";
import { createServerTransport } from "../../nodes/server-peer.js";
import { createRpcPeer, protocolVersion, readyResult, METHOD_NOT_FOUND, NEGOTIATION_FAILED } from "@reins/node-protocol";

const killParams = z.looseObject({ execId: z.string() });
const killResult = z.strictObject({ killed: z.boolean() });

test("private loopback WS negotiates, then calls the node's commands", async () => {
  let serverPeer: ReturnType<typeof createServerTransport> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, instance) {
      if (new URL(request.url).pathname !== "/test-only" || !instance.upgrade(request)) return new Response("Forbidden", { status: 403 });
    },
    websocket: {
      open(ws) { serverPeer = createServerTransport({ send: data => ws.send(data), close: () => ws.close() }, () => {}); },
      message(_ws, message) { serverPeer?.receive(message); },
      close() { serverPeer?.close(); },
    },
  });
  const client = new WebSocket(`ws://127.0.0.1:${server.port}/test-only`);
  let node: ReturnType<typeof createRpcPeer> | undefined;
  const running = new Set(["e1"]);
  try {
    await new Promise<void>((resolve, reject) => { client.addEventListener("open", () => resolve(), { once: true }); client.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true }); });
    // A raw node end offering a range of versions and a capability this server does not know.
    node = createRpcPeer({ send: data => client.send(data), close: () => client.close() }, {
      "pi.execKill": { params: killParams, result: killResult, handle: async ({ execId }: z.infer<typeof killParams>) => ({ killed: running.delete(execId) }) },
    });
    client.addEventListener("message", event => node?.receive(event.data));
    client.addEventListener("close", () => node?.close());
    expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(403);
    const ready = await node.call("node.hello", {
      nodeId: "test-node", minVersion: protocolVersion - 1, maxVersion: protocolVersion + 1, capabilities: ["pi.execKill", "future.optional"],
    }, readyResult);
    expect(ready.version).toBe(protocolVersion);
    expect(ready.capabilities).toEqual(["pi.execKill"]);
    expect(ready.epoch).toBeString();
    const peer = serverPeer!;
    expect(await peer.call("pi.execKill", { execId: "e1" })).toEqual({ killed: true });
    expect(await peer.call("pi.execKill", { execId: "e1" })).toEqual({ killed: false });
    // A capability the node did not offer is not called.
    await expect(peer.call("fs.info", { cwd: "/tmp", path: "." })).rejects.toMatchObject({ code: "unavailable" });
  } finally {
    node?.close(); serverPeer?.close(); client.close(); server.stop(true);
  }
});

test("server transport rejects operations before negotiation and incompatible versions", async () => {
  const sent: string[] = [];
  const peer = createServerTransport({ send: data => sent.push(data), close: () => {} }, () => {});
  await expect(peer.call("pi.execKill", { execId: "e" })).rejects.toMatchObject({ code: "unavailable" });
  peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "node.hello", params: { minVersion: protocolVersion + 1, maxVersion: protocolVersion + 2, capabilities: ["pi.execKill"], nodeId: "x" }, id: 1 }));
  await Bun.sleep(0);
  expect(JSON.parse(sent[0]!)).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: NEGOTIATION_FAILED } });
  await expect(peer.call("pi.execKill", { execId: "e" })).rejects.toMatchObject({ code: "unavailable" });
  peer.close();
});

test("a node calls nothing on the server but stream frames: a session or storage call is not a method, and a frame under an epoch it was not issued is dropped", async () => {
  const sent: Array<{ id?: number; result?: { epoch: string }; error?: { code: number } }> = [];
  const server = createServerTransport({ send: data => sent.push(JSON.parse(data)), close: () => {} }, () => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node.hello", params: { minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [], nodeId: "n" } }));
    await Bun.sleep(1);
    const epoch = sent[0]!.result!.epoch;
    const frame = (id: number, method: string, params: unknown) => server.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    frame(2, "session.started", { epoch, sessionId: "s", runId: "r" });
    frame(3, "storage.read", { epoch, sessionId: "s", op: "getStats", args: {} });
    frame(4, "credentials.get", { epoch, providerId: "anthropic" });
    server.receive(JSON.stringify({ jsonrpc: "2.0", method: "stream.end", params: { epoch: crypto.randomUUID(), streamId: "s1" } }));
    await Bun.sleep(5);
    expect(sent.slice(1).map(reply => [reply.id, reply.error?.code])).toEqual([[2, METHOD_NOT_FOUND], [3, METHOD_NOT_FOUND], [4, METHOD_NOT_FOUND]]);
    expect(warn.mock.calls.map(([message, error]) => [String(message), error instanceof Error ? error.message : undefined]))
      .toContainEqual(["Dropped JSON-RPC notification stream.end: handler failed", "Stale or unauthorized connection"]);
  } finally { warn.mockRestore(); server.close(); }
});
