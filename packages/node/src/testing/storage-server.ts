/**
 * TEST HELPER ONLY: the server's side of `storage.read`/`storage.commit` (as the backend serves them in
 * `node-server-handlers.ts`), over Pi's storage in memory (`MemoryStorage`), one per session, created on
 * first use as if the server had created the session. Like the server, it answers a repeat of a session's
 * last applied commit (its `commitId`) with that commit's result. Every request and result is copied
 * through JSON, as it would cross the wire.
 */
import { BACKGROUND_CONTEXT, list as listAddress, value as valueAddress, type Storage, type StoredValue, type Write } from "@earendil-works/pi-agent-core";
import type { StorageRead, StorageReadResult } from "@reins/node-protocol";
import type { StorageServer } from "../remote-storage.js";
import { MemoryStorage } from "./memory-storage.js";

const wire = <T>(value: unknown): T => JSON.parse(JSON.stringify(value));

/** A storage server holding every session's storage in memory; `session(id)` is a session's storage
 * as the server holds it, for assertions. */
export function piStorageServer(): StorageServer & { session(sessionId: string): MemoryStorage } {
  const sessions = new Map<string, MemoryStorage>();
  const lastCommits = new Map<string, { commitId: string; result: unknown }>();
  const session = (sessionId: string) => {
    let storage = sessions.get(sessionId);
    if (!storage) sessions.set(sessionId, storage = new MemoryStorage());
    return storage;
  };
  return {
    session,
    readStorage: async input => wire(await readPiStorage(session(input.sessionId), wire(input))),
    commitStorage: async ({ sessionId, commitId, writes }) => {
      const last = lastCommits.get(sessionId);
      if (last?.commitId === commitId) return wire(last.result);
      const result = await session(sessionId).commit(wire<Write[]>(writes), BACKGROUND_CONTEXT);
      lastCommits.set(sessionId, { commitId, result });
      return wire(result);
    },
  };
}

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
