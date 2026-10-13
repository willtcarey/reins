import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNode } from "./node.js";
import { unixTransport } from "./local-link.js";
import { connectNode, type LinkState } from "./node-connection.js";
import { createRpcPeer, helloParams, helloResult, ndjsonSocketHandler, protocolVersion, type Hello } from "@reins/node-protocol";

const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(2); expect(condition()).toBe(true); };

function socketPath() {
  const dir = mkdtempSync(join(tmpdir(), "reins-local-link-"));
  return { path: join(dir, "node.sock"), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test("a dial to a socket nothing listens on rejects", async () => {
  const { path, dispose } = socketPath();
  try {
    let opened = false;
    await expect(unixTransport(path).open(() => { opened = true; })).rejects.toThrow();
    expect(opened).toBe(false);
  } finally { dispose(); }
});

test("dials the server's Unix socket and runs the node protocol over NDJSON frames on it", async () => {
  const { path, dispose } = socketPath();
  const hellos: Hello[] = [];
  const listener = Bun.listen({ unix: path, socket: ndjsonSocketHandler(1024 * 1024, wire => {
    const peer = createRpcPeer(wire, {
      "node.hello": { params: helloParams, result: helloResult, handle: async (hello: Hello) => {
        hellos.push(hello);
        return { kind: "ready" as const, version: protocolVersion };
      } },
    });
    wire.onmessage = peer.receive; wire.onclose = peer.close;
  }) });
  const node = startNode();
  const states: LinkState[] = [];
  const link = connectNode(node, unixTransport(path), { nodeId: "internal", onState: state => states.push(state) });
  try {
    await until(() => states.length === 1);
    expect(states).toEqual([{ state: "connected" }]);
    expect(hellos.map(hello => hello.nodeId)).toEqual(["internal"]);
  } finally { link.stop(); listener.stop(true); await node.shutdown(); dispose(); }
});
