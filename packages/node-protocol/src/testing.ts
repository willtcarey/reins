/** `@reins/node-protocol/testing`: test doubles for the node↔server link. Never imported by production code. */
import { METHOD_NOT_FOUND, RpcFailure, type LinkSocket } from "./rpc.js";
import type { NodeCommandHandlers } from "./node-connection.js";

/** In-memory socket pair with real-socket semantics: string frames, asynchronous delivery, and
 * close observed by both ends. Frames still queued when either end closes are dropped. */
export function createLoopbackPair(): [LinkSocket, LinkSocket] {
  let closed = false;
  const end = (target: () => LinkSocket): LinkSocket => ({
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
  const a: LinkSocket = end(() => b);
  const b: LinkSocket = end(() => a);
  return [a, b];
}

/** A scripted node's command handlers: `handlers`, and method-not-found for every other command. */
export function scriptedCommandHandlers(handlers: Partial<NodeCommandHandlers>): NodeCommandHandlers {
  const missing = async (): Promise<never> => { throw new RpcFailure(METHOD_NOT_FOUND, "Method not found"); };
  return { prompt: missing, steer: missing, setModel: missing, abort: missing, resumePending: missing, close: missing, listSkills: missing, runProcess: missing, listDirectory: missing, readFile: missing, writeFile: missing, ...handlers };
}
