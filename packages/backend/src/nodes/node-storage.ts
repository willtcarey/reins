import { z } from "zod";
import { BACKGROUND_CONTEXT, list as listAddress, value as valueAddress, type Storage, type StoredValue, type Write } from "@earendil-works/pi-agent-core";
import { APPLICATION_ERROR, MAX_ERROR_MESSAGE, RpcFailure, type NodeError, type StorageCommit, type StorageCommitResult, type StorageRead, type StorageReadResult } from "@reins/node-protocol";
import { PiStorageAdapter } from "../pi-storage.js";
import { getDb } from "../db.js";

/**
 * The server half of the node's `RemoteStorage`: `storage.read`/`storage.commit` against the session's
 * canonical Pi storage (ADR-015). The caller has fenced the session. Every call gets a fresh adapter on
 * the server database: nothing is held between calls, and the commit runs Pi's
 * prepareStorageCommit/validateCommittedWrites inside the adapter's transaction. A read or commit Pi's
 * storage refuses is a definite `invalid_request`.
 */
export function readStorage(read: StorageRead): Promise<StorageReadResult> {
  return refusedByPi(() => readPiStorage(new PiStorageAdapter(getDb(), read.sessionId), read));
}

/** Pi's writes as the node produced them: the wire schema checked their envelope, Pi validates the rest. */
export function commitStorage({ sessionId, writes }: StorageCommit): Promise<StorageCommitResult> {
  return refusedByPi(() => new PiStorageAdapter(getDb(), sessionId).commit(z.custom<Write[]>().parse(writes), BACKGROUND_CONTEXT));
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

/** One `storage.read` against Pi's storage, as its wire result (`Map`s as arrays, no value as null). */
async function readPiStorage(storage: Storage, read: StorageRead): Promise<StorageReadResult> {
  switch (read.op) {
    case "getEntries": return { op: read.op, entries: [...(await storage.getEntries(read.args.ids, BACKGROUND_CONTEXT)).values()] };
    case "getValue": {
      const stored = await storage.getValue(valueAddress(read.args.namespace, read.args.key), BACKGROUND_CONTEXT);
      return { op: read.op, value: stored ? wireValue(stored) : null };
    }
    case "scanValues": return { op: read.op, values: (await storage.scanValues(valueAddress(read.args.namespace, read.args.key), BACKGROUND_CONTEXT)).map(wireValue) };
    case "readList": return { op: read.op, elements: await storage.readList(listAddress(read.args.namespace, read.args.key), read.args.options, BACKGROUND_CONTEXT) };
    case "scanBranch": return { op: read.op, entries: await storage.scanBranch(read.args, BACKGROUND_CONTEXT) };
    case "scanBranchStructure": return { op: read.op, entries: await storage.scanBranchStructure(read.args, BACKGROUND_CONTEXT) };
    case "scanEntries": return { op: read.op, entries: await storage.scanEntries(read.args, BACKGROUND_CONTEXT) };
    case "scanUsage": return { op: read.op, rows: await storage.scanUsage(read.args, BACKGROUND_CONTEXT) };
    case "getStats": return { op: read.op, stats: await storage.getStats(BACKGROUND_CONTEXT) };
  }
}

const wireValue = ({ address, value, seq }: StoredValue<unknown>) => ({ namespace: address.namespace, key: address.key, value, seq });
