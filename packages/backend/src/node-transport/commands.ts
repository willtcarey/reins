import { APPLICATION_ERROR, nodeError, RpcFailure, type SessionHydrate } from "@reins/node/protocol";
import { deliveryPolicy, type NodeCommand, type NodeResult } from "@reins/node/contract";
import type { NodeSessionBinding } from "@reins/node/storage";
import { DeliveryDeferred } from "../models/node-command-transport.js";
import type { createServerTransport } from "./server-peer.js";

export type NodeCommandClient = Pick<ReturnType<typeof createServerTransport>, "provision" | "prompt" | "steer" | "setModel" | "abort" | "resumePending" | "hydrate">;
/**
 * Per-call bounds (ms). Submitted work waits for the node's admission, not for the run: prompt/steer
 * may fetch attachments (each 512 KiB chunk its own 30s call), check out the task branch and build Pi;
 * setModel and resumePending may open the runtime. Abort waits for the aborted run to go idle. A timeout
 * leaves the outcome unknown: submitted work is requeued and its replay converges; controls fail.
 */
export interface NodeCommandTimeouts { provision: number; input: number; setModel: number; abort: number; resumePending: number; hydrate: number }
/** Hydration pulls the whole session (each snapshot page and attachment chunk its own 30s call), so it
 * gets 10 minutes. */
export const NODE_COMMAND_TIMEOUTS: NodeCommandTimeouts = { provision: 30_000, input: 120_000, setModel: 60_000, abort: 30_000, resumePending: 60_000, hydrate: 600_000 };

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

/** Sends one semantic command over the wire. Submitted work must come from an outbox row (`commandId`);
 * the ID is not sent: the node keeps no per-command state and a replay converges on the command's own
 * state. Immediate controls have none. */
export function sendNodeCommand(connect: () => Promise<NodeCommandClient>, command: NodeCommand, binding: NodeSessionBinding, commandId: string | undefined, timeouts: NodeCommandTimeouts = NODE_COMMAND_TIMEOUTS): Promise<NodeResult> {
  const submitted = deliveryPolicy(command) === "submit-work";
  if (submitted && !commandId) throw new Error(`${command.op} requires an outbox command ID`);
  const { sessionId } = command;
  return commandOutcome(submitted, async () => {
    const client = await connect();
    switch (command.op) {
      case "session.provision":
        await client.provision({ sessionId, binding, configuration: command.configuration }, timeouts.provision);
        return { kind: "provisioned" };
      case "session.prompt":
      case "session.steer": {
        const input = { sessionId, binding, clientId: command.clientId, content: command.content, sourceSessionId: command.sourceSessionId };
        const { inputId } = await (command.op === "session.prompt" ? client.prompt(input, timeouts.input) : client.steer(input, timeouts.input));
        return { kind: "admitted", inputId };
      }
      case "session.setModel":
        await client.setModel({ sessionId, binding, provider: command.provider, modelId: command.modelId,
          ...(command.thinkingLevel === undefined ? {} : { thinkingLevel: command.thinkingLevel }) }, timeouts.setModel);
        return { kind: "modelSet" };
      case "session.abort":
        return { kind: "aborted", aborted: (await client.abort({ sessionId, binding }, timeouts.abort)).aborted };
      case "session.resumePending":
        return { kind: "resumed", started: (await client.resumePending({ sessionId, binding }, timeouts.resumePending)).started };
      case "session.hydrate":
        throw new Error(`${command.op} is sent with sendRelocationCommand`);
    }
  });
}

/** What `session.hydrate` carries besides the binding, resolved when the command is delivered. */
export type HydrationPayload = Pick<SessionHydrate, "task" | "snapshot">;
/**
 * Sends `session.hydrate`. It is submitted work (replays converge by content on the node), so an unknown
 * outcome throws DeliveryDeferred; a node rejection is returned as its NodeResult. `commandId` (its outbox
 * row) is not sent, as for other submitted work.
 */
export function sendRelocationCommand(connect: () => Promise<NodeCommandClient>, command: Extract<NodeCommand, { op: "session.hydrate" }>, binding: NodeSessionBinding, _commandId: string, hydration: HydrationPayload, timeouts: NodeCommandTimeouts = NODE_COMMAND_TIMEOUTS): Promise<NodeResult> {
  const { sessionId } = command;
  return commandOutcome(true, async () => {
    const client = await connect();
    await client.hydrate({ sessionId, binding, ...hydration }, timeouts.hydrate);
    return { kind: "hydrated" };
  });
}
