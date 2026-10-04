import { expect, test } from "bun:test";
import { z } from "zod";
import { connectNode } from "./node-connection.js";
import type { Node } from "./node.js";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import { createRpcPeer, RpcFailure, NodeRejection, NotConnected, nodeError, methods, protocolVersion, readyResult, APPLICATION_ERROR } from "@reins/node-protocol";

const binding = { sourceId: 7, cwd: "/tmp/reins-node-connection", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
const opening = { binding, task: null, lane: { model: { provider: "p", modelId: "m" }, thinkingLevel: null } };
/** Every server→node command the node serves, with valid params and the method name it is served under. */
const commands = [
  [methods.sessionPrompt, { sessionId: "s", ...opening, clientId: "c", content: [{ type: "text", text: "hi" }], sourceSessionId: null }, { inputId: "c" }],
  [methods.sessionSteer, { sessionId: "s", ...opening, task: { title: "T", description: null, branchName: "task/t" }, clientId: "d", content: [], sourceSessionId: "parent" }, { inputId: "d" }],
  [methods.sessionSetModel, { sessionId: "s", ...opening, provider: "p", modelId: "m" }, { modelSet: true }],
  [methods.sessionAbort, { sessionId: "s", binding }, { aborted: false }],
  [methods.sessionResumePending, { sessionId: "s", ...opening }, { started: true }],
  [methods.sessionClose, { sessionId: "s" }, { closed: true }],
  [methods.skillsList, { sourceId: 7, cwd: "/tmp/reins-node-connection" }, { skills: [{ name: "review", description: "Reviews code" }] }],
  [methods.fsList, { sourceId: 7, cwd: "/tmp/reins-node-connection", path: "src" }, { entries: [] }],
] as const;
/** What a stand-in node method does with its params before answering (record them, or throw). */
type OnCall = (input: unknown) => void | Promise<void>;

/** A server that negotiates every capability and sends session commands to a stand-in node whose every
 * method runs `onCall`, so this checks only the wire mapping. */
async function linked(onCall: OnCall, liveSessions: string[] = []) {
  const node: Node = {
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
    attach: () => () => {}, shutdown: async () => {}, liveSessions: () => liveSessions,
  };
  const hellos: unknown[] = [];
  const [serverEnd, nodeEnd] = createLoopbackPair();
  const epoch = crypto.randomUUID();
  const server = createRpcPeer(serverEnd, {
    [methods.nodeHello]: { params: z.unknown(), result: readyResult, handle: async hello => { hellos.push(hello); return { version: protocolVersion, capabilities: commands.map(([method]) => method), epoch }; } },
  });
  const connection = connectNode(node, nodeEnd, "test");
  serverEnd.onmessage = server.receive; serverEnd.onclose = server.close;
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  await connection.ready;
  const call = (method: string, params: object) => server.call(method, { ...params, epoch }, z.unknown(), { errorData: nodeError });
  return { call, hellos, close: () => serverEnd.close() };
}
const unexpected = async (): Promise<never> => { throw new Error("unexpected command"); };
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("resolved"); }, (error: RpcFailure) => error);

test("each node method is served under its wire method: its params in, its wire result out", async () => {
  const received: unknown[] = [];
  const { call, close } = await linked(input => { received.push(input); });
  try {
    for (const [method, params, expected] of commands) expect(await call(method, params)).toEqual(expected);
    expect(received).toEqual(commands.map(([, params]) => params));
  } finally { close(); }
});

test("node.hello announces the node's live sessions", async () => {
  const { hellos, close } = await linked(() => {}, ["running"]);
  try { expect(hellos).toEqual([expect.objectContaining({ nodeId: "test", liveSessions: ["running"] })]); } finally { close(); }
});

test("a NodeRejection keeps its code on the wire for every command; other exceptions are internal", async () => {
  for (const code of ["not_found", "invalid_request", "busy", "unavailable"] as const) {
    const retryable = code === "unavailable";
    const { call, close } = await linked(() => { throw new NodeRejection(code, `${code} happened`, retryable); });
    try {
      for (const [method, params] of commands) {
        const error = await failure(call(method, params));
        expect({ method, code: error.code, data: error.data }).toEqual({ method, code: APPLICATION_ERROR, data: { code, message: `${code} happened`, retryable } });
      }
    } finally { close(); }
  }
  const { call, close } = await linked(() => { throw new Error("Pi harness faulted"); });
  try {
    for (const [method, params] of commands) {
      expect((await failure(call(method, params))).data).toEqual({ code: "internal", message: "Pi harness faulted", retryable: false });
    }
  } finally { close(); }
});

test("a rejection message longer than the wire allows is truncated, not dropped", async () => {
  const { call, close } = await linked(() => { throw new NodeRejection("invalid_request", "x".repeat(5000)); });
  try {
    const error = await failure(call(methods.sessionAbort, { sessionId: "s", binding }));
    expect(error.data).toEqual({ code: "invalid_request", message: "x".repeat(2048), retryable: false });
  } finally { close(); }
});

test("a server call on a connection that never negotiates was never sent; one in flight when the link drops has an unknown outcome", async () => {
  const stub: Node = { prompt: unexpected, steer: unexpected, setModel: unexpected, abort: unexpected, resumePending: unexpected, close: unexpected,
    listSkills: unexpected, runProcess: unexpected, listDirectory: unexpected, readFile: unexpected, attach: () => () => {}, shutdown: async () => {}, liveSessions: () => [] };
  const read = { sessionId: "s", op: "getStats", args: {} } as const;
  // The server closes before answering hello.
  const [refusing, unanswered] = createLoopbackPair();
  const never = connectNode(stub, unanswered, "test");
  unanswered.onmessage = never.receive; unanswered.onclose = never.close;
  refusing.onmessage = () => refusing.close();
  expect(await failure(never.readStorage(read))).toBeInstanceOf(NotConnected);

  // Negotiated, then the link drops while a read is waiting for its reply.
  const [serverEnd, nodeEnd] = createLoopbackPair();
  const received = Promise.withResolvers<void>();
  const server = createRpcPeer(serverEnd, {
    [methods.nodeHello]: { params: z.unknown(), result: readyResult, handle: async () => ({ version: protocolVersion, capabilities: [], epoch: crypto.randomUUID() }) },
    [methods.storageRead]: { params: z.unknown(), result: z.unknown(), handle: () => { received.resolve(); return new Promise(() => {}); } },
  });
  const connection = connectNode(stub, nodeEnd, "test");
  serverEnd.onmessage = server.receive; serverEnd.onclose = server.close;
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  await connection.ready;
  const inFlight = failure(connection.readStorage(read));
  await received.promise;
  serverEnd.close();
  const lost = await inFlight;
  expect(lost).not.toBeInstanceOf(NotConnected);
  expect(lost.outcome).toBe("unknown");
  // Once closed, a new call is not sent.
  expect(await failure(connection.readStorage(read))).toBeInstanceOf(NotConnected);
});
