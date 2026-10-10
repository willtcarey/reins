import { test, expect, spyOn } from "bun:test";
import { startNode } from "./node.js";
import { redialNode, type Dial, type LinkState } from "./redial.js";
import { createRpcPeer, helloParams, helloResult, HELLO_TIMEOUT_MS, protocolVersion, RpcFailure, NEGOTIATION_FAILED, NODE_REFUSED, UNAUTHORIZED, type BuildUpdate, type Hello, type LinkSocket } from "@reins/node-protocol";
import { createLoopbackPair } from "@reins/node-protocol/testing";

/** Records timeouts (with their delay) for the test to fire; intervals never fire. */
function recordingTimers() {
  const timeouts = new Map<number, { ms: number; callback: () => void }>();
  let next = 0;
  return {
    timers: {
      setTimeout: (callback: () => void, ms: number) => { timeouts.set(++next, { ms, callback }); return next; },
      clearTimeout: (handle: unknown) => { timeouts.delete(Number(handle)); },
      setInterval: () => ++next,
      clearInterval: () => {},
    },
    /** Waits for exactly one pending timeout with a delay matching `match`, then runs it. */
    async fire(match: (ms: number) => boolean): Promise<number> {
      for (let i = 0; i < 400; i++) {
        const found = [...timeouts].find(([, timeout]) => match(timeout.ms));
        if (found) { timeouts.delete(found[0]); found[1].callback(); return found[1].ms; }
        await Bun.sleep(2);
      }
      throw new Error(`No timeout scheduled; pending: ${[...timeouts.values()].map(timeout => timeout.ms).join(", ")}`);
    },
    pending: () => [...timeouts.values()].map(timeout => timeout.ms),
  };
}
const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(2); expect(condition()).toBe(true); };

/**
 * An in-memory server and the dial that reaches it, on `clock`'s timers. While it is `listening`, a dial
 * opens a loopback connection whose server end answers `node.hello` (or refuses it with `refuse`, or tells
 * the node to update to `update`; or, silent, never reads anything), recording the hellos and keeping the
 * server ends; while it is not, a dial fails.
 */
function memoryServer(clock: ReturnType<typeof recordingTimers>, { listening = true, silent = false, refuse, update }: { listening?: boolean; silent?: boolean; refuse?: RpcFailure; update?: BuildUpdate } = {}) {
  const hellos: Hello[] = [];
  const connections: LinkSocket[] = [];
  const server = {
    listening,
    hellos,
    connections,
    dial: {
      address: "memory",
      link: { helloTimeoutMs: HELLO_TIMEOUT_MS, timers: clock.timers },
      async open(opened) {
        if (!server.listening) throw new Error("Nothing listening");
        const [serverEnd, nodeEnd] = createLoopbackPair();
        connections.push(serverEnd);
        if (!silent) {
          const peer = createRpcPeer(serverEnd, {
            "node.hello": { params: helloParams, result: helloResult, handle: async (hello: Hello) => {
              hellos.push(hello);
              if (refuse) throw refuse;
              if (update) return { kind: "update" as const, ...update };
              return { kind: "ready" as const, version: protocolVersion, capabilities: [], epoch: crypto.randomUUID() };
            } },
          });
          serverEnd.onmessage = peer.receive;
          serverEnd.onclose = peer.close;
        }
        opened(nodeEnd);
      },
    } satisfies Dial,
  };
  return server;
}

test("redials with capped exponential backoff and jitter, resets the backoff once a connection negotiates, and stops cleanly", async () => {
  const node = startNode();
  const clock = recordingTimers();
  const server = memoryServer(clock, { listening: false });
  const states: LinkState[] = [];
  let jitter = 1;
  const link = redialNode(node, server.dial, { nodeId: "internal" }, { onState: state => states.push(state) }, { random: () => jitter });
  try {
    // Nothing listens: every dial fails and the ceiling doubles from 100ms up to the 5s cap.
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) delays.push(await clock.fire(() => true));
    // Equal jitter: a delay is uniformly random in [ceiling/2, ceiling] (drawn when it is scheduled).
    jitter = 0;
    delays.push(await clock.fire(() => true));
    expect(delays).toEqual([100, 200, 400, 800, 1600, 3200, 5000, 5000]);
    server.listening = true;
    expect(await clock.fire(() => true)).toBe(2500);
    await until(() => states.length === 1);
    // Negotiated: once the server closes it, the next redial starts from the initial delay again.
    server.connections[0]!.close();
    expect(await clock.fire(ms => ms < HELLO_TIMEOUT_MS)).toBe(50);
    await until(() => states.length === 3);
    expect(states).toEqual([{ state: "connected" }, { state: "connecting" }, { state: "connected" }]);
    expect(server.hellos.map(hello => hello.nodeId)).toEqual(["internal", "internal"]);
    link.stop();
    await until(() => server.connections[1]!.closed);
    await Bun.sleep(20);
    expect(clock.pending().filter(ms => ms < HELLO_TIMEOUT_MS)).toEqual([]);
    expect(states).toHaveLength(3);
  } finally { link.stop(); await node.shutdown(); }
});

test("the node closes a connection whose server never answers node.hello, then redials", async () => {
  const node = startNode();
  const clock = recordingTimers();
  const server = memoryServer(clock, { silent: true });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const link = redialNode(node, server.dial, { nodeId: "internal" }, {}, { random: () => 1 });
  try {
    await until(() => server.connections.length === 1);
    expect(await clock.fire(ms => ms === HELLO_TIMEOUT_MS)).toBe(HELLO_TIMEOUT_MS);
    await until(() => server.connections[0]!.closed);
    expect(await clock.fire(ms => ms < HELLO_TIMEOUT_MS)).toBe(100);
    await until(() => server.connections.length === 2);
    expect(warn.mock.calls.some(([message]) => String(message).includes("negotiation timed out"))).toBe(true);
  } finally { warn.mockRestore(); link.stop(); await node.shutdown(); }
});

test("a hello the server refuses as NODE_REFUSED stops the node redialing and reports the refusal once", async () => {
  const node = startNode();
  const clock = recordingTimers();
  const server = memoryServer(clock, { refuse: new RpcFailure(NODE_REFUSED, "Node revoked: remote") });
  const states: LinkState[] = [];
  const link = redialNode(node, server.dial, { nodeId: "remote" }, { onState: state => states.push(state) }, { random: () => 1 });
  try {
    await until(() => states.length === 1);
    await until(() => server.connections[0]!.closed);
    await Bun.sleep(20);
    expect(clock.pending().filter(ms => ms < HELLO_TIMEOUT_MS)).toEqual([]);
    expect(server.connections).toHaveLength(1);
    expect(states).toEqual([{ state: "refused", message: "Node revoked: remote" }]);
  } finally { link.stop(); await node.shutdown(); }
});

test("a hello refused for any other reason is redialed with backoff", async () => {
  for (const refuse of [new RpcFailure(NEGOTIATION_FAILED, "No common protocol version"), new RpcFailure(UNAUTHORIZED, "Already negotiated")]) {
    const node = startNode();
    const clock = recordingTimers();
    const server = memoryServer(clock, { refuse });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const states: LinkState[] = [];
    const link = redialNode(node, server.dial, { nodeId: "internal" }, { onState: state => states.push(state) }, { random: () => 1 });
    try {
      await until(() => warn.mock.calls.some(([message]) => String(message).includes(refuse.message)));
      expect(await clock.fire(ms => ms < HELLO_TIMEOUT_MS)).toBe(100);
      await until(() => server.connections.length === 2);
      expect(states).toEqual([]);
    } finally { warn.mockRestore(); link.stop(); await node.shutdown(); }
  }
});

const UPDATE: BuildUpdate = { buildId: "b".repeat(64), sha256: "b".repeat(64), bunVersion: "1.3.9" };

test("a node told to update stops dialing while it updates: a failed update asks the server again after a backoff that grows from 5 s, and one that succeeds ends the link", async () => {
  const node = startNode();
  const clock = recordingTimers();
  const server = memoryServer(clock, { update: UPDATE });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const updates: BuildUpdate[] = [];
  const outcomes = [new Error("could not download the build: HTTP 503"), new Error("it does not match its checksum"), undefined];
  const link = redialNode(node, server.dial, { nodeId: "remote", buildId: "a".repeat(64) }, { onUpdate: async update => {
    updates.push(update);
    const failure = outcomes.shift();
    if (failure) throw failure;
  } }, { random: () => 1 });
  try {
    await until(() => updates.length === 1);
    await until(() => server.connections[0]!.closed);
    expect(await clock.fire(() => true)).toBe(5_000);
    await until(() => updates.length === 2);
    expect(await clock.fire(() => true)).toBe(10_000);
    await until(() => updates.length === 3);
    await Bun.sleep(20);

    expect(updates).toEqual([UPDATE, UPDATE, UPDATE]);
    expect(server.hellos.map(hello => hello.buildId)).toEqual(["a".repeat(64), "a".repeat(64), "a".repeat(64)]);
    expect(clock.pending().filter(ms => ms < HELLO_TIMEOUT_MS)).toEqual([]);
    expect(warn.mock.calls.map(([message]) => String(message)).filter(message => message.includes("updating"))).toEqual([
      `[node] updating to build ${"b".repeat(12)} failed: could not download the build: HTTP 503; asking the server again in 5 s`,
      `[node] updating to build ${"b".repeat(12)} failed: it does not match its checksum; asking the server again in 10 s`,
    ]);
  } finally { warn.mockRestore(); link.stop(); await node.shutdown(); }
});

test("a node that cannot update itself (no onUpdate) is stopped by an update as by a refusal", async () => {
  const node = startNode();
  const clock = recordingTimers();
  const server = memoryServer(clock, { update: UPDATE });
  const states: LinkState[] = [];
  const link = redialNode(node, server.dial, { nodeId: "remote", buildId: "a".repeat(64) }, { onState: state => states.push(state) }, { random: () => 1 });
  try {
    await until(() => states.length === 1);
    expect(states).toEqual([{ state: "refused", message: `The server runs build ${"b".repeat(12)}, and this node cannot update itself` }]);
    await Bun.sleep(20);
    expect(clock.pending().filter(ms => ms < HELLO_TIMEOUT_MS)).toEqual([]);
  } finally { link.stop(); await node.shutdown(); }
});
