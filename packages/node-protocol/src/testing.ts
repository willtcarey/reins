/** `@reins/node-protocol/testing`: test doubles for the node↔server link. Never imported by production code. */
import { RpcFailure, type WireSocket } from "./peer.js";
import type { NodeCommandHandlers } from "./connection.js";

export interface LoopbackSocket extends WireSocket {
  onmessage?: (data: string) => void;
  onclose?: () => void;
  readonly closed: boolean;
}

/** In-memory socket pair with real-socket semantics: string frames, asynchronous delivery, and
 * close observed by both ends. Frames still queued when either end closes are dropped. */
export function createLoopbackPair(): [LoopbackSocket, LoopbackSocket] {
  let closed = false;
  const end = (target: () => LoopbackSocket): LoopbackSocket => ({
    get closed() { return closed; },
    send(data) {
      if (closed) throw new Error("Loopback socket closed");
      if (typeof data !== "string") throw new TypeError("Loopback frames must be strings");
      queueMicrotask(() => { if (!closed) target().onmessage?.(data); });
    },
    close() {
      if (closed) return;
      closed = true;
      queueMicrotask(() => { a.onclose?.(); b.onclose?.(); });
    },
  });
  const a: LoopbackSocket = end(() => b);
  const b: LoopbackSocket = end(() => a);
  return [a, b];
}

/** A scripted node's command handlers: `handlers`, and method-not-found for every other command. */
export function scriptedCommandHandlers(handlers: Partial<NodeCommandHandlers>): NodeCommandHandlers {
  const missing = async (): Promise<never> => { throw new RpcFailure(-32601, "Method not found"); };
  return { prompt: missing, steer: missing, setModel: missing, abort: missing, resumePending: missing, close: missing, delete: missing, listSkills: missing, ...handlers };
}
