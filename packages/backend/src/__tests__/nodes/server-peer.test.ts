import { test, expect, spyOn } from "bun:test";
import { z } from "zod";
import { createServerTransport } from "../../nodes/server-peer.js";
import { createRpcPeer, protocolVersion, readyResult, METHOD_NOT_FOUND, NEGOTIATION_FAILED } from "@reins/node-protocol";
import { rawHelloParams } from "../helpers/loopback-node.js";

const killParams = z.looseObject({ execId: z.string() });
const killResult = z.strictObject({ killed: z.boolean() });

test("private loopback WS negotiates, then calls the node's commands: the protocol version fixes the methods, nothing is negotiated per method", async () => {
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
    // A raw node end offering a range of versions, and serving only `pi.execKill`.
    node = createRpcPeer({ send: data => client.send(data), close: () => client.close() }, {
      "pi.execKill": { params: killParams, result: killResult, handle: async ({ execId }: z.infer<typeof killParams>) => ({ killed: running.delete(execId) }) },
    });
    client.addEventListener("message", event => node?.receive(event.data));
    client.addEventListener("close", () => node?.close());
    expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(403);
    const ready = await node.call("node.hello", { ...rawHelloParams("test-node"), minVersion: protocolVersion - 1, maxVersion: protocolVersion + 1 }, readyResult);
    expect(ready).toEqual({ kind: "ready", version: protocolVersion });
    const peer = serverPeer!;
    expect(await peer.call("pi.execKill", { execId: "e1" })).toEqual({ killed: true });
    expect(await peer.call("pi.execKill", { execId: "e1" })).toEqual({ killed: false });
    // Any method of the version is called; one the node does not serve is its answer.
    await expect(peer.call("fs.info", { cwd: "/tmp", path: "." })).rejects.toMatchObject({ code: METHOD_NOT_FOUND });
  } finally {
    node?.close(); serverPeer?.close(); client.close(); server.stop(true);
  }
});

test("server transport sends nothing before negotiation, and refuses incompatible versions and a hello without its docs", async () => {
  const sent: string[] = [];
  const peer = createServerTransport({ send: data => sent.push(data), close: () => {} }, () => {});
  await expect(peer.call("pi.execKill", { execId: "e" })).rejects.toMatchObject({ code: "unavailable", message: "Node not negotiated" });
  await expect(peer.openStream(async () => ({}))).rejects.toMatchObject({ code: "unavailable", message: "Node not negotiated" });
  const { docs: _, ...withoutDocs } = rawHelloParams("x");
  for (const [id, params] of [[1, { ...rawHelloParams("x"), minVersion: protocolVersion + 1, maxVersion: protocolVersion + 2 }], [2, withoutDocs]] as const) {
    peer.receive(JSON.stringify({ jsonrpc: "2.0", method: "node.hello", params, id }));
  }
  await Bun.sleep(0);
  expect(sent.map(frame => JSON.parse(frame))).toEqual([
    { jsonrpc: "2.0", id: 1, error: { code: NEGOTIATION_FAILED, message: `No common protocol version: this server speaks ${protocolVersion}, the node ${protocolVersion + 1} to ${protocolVersion + 2}` } },
    { jsonrpc: "2.0", id: 2, error: { code: NEGOTIATION_FAILED, message: "Invalid negotiation: the hello did not say where the node's docs are" } },
  ]);
  await expect(peer.call("pi.execKill", { execId: "e" })).rejects.toMatchObject({ code: "unavailable" });
  peer.close();
});

test("a node calls nothing on the server but stream frames, served once negotiated: a session or storage call is not a method", async () => {
  const sent: Array<{ jsonrpc?: string; id?: number; result?: unknown; error?: { code: number } }> = [];
  const server = createServerTransport({ send: data => sent.push(JSON.parse(data)), close: () => {} }, () => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    // Before the hello, a stream frame is dropped.
    server.receive(JSON.stringify({ jsonrpc: "2.0", method: "stream.end", params: { streamId: "s1" } }));
    await Bun.sleep(1);
    expect(warn.mock.calls.map(([message, error]) => [String(message), error instanceof Error ? error.message : undefined]))
      .toContainEqual(["Dropped JSON-RPC notification stream.end: handler failed", "Not negotiated"]);
    server.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node.hello", params: rawHelloParams("n") }));
    await Bun.sleep(1);
    expect(sent[0]).toEqual({ jsonrpc: "2.0", id: 1, result: { kind: "ready", version: protocolVersion } });
    const frame = (id: number, method: string, params: unknown) => server.receive(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    frame(2, "session.started", { sessionId: "s", runId: "r" });
    frame(3, "storage.read", { sessionId: "s", op: "getStats", args: {} });
    frame(4, "credentials.get", { providerId: "anthropic" });
    await Bun.sleep(5);
    expect(sent.slice(1).map(reply => [reply.id, reply.error?.code])).toEqual([[2, METHOD_NOT_FOUND], [3, METHOD_NOT_FOUND], [4, METHOD_NOT_FOUND]]);
  } finally { warn.mockRestore(); server.close(); }
});
