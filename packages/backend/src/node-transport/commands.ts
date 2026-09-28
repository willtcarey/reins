import { APPLICATION_ERROR, nodeError, RpcFailure, deliveryPolicy, type SessionHydrate, type NodeCommand, type NodeResult, type NodeSessionBinding } from "@reins/node-protocol";
import { DeliveryDeferred } from "../models/node-command-delivery.js";
import type { createServerTransport } from "./server-peer.js";

export type NodeCommandClient = Pick<ReturnType<typeof createServerTransport>, "provision" | "prompt" | "steer" | "setModel" | "abort" | "resumePending" | "hydrate" | "delete" | "listSkills">;
/**
 * Per-call bounds (ms). Submitted work waits for the node's admission, not for the run: prompt/steer
 * may fetch attachments (each 512 KiB chunk its own 30s call), check out the task branch and build Pi;
 * setModel and resumePending may open the runtime. Abort waits for the aborted run to go idle. A timeout
 * leaves the outcome unknown: submitted work is requeued and its replay converges; controls fail.
 * `skills.list` is a short read-only request a browser waits for.
 */
export interface NodeCommandTimeouts { provision: number; input: number; setModel: number; abort: number; resumePending: number; hydrate: number; delete: number; skills: number }
/** The open links of connected nodes, by node ID, and the per-call bounds (the node hub). */
export interface NodeLinks {
  link(nodeId: string): NodeCommandClient | undefined;
  readonly timeouts: NodeCommandTimeouts;
}
/** Hydration pulls the whole session (each snapshot page and attachment chunk its own 30s call), so it
 * gets 10 minutes. */
export const NODE_COMMAND_TIMEOUTS: NodeCommandTimeouts = { provision: 30_000, input: 120_000, setModel: 60_000, abort: 30_000, resumePending: 60_000, hydrate: 600_000, delete: 30_000, skills: 5_000 };

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

/** The node's link is not open: nothing was sent (submitted work is deferred, a control is unavailable). */
function linked(client: NodeCommandClient | undefined): NodeCommandClient {
  if (!client) throw new RpcFailure("unavailable", "Node not connected");
  return client;
}

/** What `session.hydrate` carries besides the binding, resolved when the command is delivered. */
export type HydrationPayload = Pick<SessionHydrate, "task" | "snapshot">;

/** Sends one semantic command over the node's link (`undefined` when it has none); `session.hydrate`
 * also takes its `hydration` payload. Submitted work (a hydrate included: replays converge by content)
 * carries no outbox ID: the node keeps no per-command state and a replay converges on the command's own
 * state. */
export function sendNodeCommand(link: NodeCommandClient | undefined, command: NodeCommand, binding: NodeSessionBinding, timeouts: NodeCommandTimeouts, hydration?: HydrationPayload): Promise<NodeResult> {
  const { sessionId } = command;
  return commandOutcome(deliveryPolicy(command) === "submit-work", async () => {
    const client = linked(link);
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
        if (!hydration) throw new Error("session.hydrate is sent with its hydration payload");
        await client.hydrate({ sessionId, binding, ...hydration }, timeouts.hydrate);
        return { kind: "hydrated" };
    }
  });
}
