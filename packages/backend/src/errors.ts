/**
 * HTTP Error Helpers
 *
 * Throw HttpError from any route handler — the router catches it
 * and returns the appropriate JSON error response automatically.
 */

import { RpcFailure } from "@reins/node-protocol";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Whether `error` is a node the request needed being unreachable: not connected, not answering in time,
 * or its link dropping mid-call (a `RemoteNode` call's or stream's `RpcFailure` with code
 * `"unavailable"`). The router answers these 503.
 */
export function isNodeUnavailable(error: unknown): boolean {
  return error instanceof RpcFailure && error.code === "unavailable";
}

/**
 * Throw a 400 Bad Request.
 */
export function badRequest(message: string): never {
  throw new HttpError(400, message);
}

/**
 * Throw a 404 Not Found.
 */
export function notFound(message: string): never {
  throw new HttpError(404, message);
}

/**
 * Throw a 409 Conflict.
 */
export function conflict(message: string): never {
  throw new HttpError(409, message);
}
