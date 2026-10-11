import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { connectNode, type ConnectNodeOptions, type ConnectTuning, type LinkState, type Transport } from "./node-connection.js";
import { startNode, type Node, type OpenStreamSource } from "./node.js";
import { scriptedNode } from "./testing/scripted-node.js";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import {
  APPLICATION_ERROR, HELLO_TIMEOUT_MS, METHOD_NOT_FOUND, NEGOTIATION_FAILED, NODE_REFUSED, NodeRejection, NotConnected, RpcFailure, STREAM_CHUNK_BYTES, UNAUTHORIZED,
  authenticateResult, createRpcPeer, generateNodeKeyPair, helloParams, methods, newNodeChallenge, nodeError, protocolVersion, verifyNodeAnswer,
  type BuildUpdate, type Hello, type LinkOptions, type LinkSocket, type NodeChallenge, type RpcHandlers,
} from "@reins/node-protocol";

const until = async (condition: () => boolean) => { for (let i = 0; i < 400 && !condition(); i++) await Bun.sleep(2); expect(condition()).toBe(true); };

interface ServerConnection { socket: LinkSocket; peer?: ReturnType<typeof createRpcPeer>; epoch: string }

/**
 * An in-memory server and the transport that reaches it. While it is `listening`, a dial opens a loopback
 * connection whose server end answers `node.hello` with `hello`'s reply (by default `ready`, with every
 * capability the node offered and a fresh epoch per connection), unchecked, and serves `handlers`; a
 * `silent` server reads nothing. It records the hellos and keeps the server ends. While it is not
 * listening, a dial fails. `drained` stands in for the node socket's (a loopback has none).
 */
function memoryServer({ hello, handlers = {}, listening = true, silent = false, linkOptions = {}, drained }: {
  hello?: (hello: Hello, epoch: string) => Promise<unknown>; handlers?: RpcHandlers; listening?: boolean; silent?: boolean; linkOptions?: LinkOptions; drained?: () => Promise<void>;
} = {}) {
  const hellos: Hello[] = [];
  const connections: ServerConnection[] = [];
  const server = {
    listening,
    hellos,
    connections,
    transport: {
      address: "memory",
      link: linkOptions,
      async open(opened) {
        if (!server.listening) throw new Error("Nothing listening");
        const [serverEnd, nodeEnd] = createLoopbackPair();
        const connection: ServerConnection = { socket: serverEnd, epoch: crypto.randomUUID() };
        connections.push(connection);
        if (!silent) {
          connection.peer = createRpcPeer(serverEnd, {
            "node.hello": { params: helloParams, result: z.unknown(), handle: async (params: Hello) => {
              hellos.push(params);
              return hello ? hello(params, connection.epoch) : { kind: "ready", version: protocolVersion, capabilities: params.capabilities, epoch: connection.epoch };
            } },
            ...handlers,
          });
          serverEnd.onmessage = connection.peer.receive;
          serverEnd.onclose = connection.peer.close;
        }
        opened(drained ? withDrained(nodeEnd, drained) : nodeEnd);
      },
    } satisfies Transport,
    /** Calls the node on the newest connection, under its epoch. */
    call(method: string, params: object) {
      const { peer, epoch } = connections.at(-1)!;
      return peer!.call(method, { ...params, epoch }, z.unknown(), { errorData: nodeError });
    },
    notify(method: string, params: object) {
      const { peer, epoch } = connections.at(-1)!;
      return peer!.notify(method, { ...params, epoch });
    },
  };
  return server;
}

/** `socket` with `drained` standing in for its own. */
function withDrained(socket: LinkSocket, drained: () => Promise<void>): LinkSocket {
  const wire: LinkSocket = { get closed() { return socket.closed; }, send: data => socket.send(data), close: () => socket.close(), drained };
  socket.onmessage = data => wire.onmessage?.(data);
  socket.onclose = () => wire.onclose?.();
  return wire;
}

/** Links `node` over `transport` and records the link's states. */
function link(node: Node, transport: Transport, options: Partial<ConnectNodeOptions> = {}, tuning?: ConnectTuning) {
  const states: LinkState[] = [];
  const handle = connectNode(node, transport, { nodeId: "test", onState: state => states.push(state), ...options }, tuning);
  return { states, stop: () => handle.stop() };
}
/** Links `node` to `server` and waits until it is connected. */
async function connected(node: Node, server = memoryServer(), options: Partial<ConnectNodeOptions> = {}) {
  const linked = link(node, server.transport, options);
  await until(() => linked.states.length > 0);
  expect(linked.states).toEqual([{ state: "connected" }]);
  return linked;
}

const binding = { sourceId: 7, cwd: "/tmp/reins-node-connection", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
const opening = { binding, branch: null, lane: { model: { provider: "p", modelId: "m" }, thinkingLevel: null }, runtime: { systemPrompt: "You are REINS.", environment: true } };
/** Every server→node command the node serves, with valid params and the method name it is served under. */
const commands = [
  [methods.sessionPrompt, { sessionId: "s", ...opening, clientId: "c", content: [{ type: "text", text: "hi" }], sourceSessionId: null }, { inputId: "c" }],
  [methods.sessionSteer, { sessionId: "s", ...opening, branch: "task/t", runtime: { systemPrompt: "Sort these.", tools: [], environment: false }, clientId: "d", content: [], sourceSessionId: "parent" }, { inputId: "d" }],
  [methods.sessionSetModel, { sessionId: "s", ...opening, provider: "p", modelId: "m" }, { modelSet: true }],
  [methods.sessionAbort, { sessionId: "s", binding }, { aborted: false }],
  [methods.sessionResumePending, { sessionId: "s", ...opening }, { started: true }],
  [methods.sessionClose, { sessionId: "s" }, { closed: true }],
  [methods.skillsList, { sourceId: 7, cwd: "/tmp/reins-node-connection" }, { skills: [{ name: "review", description: "Reviews code" }] }],
  [methods.fsList, { sourceId: 7, cwd: "/tmp/reins-node-connection", path: "src" }, { entries: [] }],
  [methods.fsWrite, { sourceId: 7, cwd: "/tmp/reins-node-connection", path: "src/a.txt", offset: 0, data: "aGk=", last: true }, { size: 0 }],
  [methods.nodeReload, { force: true }, { scheduled: true }],
] as const;

/** A stand-in node whose every command runs `onCall` with its params, then answers. */
function recordingNode(onCall: (input: unknown) => void | Promise<void>) {
  return scriptedNode({
    prompt: async input => { await onCall(input); return { inputId: input.clientId }; },
    steer: async input => { await onCall(input); return { inputId: input.clientId }; },
    setModel: async input => { await onCall(input); return { modelSet: true }; },
    abort: async input => { await onCall(input); return { aborted: false }; },
    resumePending: async input => { await onCall(input); return { started: true }; },
    close: async input => { await onCall(input); return { closed: true }; },
    listSkills: async input => { await onCall(input); return { skills: [{ name: "review", description: "Reviews code" }] }; },
    runProcess: async input => { await onCall(input); return async function* () { yield "out"; }; },
    listDirectory: async input => { await onCall(input); return { entries: [] }; },
    readFile: async input => { await onCall(input); return { size: 0, source: async function* () {} }; },
    writeFile: async input => { await onCall(input); return { size: 0 }; },
    reload: async input => { await onCall(input); return { scheduled: true }; },
  });
}
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("resolved"); }, (error: RpcFailure) => error);

test("each node command is served under its wire method, advertised in the hello: its params in, its wire result out", async () => {
  const received: unknown[] = [];
  const server = memoryServer();
  const linked = await connected(recordingNode(input => { received.push(input); }), server);
  try {
    expect(new Set(server.hellos[0]!.capabilities)).toEqual(new Set([...commands.map(([method]) => method), methods.processRun, methods.fsRead, methods.streamCancel, methods.credentialsChanged]));
    for (const [method, params, expected] of commands) expect(await server.call(method, params)).toEqual(expected);
    expect(received).toEqual(commands.map(([, params]) => params));
  } finally { linked.stop(); }
});

test("node.hello announces the node, its live sessions and the Bun it runs, and its build where it has one", async () => {
  const server = memoryServer();
  const linked = await connected(scriptedNode({}, { liveSessions: ["running"] }), server, { buildId: "a".repeat(64) });
  try { expect(server.hellos).toEqual([expect.objectContaining({ nodeId: "test", liveSessions: ["running"], buildId: "a".repeat(64), bunVersion: Bun.version })]); } finally { linked.stop(); }
});

test("a NodeRejection keeps its code on the wire for every command; other exceptions are internal", async () => {
  for (const code of ["not_found", "invalid_request", "busy", "unavailable"] as const) {
    const retryable = code === "unavailable";
    const server = memoryServer();
    const linked = await connected(recordingNode(() => { throw new NodeRejection(code, `${code} happened`, retryable); }), server);
    try {
      for (const [method, params] of commands) {
        const error = await failure(server.call(method, params));
        expect({ method, code: error.code, data: error.data }).toEqual({ method, code: APPLICATION_ERROR, data: { code, message: `${code} happened`, retryable } });
      }
    } finally { linked.stop(); }
  }
  const server = memoryServer();
  const linked = await connected(recordingNode(() => { throw new Error("Pi harness faulted"); }), server);
  try {
    for (const [method, params] of commands) {
      expect((await failure(server.call(method, params))).data).toEqual({ code: "internal", message: "Pi harness faulted", retryable: false });
    }
  } finally { linked.stop(); }
});

test("a rejection message longer than the wire allows is truncated, not dropped", async () => {
  const server = memoryServer();
  const linked = await connected(recordingNode(() => { throw new NodeRejection("invalid_request", "x".repeat(5000)); }), server);
  try {
    const error = await failure(server.call(methods.sessionAbort, { sessionId: "s", binding }));
    expect(error.data).toEqual({ code: "invalid_request", message: "x".repeat(2048), retryable: false });
  } finally { linked.stop(); }
});

test("a server call on a connection that never negotiates was never sent; one in flight when the link drops has an unknown outcome", async () => {
  const read = { sessionId: "s", op: "getStats", args: {} } as const;
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  // The server closes before answering hello.
  const refusing = memoryServer({ silent: true });
  const unanswered = scriptedNode();
  const never = link(unanswered, refusing.transport, {}, { backoff: { initialMs: 60_000, maxMs: 60_000 } });
  // The connection attaches its server calls as it opens.
  const calls = unanswered.server();
  refusing.connections[0]!.socket.close();
  expect(await failure(calls.readStorage(read))).toBeInstanceOf(NotConnected);
  never.stop();
  warn.mockRestore();

  // Negotiated, then the link drops while a read is waiting for its reply.
  const received = Promise.withResolvers<void>();
  const server = memoryServer({ handlers: { [methods.storageRead]: { params: z.unknown(), result: z.unknown(), handle: () => { received.resolve(); return new Promise(() => {}); } } } });
  const node = scriptedNode();
  const linked = await connected(node, server);
  const connection = node.server();
  const inFlight = failure(connection.readStorage(read));
  await received.promise;
  server.connections[0]!.socket.close();
  const lost = await inFlight;
  expect(lost).not.toBeInstanceOf(NotConnected);
  expect(lost.outcome).toBe("unknown");
  // Once closed, a new call is not sent.
  expect(await failure(connection.readStorage(read))).toBeInstanceOf(NotConnected);
  linked.stop();
});

test("a command the server sends right behind its hello reply (same read) is served, not rejected as stale", async () => {
  const EPOCH = crypto.randomUUID();
  const sent: Array<{ id?: number | string; method?: string; result?: unknown }> = [];
  let wire!: LinkSocket;
  const linked = link(scriptedNode({ close: async () => ({ closed: true }) }), {
    address: "frames", link: {},
    async open(opened) {
      wire = { closed: false, send: data => { sent.push(JSON.parse(data)); }, close: () => {} };
      opened(wire);
    },
  });
  const hello = sent.find(frame => frame.method === "node.hello")!;
  // The server replies to hello and immediately delivers a queued command (a reconnect replay).
  wire.onmessage!(JSON.stringify({ jsonrpc: "2.0", id: hello.id, result: { kind: "ready", version: protocolVersion, capabilities: ["session.close"], epoch: EPOCH } }));
  wire.onmessage!(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session.close", params: { epoch: EPOCH, sessionId: "s" } }));
  await until(() => sent.some(frame => frame.id === 7));
  expect(sent.find(frame => frame.id === 7)).toMatchObject({ result: { closed: true } });
  expect(linked.states).toEqual([{ state: "connected" }]);
  linked.stop();
});

const UPDATE: BuildUpdate = { buildId: "b".repeat(64), sha256: "b".repeat(64) };

test("a node told to update does not negotiate: the build goes to onUpdate, and the connection closes", async () => {
  const server = memoryServer({ hello: async () => ({ kind: "update", ...UPDATE, mirror: "a later server's field" }) });
  const updates: BuildUpdate[] = [];
  const linked = link(scriptedNode(), server.transport, { buildId: "a".repeat(64), onUpdate: async update => { updates.push(update); } });
  await until(() => updates.length === 1);
  expect(updates).toEqual([UPDATE]);
  await until(() => server.connections[0]!.socket.closed);
  expect(linked.states).toEqual([]);
  linked.stop();
});

test("a hello answered with an error (its code and message reported), a reply of a kind the node does not know, or a malformed update is a refusal the node stops on", async () => {
  const cases: Array<[unknown, LinkState]> = [
    [{ kind: "error", code: "bun_version", message: "This server needs Bun 2.x; this node runs 1.3.9." }, { state: "refused", code: "bun_version", message: "This server needs Bun 2.x; this node runs 1.3.9." }],
    [{ kind: "migrate", to: "elsewhere" }, { state: "refused", message: "The server answered the hello with a reply this node does not understand (migrate); reinstall the node" }],
    [{ kind: "update", buildId: "b".repeat(64) }, { state: "refused", message: "The server answered the hello with a reply this node does not understand (update); reinstall the node" }],
  ];
  for (const [reply, refused] of cases) {
    const server = memoryServer({ hello: async () => reply });
    const linked = link(scriptedNode(), server.transport, { buildId: "a".repeat(64), onUpdate: async () => {} });
    await until(() => linked.states.length === 1);
    expect(linked.states).toEqual([refused]);
    await until(() => server.connections[0]!.socket.closed);
  }
});

test("a ready reply negotiates, ignoring fields this node does not know: the node serves calls under its epoch", async () => {
  const server = memoryServer({ hello: async (_, epoch) => ({ kind: "ready", version: protocolVersion, capabilities: [methods.sessionClose], epoch, motd: "hello" }) });
  const linked = await connected(scriptedNode({ close: async () => ({ closed: true }) }), server);
  try {
    expect(await server.call(methods.sessionClose, { sessionId: "s" })).toEqual({ closed: true });
  } finally { linked.stop(); }
});

interface Frame { method: string; params: { streamId: string; offset?: number; data?: string; encoding?: string; error?: string; exit?: unknown } }

/** A connected node whose server opens streams with `process.run` (the node serves the source a test gives
 * it) and records the stream frames it receives. `hold()` makes the node's socket report unwritten bytes
 * until `release()`, like a socket whose kernel buffer is full. */
async function streamingNode() {
  const frames: Frame[] = [];
  const record = (method: string) => ({ params: z.any(), notify: ({ epoch: _, ...params }: Frame["params"] & { epoch: string }) => { frames.push({ method, params }); } });
  let held: PromiseWithResolvers<void> | undefined;
  const server = memoryServer({ handlers: { "stream.data": record("stream.data"), "stream.end": record("stream.end") }, drained: () => held?.promise ?? Promise.resolve() });
  const sources: OpenStreamSource[] = [];
  await connected(scriptedNode({ runProcess: async () => sources.shift()! }), server);
  return {
    frames,
    data: () => frames.filter(frame => frame.method === "stream.data").map(frame => frame.params),
    /** Opens stream `streamId` with `process.run`, served from `source`; resolves with the node's reply. */
    open(streamId: string, source: OpenStreamSource, { binary = false }: { binary?: boolean } = {}) {
      sources.push(source);
      return server.call("process.run", { sourceId: 1, cwd: "/checkout", streamId, argv: ["producer"], ...(binary ? { binary } : {}) });
    },
    ended: (streamId: string) => until(() => frames.some(frame => frame.method === "stream.end" && frame.params.streamId === streamId)),
    cancel: (streamId: string) => server.notify("stream.cancel", { streamId }),
    hold() { held = Promise.withResolvers(); },
    release() { held?.resolve(); held = undefined; },
  };
}

test("a stream crosses as chunks of at most STREAM_CHUNK_BYTES, each at its absolute UTF-8 byte offset, then ends", async () => {
  const node = await streamingNode();
  const euro = new TextEncoder().encode("€");
  // A large binary item with multi-byte characters straddling chunk boundaries, and a character split across items.
  const large = new TextEncoder().encode("€".repeat(STREAM_CHUNK_BYTES));
  const text = `héllo ${"€".repeat(STREAM_CHUNK_BYTES)}€!`;
  expect(await node.open("s1", async function* () {
    yield "héllo ";
    yield large;
    yield euro.subarray(0, 1);
    yield euro.subarray(1);
    yield "!";
  })).toEqual({});
  await node.ended("s1");
  const chunks = node.data();
  expect(chunks.map(chunk => chunk.data).join("")).toBe(text);
  let offset = 0;
  for (const chunk of chunks) {
    expect(chunk).toMatchObject({ streamId: "s1", offset });
    offset += Buffer.byteLength(chunk.data!);
    expect(Buffer.byteLength(chunk.data!)).toBeLessThanOrEqual(STREAM_CHUNK_BYTES + 3);
  }
  expect(offset).toBe(Buffer.byteLength(text));
  expect(node.frames.at(-1)).toEqual({ method: "stream.end", params: { streamId: "s1" } });
});

test("the next chunk is sent only once the socket has drained", async () => {
  const node = await streamingNode();
  node.hold();
  await node.open("s1", async function* () { yield "a"; yield "b"; yield "c"; });
  await until(() => node.data().length === 1);
  await Bun.sleep(10);
  expect(node.data().map(chunk => chunk.data)).toEqual(["a"]);
  node.release();
  await node.ended("s1");
  expect(node.data().map(chunk => chunk.data)).toEqual(["a", "b", "c"]);
});

test("stream.cancel stops the producer and nothing more is sent for the stream", async () => {
  const node = await streamingNode();
  let signal: AbortSignal | undefined;
  let stopped = false;
  await node.open("s1", async function* (abort) {
    signal = abort;
    try { for (let i = 0; ; i++) { yield `chunk ${i}`; await Bun.sleep(1); } } finally { stopped = true; }
  });
  await until(() => node.data().length >= 2);
  node.cancel("s1");
  await until(() => stopped);
  expect(signal?.aborted).toBe(true);
  expect(stopped).toBe(true);
  const sent = node.frames.length;
  await Bun.sleep(10);
  expect(node.frames).toHaveLength(sent);
  expect(node.frames.some(frame => frame.method === "stream.end")).toBe(false);
});

test("what a source returns when it finishes (a process's exit) crosses in the stream's end frame", async () => {
  const node = await streamingNode();
  const exit = { code: 1, signal: null, stderr: "fatal: not a git repository\n" };
  await node.open("s1", async function* () { yield "out"; return exit; });
  await node.ended("s1");
  expect(node.frames.at(-1)).toEqual({ method: "stream.end", params: { streamId: "s1", exit } });
});

test("a binary stream crosses as base64 chunks whose offsets count the raw bytes", async () => {
  const node = await streamingNode();
  const bytes = new Uint8Array(STREAM_CHUNK_BYTES + 10).map((_, i) => i % 256);
  await node.open("s1", async function* () { yield bytes.subarray(0, 5); yield bytes.subarray(5); }, { binary: true });
  await node.ended("s1");
  const chunks = node.data();
  expect(chunks.map(chunk => [chunk.offset, chunk.encoding])).toEqual([[0, "base64"], [5, "base64"], [5 + STREAM_CHUNK_BYTES, "base64"]]);
  expect(Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data!, "base64")))).toEqual(Buffer.from(bytes));
});

test("a failing source ends its stream with the error, and a stream ID cannot be opened twice at once", async () => {
  const node = await streamingNode();
  const open = Promise.withResolvers<void>();
  await node.open("s1", async function* () { yield "partial"; await open.promise; throw new Error("git exited with 128"); });
  await expect(node.open("s1", async function* () { yield "again"; })).rejects.toThrow();
  open.resolve();
  await node.ended("s1");
  expect(node.frames).toEqual([
    { method: "stream.data", params: { streamId: "s1", offset: 0, data: "partial" } },
    { method: "stream.end", params: { streamId: "s1", error: "git exited with 128" } },
  ]);
});

/** The server's challenge on the newest connection. */
const challenge = (server: ReturnType<typeof memoryServer>, value: NodeChallenge) => server.connections.at(-1)!.peer!.call(methods.nodeAuthenticate, value, authenticateResult);

test("a node with a key answers the server's challenge as its node, for the origin it signs for", async () => {
  const { publicKey, privateKey } = generateNodeKeyPair();
  const origin = "https://reins.example.test";
  const server = memoryServer();
  const linked = await connected(scriptedNode(), server, { nodeId: "node-a", key: { origin, privateKey } });
  try {
    const value = newNodeChallenge();
    const answer = await challenge(server, value);
    expect(answer.nodeId).toBe("node-a");
    expect(verifyNodeAnswer({ publicKey, origin, challenge: value, answer })).toBe(true);
  } finally { linked.stop(); }
});

test("a node with a key negotiates where it is not challenged, as on the local socket", async () => {
  const linked = await connected(scriptedNode(), memoryServer(), { key: { origin: "https://reins.example.test", privateKey: generateNodeKeyPair().privateKey } });
  linked.stop();
});

test("a node without a key refuses a challenge", async () => {
  const server = memoryServer();
  const linked = await connected(scriptedNode(), server);
  try {
    await expect(challenge(server, newNodeChallenge())).rejects.toMatchObject({ code: METHOD_NOT_FOUND });
  } finally { linked.stop(); }
});

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
/** A memory server on `clock`'s timers, with the socket links' hello timeout. */
const clockedServer = (clock: ReturnType<typeof recordingTimers>, options: Parameters<typeof memoryServer>[0] = {}) =>
  memoryServer({ ...options, linkOptions: { helloTimeoutMs: HELLO_TIMEOUT_MS, timers: clock.timers } });
const refusing = (error: RpcFailure) => async (): Promise<never> => { throw error; };

test("redials with capped exponential backoff and jitter, resets the backoff once a connection negotiates, and stops cleanly", async () => {
  const node = startNode();
  const clock = recordingTimers();
  const server = clockedServer(clock, { listening: false });
  let jitter = 1;
  const linked = link(node, server.transport, { nodeId: "internal" }, { random: () => jitter });
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
    await until(() => linked.states.length === 1);
    // Negotiated: once the server closes it, the next redial starts from the initial delay again.
    server.connections[0]!.socket.close();
    expect(await clock.fire(ms => ms < HELLO_TIMEOUT_MS)).toBe(50);
    await until(() => linked.states.length === 3);
    expect(linked.states).toEqual([{ state: "connected" }, { state: "connecting" }, { state: "connected" }]);
    expect(server.hellos.map(hello => hello.nodeId)).toEqual(["internal", "internal"]);
    linked.stop();
    await until(() => server.connections[1]!.socket.closed);
    await Bun.sleep(20);
    expect(clock.pending().filter(ms => ms < HELLO_TIMEOUT_MS)).toEqual([]);
    expect(linked.states).toHaveLength(3);
  } finally { linked.stop(); await node.shutdown(); }
});

test("the node closes a connection whose server never answers node.hello, then redials", async () => {
  const clock = recordingTimers();
  const server = clockedServer(clock, { silent: true });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const linked = link(scriptedNode(), server.transport, {}, { random: () => 1 });
  try {
    await until(() => server.connections.length === 1);
    expect(await clock.fire(ms => ms === HELLO_TIMEOUT_MS)).toBe(HELLO_TIMEOUT_MS);
    await until(() => server.connections[0]!.socket.closed);
    expect(await clock.fire(ms => ms < HELLO_TIMEOUT_MS)).toBe(100);
    await until(() => server.connections.length === 2);
    expect(warn.mock.calls.some(([message]) => String(message).includes("negotiation timed out"))).toBe(true);
  } finally { warn.mockRestore(); linked.stop(); }
});

test("a hello the server refuses as NODE_REFUSED stops the node redialing and reports the refusal once", async () => {
  const clock = recordingTimers();
  const server = clockedServer(clock, { hello: refusing(new RpcFailure(NODE_REFUSED, "Node revoked: remote")) });
  const linked = link(scriptedNode(), server.transport, { nodeId: "remote" }, { random: () => 1 });
  try {
    await until(() => linked.states.length === 1);
    await until(() => server.connections[0]!.socket.closed);
    await Bun.sleep(20);
    expect(clock.pending().filter(ms => ms < HELLO_TIMEOUT_MS)).toEqual([]);
    expect(server.connections).toHaveLength(1);
    expect(linked.states).toEqual([{ state: "refused", message: "Node revoked: remote" }]);
  } finally { linked.stop(); }
});

test("a hello refused for any other reason is redialed with backoff", async () => {
  for (const refuse of [new RpcFailure(NEGOTIATION_FAILED, "No common protocol version"), new RpcFailure(UNAUTHORIZED, "Already negotiated")]) {
    const clock = recordingTimers();
    const server = clockedServer(clock, { hello: refusing(refuse) });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const linked = link(scriptedNode(), server.transport, {}, { random: () => 1 });
    try {
      await until(() => warn.mock.calls.some(([message]) => String(message).includes(refuse.message)));
      expect(await clock.fire(ms => ms < HELLO_TIMEOUT_MS)).toBe(100);
      await until(() => server.connections.length === 2);
      expect(linked.states).toEqual([]);
    } finally { warn.mockRestore(); linked.stop(); }
  }
});

test("a node told to update stops dialing while it updates: a failed update asks the server again after a backoff that grows from 5 s, and one that succeeds ends the link", async () => {
  const clock = recordingTimers();
  const server = clockedServer(clock, { hello: async () => ({ kind: "update", ...UPDATE }) });
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const updates: BuildUpdate[] = [];
  const outcomes = [new Error("could not download the build: HTTP 503"), new Error("it does not match its checksum"), undefined];
  const linked = link(scriptedNode(), server.transport, { nodeId: "remote", buildId: "a".repeat(64), onUpdate: async update => {
    updates.push(update);
    const failed = outcomes.shift();
    if (failed) throw failed;
  } }, { random: () => 1 });
  try {
    await until(() => updates.length === 1);
    await until(() => server.connections[0]!.socket.closed);
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
  } finally { warn.mockRestore(); linked.stop(); }
});

test("a node that cannot update itself (no onUpdate) is stopped by an update as by a refusal", async () => {
  const clock = recordingTimers();
  const server = clockedServer(clock, { hello: async () => ({ kind: "update", ...UPDATE }) });
  const linked = link(scriptedNode(), server.transport, { nodeId: "remote", buildId: "a".repeat(64) }, { random: () => 1 });
  try {
    await until(() => linked.states.length === 1);
    expect(linked.states).toEqual([{ state: "refused", message: `The server runs build ${"b".repeat(12)}, and this node cannot update itself` }]);
    await Bun.sleep(20);
    expect(clock.pending().filter(ms => ms < HELLO_TIMEOUT_MS)).toEqual([]);
  } finally { linked.stop(); }
});
