import { APPLICATION_ERROR, MAX_ERROR_MESSAGE, RpcFailure, type NodeError, type StorageCommit, type StorageCommitResult, type StorageRead, type StorageReadResult } from "@reins/node-protocol";
import type { SessionModel } from "../models/session.js";

/**
 * The server half of the node's `RemoteStorage`: `storage.read`/`storage.commit` against the session's
 * canonical Pi storage (ADR-015, `SessionModel.readStorage`/`commitStorage`). The caller has fenced the
 * session. A read or commit Pi's storage refuses is a definite `invalid_request`.
 */
export function readStorage(session: SessionModel, read: StorageRead): Promise<StorageReadResult> {
  return refusedByPi(() => session.readStorage(read));
}

export function commitStorage(session: SessionModel, commit: StorageCommit): Promise<StorageCommitResult> {
  return refusedByPi(() => session.commitStorage(commit));
}

/** A read or commit Pi's storage refused (a duplicate ID or missing parent from a stale or concurrent
 * writer, an unknown branch entry, an invalid list limit) is definite: the node must not retry it. */
async function refusedByPi<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_MESSAGE);
    throw new RpcFailure(APPLICATION_ERROR, message, undefined, { code: "invalid_request", message, retryable: false } satisfies NodeError);
  }
}
