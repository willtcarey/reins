import { z } from "zod";
import { BACKGROUND_CONTEXT, list as listAddress, value as valueAddress, type Storage, type StoredValue, type Write } from "@earendil-works/pi-agent-core";
import { APPLICATION_ERROR, MAX_ERROR_MESSAGE, RpcFailure, type NodeError, type StorageRead, type StorageReadResult, type StoredAttachment } from "@reins/node-protocol";
import { PiStorageAdapter, piSnapshotSummary, readPiSnapshotPage } from "@reins/pi-sql-storage";
import type { NodeSessionEvent, ServerHandlers } from "../node-transport/server-peer.js";
import { getDb } from "../db.js";
import { getSession, type SessionRow } from "../session-store.js";
import { applyNodeReplica } from "../node-replica.js";
import { getSessionAttachment, storeSessionAttachment } from "../session-attachments-store.js";
import { nodeMayReadSession, nodeOwnsSession } from "../models/session-ownership.js";
import type { NodeCredentialService } from "./node-credentials.js";

/** `event` also receives the session's project, read while fencing it. */
export interface NodeSessionReports extends Pick<ServerHandlers, "started" | "settled"> {
  event(input: NodeSessionEvent & { projectId: number }): void;
}
export type NodeToolCalls = Pick<ServerHandlers, "scriptExecute" | "scriptSearch" | "createTask">;
/** Server-side product services the node hub is created with (`installNodeHub`), so these handlers
 * import no session runtime modules. */
export type NodeServerServices = NodeSessionReports & NodeToolCalls & NodeCredentialService;

/**
 * Node→server calls from node `nodeId` (the ID its connection announced in `node.hello`) run only here,
 * as protocol handlers. Fencing: reports, uploads and tool calls are accepted only for sessions placed
 * on this node, so a node the session was moved away from (or one still hydrating it) cannot write to
 * it; the rejection is definite (`not_owner` as the error data): the node drops what it cannot deliver.
 * Reads are also open while the session is at rest on the server or moving and this node is its
 * destination. Unknown sessions are rejected before any product service runs. Credentials are not per
 * session: any negotiated connection is served.
 */
export function nodeServerHandlers(nodeId: string, services: NodeServerServices): ServerHandlers {
  const owned = (sessionId: string): SessionRow => {
    const row = getSession(sessionId);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    if (!nodeOwnsSession(row, nodeId)) {
      const message = `Node session unavailable: ${sessionId}`;
      throw new RpcFailure(APPLICATION_ERROR, message, undefined, { code: "not_owner", message, retryable: false } satisfies NodeError);
    }
    return row;
  };
  const readable = (sessionId: string) => {
    if (!getSession(sessionId)) throw new Error(`Session not found: ${sessionId}`);
    if (!nodeMayReadSession(sessionId, nodeId)) throw new Error(`Node session unavailable: ${sessionId}`);
  };
  // Session storage is fenced by the session's source alone (placement is not read): the node its source
  // is on reads and writes it. Definite: this node can never serve the session.
  const onThisNode = (sessionId: string) => {
    if (!nodeMayReadSession(sessionId, nodeId)) {
      const message = `Node session unavailable: ${sessionId}`;
      throw new RpcFailure(APPLICATION_ERROR, message, undefined, { code: "not_owner", message, retryable: false } satisfies NodeError);
    }
  };
  return {
    readCredential: providerId => services.readCredential(providerId),
    refreshCredential: providerId => services.refreshCredential(providerId),
    listCredentials: () => services.listCredentials(),
    committed: ({ sessionId, startSeq, writesJson }) => {
      owned(sessionId);
      applyNodeReplica(getDb(), sessionId, startSeq, writesJson);
    },
    started: input => { owned(input.sessionId); return services.started(input); },
    settled: input => { owned(input.sessionId); return services.settled(input); },
    attachment: (sessionId, attachmentId) => {
      readable(sessionId);
      const row = getSessionAttachment(sessionId, attachmentId);
      return row?.data ? { data: row.data, mimeType: row.mime_type, byteSize: row.byte_size,
        sha256: row.sha256, filename: row.filename ?? undefined,
        width: row.width ?? undefined, height: row.height ?? undefined } : null;
    },
    findAttachment: (sessionId, attachmentId): StoredAttachment | null => {
      owned(sessionId);
      const row = getSessionAttachment(sessionId, attachmentId);
      return row?.data ? { attachmentId: row.id, mimeType: row.mime_type, byteSize: row.byte_size, sha256: row.sha256 } : null;
    },
    // Stored under the node-assigned ID; the session attachment store enforces the MIME allowlist and size
    // limit and rejects an ID held with different content or by another session.
    storeAttachment: (sessionId, attachmentId, { data, mimeType, filename, width, height }) => {
      owned(sessionId);
      storeSessionAttachment(sessionId, { id: attachmentId, data, mimeType, filename, width, height });
    },
    // A page of the server's copy with the copy's current summary, which a hydrating node pulls.
    snapshot: (sessionId, fromSeq) => {
      readable(sessionId);
      return { summary: piSnapshotSummary(getDb(), sessionId), ...readPiSnapshotPage(getDb(), sessionId, fromSeq) };
    },
    // The session's canonical Pi storage (ADR-015; unused until the cutover opens runtimes on it).
    // Every call gets a fresh adapter on the server database: nothing is held between calls, and the
    // commit runs Pi's prepareStorageCommit/validateCommittedWrites inside the adapter's transaction.
    storageRead: async input => {
      onThisNode(input.sessionId);
      return refusedByPi(() => readPiStorage(new PiStorageAdapter(getDb(), input.sessionId), input));
    },
    storageCommit: async ({ sessionId, writes }) => {
      onThisNode(sessionId);
      // Pi's writes as the node produced them: the wire schema checked their envelope, Pi validates the rest.
      return refusedByPi(() => new PiStorageAdapter(getDb(), sessionId).commit(z.custom<Write[]>().parse(writes), BACKGROUND_CONTEXT));
    },
    // One read of the session row per live event serves both fencing and the browser frame's project.
    event: input => services.event({ ...input, projectId: owned(input.sessionId).project_id }),
    // Tool calls carry only the session ID; the services derive project/task scope from the server's row.
    scriptExecute: async (input, signal) => { owned(input.sessionId); return services.scriptExecute(input, signal); },
    scriptSearch: input => { owned(input.sessionId); return services.scriptSearch(input); },
    createTask: async input => { owned(input.sessionId); return services.createTask(input); },
  };
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
