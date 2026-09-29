import { APPLICATION_ERROR, nodeError, RpcFailure, deliveryPolicy, type LaneSeed, type NodeCommand, type NodeResult, type NodeSessionBinding, type SessionTask } from "@reins/node-protocol";
import { DeliveryDeferred } from "../models/node-command-delivery.js";
import type { createServerTransport } from "./server-peer.js";

export type NodeCommandClient = Pick<ReturnType<typeof createServerTransport>, "prompt" | "steer" | "setModel" | "abort" | "resumePending" | "closeSession" | "listSkills">;
/**
 * Per-call bounds (ms). Submitted work waits for the node's admission, not for the run: prompt/steer
 * may fetch attachments (each 512 KiB chunk its own 30s call), check out the task branch and open Pi over
 * the server's storage; setModel and resumePending may open the runtime. Abort waits for the aborted run
 * to go idle; close for the closed runtime. A timeout leaves the outcome unknown: submitted work is
 * requeued and its replay converges; controls fail. `skills.list` is a short read-only request a browser
 * waits for.
 */
export interface NodeCommandTimeouts { input: number; setModel: number; abort: number; resumePending: number; close: number; skills: number }
/** The open links of connected nodes, by node ID, and the per-call bounds (the node hub). */
export interface NodeLinks {
  link(nodeId: string): NodeCommandClient | undefined;
  readonly timeouts: NodeCommandTimeouts;
}
export const NODE_COMMAND_TIMEOUTS: NodeCommandTimeouts = { input: 120_000, setModel: 60_000, abort: 30_000, resumePending: 60_000, close: 30_000, skills: 5_000 };

// Busy/stale-epoch/unnegotiated rejections happen before the node's handler runs; lost connections and
// timeouts leave the outcome unknown.
const NOT_RUN = new Set<RpcFailure["code"]>(["unavailable", -32002, -32003]);

/**
 * Maps a wire command to the node's NodeResult: success is its value; a node rejection (`-32000` with a
 * NodeResult error as `error.data`) keeps the node's code. When the node did not run the command, or may
 * have run it (timeout, lost connection): `replayable` work throws DeliveryDeferred so the outbox
 * requeues it (safe because every submitted op converges on replay; see node-contract.md), and an
 * immediate control returns `unavailable` to its caller, never retried. Other protocol failures
 * (e.g. `-32602` invalid params) are rethrown as terminal delivery exceptions.
 */
export async function commandOutcome(replayable: boolean, call: () => Promise<Extract<NodeResult, { ok: true }>["value"]>): Promise<NodeResult> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (!(error instanceof RpcFailure)) throw error;
    const rejected = error.code === APPLICATION_ERROR ? nodeError.safeParse(error.data) : undefined;
    if (rejected?.success) return { ok: false, error: rejected.data };
    if (error.outcome !== "unknown" && !NOT_RUN.has(error.code)) throw error;
    if (replayable) throw new DeliveryDeferred(error.message);
    return { ok: false, error: { code: "unavailable", message: `Node unavailable: ${error.message}`, retryable: true } };
  }
}

/** The node's link is not open: nothing was sent (submitted work is deferred, a control is `unavailable`). */
function linked(client: NodeCommandClient | undefined): NodeCommandClient {
  if (!client) throw new RpcFailure("unavailable", "Node not connected");
  return client;
}

/** Where a session's command runs, resolved from product rows when it is delivered: its binding, and the
 * task snapshot (null: a scratch session) and lane seed an opening command carries. */
export interface CommandTarget { binding: NodeSessionBinding; task: SessionTask; lane: LaneSeed }

/**
 * Sends one semantic command over the node's link (`undefined` when it has none). Submitted work carries
 * no outbox ID: the node keeps no per-command state and a replay converges on the command's own state.
 */
export function sendNodeCommand(link: NodeCommandClient | undefined, command: NodeCommand, { binding, task, lane }: CommandTarget, timeouts: NodeCommandTimeouts): Promise<NodeResult> {
  const { sessionId } = command;
  return commandOutcome(deliveryPolicy(command) === "submit-work", async () => {
    const client = linked(link);
    switch (command.op) {
      case "session.prompt":
      case "session.steer": {
        const input = { sessionId, binding, task, lane, clientId: command.clientId, content: command.content, sourceSessionId: command.sourceSessionId };
        const { inputId } = await (command.op === "session.prompt" ? client.prompt(input, timeouts.input) : client.steer(input, timeouts.input));
        return { kind: "admitted", inputId };
      }
      case "session.setModel":
        await client.setModel({ sessionId, binding, task, lane, provider: command.provider, modelId: command.modelId,
          ...(command.thinkingLevel === undefined ? {} : { thinkingLevel: command.thinkingLevel }) }, timeouts.setModel);
        return { kind: "modelSet" };
      case "session.abort":
        return { kind: "aborted", aborted: (await client.abort({ sessionId, binding }, timeouts.abort)).aborted };
      case "session.resumePending":
        return { kind: "resumed", started: (await client.resumePending({ sessionId, binding, task, lane }, timeouts.resumePending)).started };
    }
  });
}
