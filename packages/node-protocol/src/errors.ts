import { z } from "zod";
import { nodeErrorCode } from "./contract.js";
import { MAX_ERROR_MESSAGE, RpcFailure } from "./peer.js";

/** JSON-RPC code for an application rejection. Node command rejections carry a `NodeError` as
 * `error.data`; exceptions thrown by node command code use `internal`/non-retryable data. */
export const APPLICATION_ERROR = -32000;
export const nodeError = z.strictObject({ code: nodeErrorCode, message: z.string().max(MAX_ERROR_MESSAGE), retryable: z.boolean() });
export type NodeError = z.infer<typeof nodeError>;

/** Replay-safe submitted work was not delivered, or its admission outcome is unknown. The server
 * requeues it. Shared with the process-owned dispatcher so handler reloads preserve error identity. */
export class DeliveryDeferred extends Error {}

/** A definite node rejection of a session command (e.g. `not_found`, `invalid_request`, `busy`,
 * `unavailable`); the node connection sends it as `APPLICATION_ERROR` with `error` as its data. */
export class NodeRejection extends Error {
  readonly error: NodeError;
  constructor(code: NodeError["code"], message: string, retryable = false) {
    super(message);
    this.name = "NodeRejection";
    this.error = { code, message, retryable };
  }
}

/** A failed server call during a node command, as its rejection: an explicit server rejection
 * (`APPLICATION_ERROR`) is definitive; anything else (a transport failure, no connection) may succeed
 * when the command is replayed. */
export function serverCallRejection(error: unknown, what: string): NodeRejection {
  const message = `${what}: ${error instanceof Error ? error.message : String(error)}`;
  return error instanceof RpcFailure && error.code === APPLICATION_ERROR ? new NodeRejection("invalid_request", message) : new NodeRejection("unavailable", message, true);
}
