import { expect, test } from "bun:test";
import { z } from "zod";
import { connectNode } from "./node-connection.js";
import type { Node } from "./node.js";
import { createLoopbackPair } from "@reins/node-protocol/testing";
import { createRpcPeer, RpcFailure, NodeRejection, nodeError, methods, readyResult } from "@reins/node-protocol";

const binding = { sourceId: 7, cwd: "/tmp/reins-node-connection", createdAt: "2026-01-01T00:00:00.000Z", parentSessionId: null };
const snapshot = { harnessNextSeq: 1, rowCounts: { entries: 0, values: 0, lists: 0, usage: 0 }, digest: "0".repeat(64) };
/** Every server→node command the node serves, with valid params and the method name it is served under. */
const commands = [
  [methods.sessionProvision, { sessionId: "s", binding, configuration: { model: null, thinkingLevel: null, task: null } }, { provisioned: true }],
  [methods.sessionPrompt, { sessionId: "s", binding, clientId: "c", content: [{ type: "text", text: "hi" }], sourceSessionId: null }, { inputId: "c" }],
  [methods.sessionSteer, { sessionId: "s", binding, clientId: "d", content: [], sourceSessionId: "parent" }, { inputId: "d" }],
  [methods.sessionSetModel, { sessionId: "s", binding, provider: "p", modelId: "m" }, { modelSet: true }],
  [methods.sessionAbort, { sessionId: "s", binding }, { aborted: false }],
  [methods.sessionResumePending, { sessionId: "s", binding }, { started: true }],
  [methods.sessionHydrate, { sessionId: "s", binding, task: null, snapshot }, { hydrated: true }],
  [methods.sessionDelete, { sessionId: "s" }, { deleted: true }],
  [methods.skillsList, { sourceId: 7, cwd: "/tmp/reins-node-connection" }, { skills: [{ name: "review", description: "Reviews code" }] }],
] as const;
/** What a stand-in node method does with its params before answering (record them, or throw). */
type OnCall = (input: unknown) => void | Promise<void>;

/** A server that negotiates every capability and sends session commands to a stand-in node whose every
 * method runs `onCall`, so this checks only the wire mapping. */
async function linked(onCall: OnCall) {
  const node: Node = {
    provision: async input => { await onCall(input); return { provisioned: true }; },
    prompt: async input => { await onCall(input); return { inputId: input.clientId }; },
    steer: async input => { await onCall(input); return { inputId: input.clientId }; },
    setModel: async input => { await onCall(input); return { modelSet: true }; },
    abort: async input => { await onCall(input); return { aborted: false }; },
    resumePending: async input => { await onCall(input); return { started: true }; },
    hydrate: async input => { await onCall(input); return { hydrated: true }; },
    delete: async input => { await onCall(input); return { deleted: true }; },
    listSkills: async input => { await onCall(input); return { skills: [{ name: "review", description: "Reviews code" }] }; },
    attach: () => () => {}, shutdown: async () => {},
  };
  const [serverEnd, nodeEnd] = createLoopbackPair();
  const epoch = crypto.randomUUID();
  const server = createRpcPeer(serverEnd, {
    [methods.nodeHello]: { params: z.unknown(), result: readyResult, handle: async () => ({ version: 1, capabilities: commands.map(([method]) => method), epoch }) },
  });
  const connection = connectNode(node, nodeEnd, "test");
  serverEnd.onmessage = server.receive; serverEnd.onclose = server.close;
  nodeEnd.onmessage = connection.receive; nodeEnd.onclose = connection.close;
  await connection.ready;
  const call = (method: string, params: object) => server.call(method, { ...params, epoch }, z.unknown(), { errorData: nodeError });
  return { call, close: () => serverEnd.close() };
}
const failure = (promise: Promise<unknown>) => promise.then(() => { throw new Error("resolved"); }, (error: RpcFailure) => error);

test("each node method is served under its wire method: its params in, its wire result out", async () => {
  const received: unknown[] = [];
  const { call, close } = await linked(input => { received.push(input); });
  try {
    for (const [method, params, expected] of commands) expect(await call(method, params)).toEqual(expected);
    expect(received).toEqual(commands.map(([, params]) => params));
  } finally { close(); }
});

test("a NodeRejection keeps its code on the wire for every command, hydrate included; other exceptions are internal", async () => {
  for (const code of ["not_found", "invalid_request", "busy", "unavailable"] as const) {
    const retryable = code === "unavailable";
    const { call, close } = await linked(() => { throw new NodeRejection(code, `${code} happened`, retryable); });
    try {
      for (const [method, params] of commands) {
        const error = await failure(call(method, params));
        expect({ method, code: error.code, data: error.data }).toEqual({ method, code: -32000, data: { code, message: `${code} happened`, retryable } });
      }
    } finally { close(); }
  }
  const { call, close } = await linked(() => { throw new Error("Node session binding mismatch: s"); });
  try {
    for (const [method, params] of commands) {
      expect((await failure(call(method, params))).data).toEqual({ code: "internal", message: "Node session binding mismatch: s", retryable: false });
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
