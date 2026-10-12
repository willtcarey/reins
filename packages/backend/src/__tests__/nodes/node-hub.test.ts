import { test, expect, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createRpcPeer, protocolVersion, LOCAL_LINK, LOCAL_MAX_FRAME_BYTES, ndjsonSocketHandler, readyResult, RpcFailure, type LinkOptions, type NdjsonSocket, NODE_REFUSED } from "@reins/node-protocol";
import { unixTransport } from "@reins/node/local-link";
import { connectNode, type LinkState } from "@reins/node/node-connection";
import { scriptedNode } from "@reins/node/testing";
import { setDb } from "../../db.js";
import { runMigrations } from "../../migrations.js";
import { createProject } from "../project-fixture.js";
import { defaultSource } from "../../node-store.js";
import { listenLocalNodeSocket } from "../../nodes/local-socket.js";
import { createAppState, type TestAppState } from "../helpers/app-state.js";

/** Kills a command on the node (`pi.execKill`): a call that needs the node's link. */
const killOnNode = (state: TestAppState) => state.nodes.get("internal").request("pi.execKill", { execId: "e" });
const unavailable = (error: unknown) => error instanceof RpcFailure && error.code === "unavailable";
const until = async (condition: () => boolean, tries = 1000) => { for (let i = 0; i < tries && !condition(); i++) await Bun.sleep(5); expect(condition()).toBe(true); };

/** A product database plus a server in socket mode listening on a temp Unix socket; every frame
 * the server receives is recorded by method, and every frame it sends as it is. */
async function socketServer(name: string, accept: LinkOptions = LOCAL_LINK) {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON"); setDb(db); runMigrations(db);
  const dir = mkdtempSync(join(tmpdir(), "reins-node-socket-"));
  const state = createAppState();
  const received: string[] = [];
  const sent: string[] = [];
  const accepted: NdjsonSocket[] = [];
  const listener = await listenLocalNodeSocket(join(dir, "run", "node.sock"), socket => {
    accepted.push(socket);
    state.nodes.accept(socket, accept);
    const serve = socket.onmessage!;
    socket.onmessage = data => { received.push(JSON.parse(data).method ?? "reply"); serve(data); };
    const send = socket.send.bind(socket);
    socket.send = data => { sent.push(data); send(data); };
  });
  const project = createProject(name, dir);
  const source = defaultSource(project.id)!;
  const dispose = () => { listener.stop(); state.nodes.close(); setDb(new Database(":memory:")); db.close(); rmSync(dir, { recursive: true, force: true }); };
  return { db, dir, state, listener, received, sent, accepted, project, source, dispose };
}

/** A raw node end on the server's socket, wired before any frame can arrive. */
async function dial(path: string, wire: (socket: NdjsonSocket) => void) {
  let socket: NdjsonSocket | undefined;
  await Bun.connect({ unix: path, socket: ndjsonSocketHandler(LOCAL_MAX_FRAME_BYTES, opened => { socket = opened; wire(opened); }) });
  return socket!;
}

test("a newly negotiated connection supersedes the old one: the old connection's in-flight call ends with outcome unknown, and calls go to the new one under its epoch", async () => {
  const server = await socketServer("socket-supersede");
  const kill = () => killOnNode(server.state);
  try {
    // Nothing connected: the call is not sent.
    await expect(kill()).rejects.toMatchObject({ code: "unavailable" });
    // A node whose command never answers, which does not redial once its connection closes.
    const calls: string[] = [];
    const states: LinkState[] = [];
    const old = connectNode(scriptedNode({ piExecKill: async () => { calls.push("old"); return new Promise<never>(() => {}); } }), unixTransport(server.listener.path), {
      nodeId: "internal", onState: state => { states.push(state); if (state.state === "connecting") old.stop(); },
    });
    await until(() => states.length === 1);
    // The epoch the server issued it, in its hello's reply.
    const [oldEpoch] = server.sent.flatMap(frame => JSON.parse(frame).result?.epoch ?? []);
    expect(oldEpoch).toBeString();
    const inFlight = kill().then(() => undefined, (error: unknown) => error);
    await until(() => calls.length === 1);

    const seen: string[] = [];
    const wire = await dial(server.listener.path, () => {});
    const peer = createRpcPeer(wire, {
      "pi.execKill": { params: epochParams, result: z.unknown(), handle: async params => { seen.push(epochParams.parse(params).epoch); return { killed: true }; } },
    });
    wire.onmessage = peer.receive; wire.onclose = peer.close;
    const { epoch } = await peer.call("node.hello", { nodeId: "internal", minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: ["pi.execKill"] }, readyResult);

    // The old connection is closed: its in-flight call's outcome is unknown.
    expect(unavailable(await inFlight)).toBe(true);
    await until(() => states.at(-1)?.state === "connecting");
    expect(await kill()).toEqual({ killed: true });
    expect(seen).toEqual([epoch]);
    expect(epoch).not.toBe(oldEpoch);
    peer.close();
    old.stop();
  } finally { server.dispose(); }
});

const epochParams = z.looseObject({ epoch: z.string() });

test("the server closes a connection that never negotiates and, by heartbeat, one whose node stops responding; neither becomes the link", async () => {
  const intervals: Array<() => void> = [];
  const timeouts: Array<() => void> = [];
  const timers = {
    setTimeout: (callback: () => void) => timeouts.push(callback),
    clearTimeout: () => {},
    setInterval: (callback: () => void) => intervals.push(callback),
    clearInterval: () => {},
  };
  const server = await socketServer("socket-liveness", { ...LOCAL_LINK, timers });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const kill = () => killOnNode(server.state);
  try {
    const silent = await dial(server.listener.path, () => {});
    await until(() => timeouts.length === 1);
    for (const fire of timeouts.splice(0)) fire();
    await until(() => silent.closed);
    await expect(kill()).rejects.toMatchObject({ code: "unavailable" });

    // Negotiates, then hangs: it never reads or writes again.
    const hung = await dial(server.listener.path, () => {});
    const peer = createRpcPeer(hung, {});
    hung.onmessage = peer.receive;
    await peer.call("node.hello", { nodeId: "internal", minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [] }, readyResult);
    hung.onmessage = () => {};
    const tick = () => { for (const beat of intervals) beat(); };
    await until(() => intervals.length === 2);
    tick(); tick(); tick();
    expect(hung.closed).toBe(false);
    tick();
    await until(() => hung.closed);
    expect(warn.mock.calls.some(([message]) => String(message).includes("heartbeat"))).toBe(true);
    await expect(kill()).rejects.toMatchObject({ code: "unavailable" });
  } finally { warn.mockRestore(); server.dispose(); }
});

test("a connection is served only for the node ID it announces if that node exists; a new connection supersedes only its own node's link", async () => {
  const server = await socketServer("socket-identity");
  server.db.exec("INSERT INTO nodes (id, name) VALUES ('remote', 'Remote')");
  /** A raw node end announcing `nodeId`; resolves with its hello's outcome. */
  const hello = async (nodeId: string) => {
    const wire = await dial(server.listener.path, () => {});
    const peer = createRpcPeer(wire, {});
    wire.onmessage = peer.receive; wire.onclose = peer.close;
    const ready = peer.call("node.hello", { nodeId, minVersion: protocolVersion, maxVersion: protocolVersion, capabilities: [] }, readyResult);
    return { wire, ready };
  };
  try {
    // Unknown node: refused at hello, never a link (enrollment of new nodes is future work).
    const stranger = await hello("stranger");
    await expect(stranger.ready).rejects.toMatchObject({ code: NODE_REFUSED, message: "Node not found: stranger" });
    expect(server.state.nodes.get("stranger").connected).toBe(false);

    const local = await hello("internal");
    const remote = await hello("remote");
    await Promise.all([local.ready, remote.ready]);
    await until(() => server.state.nodes.get("internal").connected && server.state.nodes.get("remote").connected);
    // A new connection for one node closes that node's previous link only.
    const redialed = await hello("internal");
    await redialed.ready;
    await until(() => local.wire.closed);
    expect(remote.wire.closed).toBe(false);
    expect([server.state.nodes.get("internal").connected, server.state.nodes.get("remote").connected]).toEqual([true, true]);
    remote.wire.close();
    await until(() => !server.state.nodes.get("remote").connected);
    expect(server.state.nodes.get("internal").connected).toBe(true);
    redialed.wire.close();
  } finally { server.dispose(); }
});
