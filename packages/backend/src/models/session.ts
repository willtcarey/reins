/**
 * One session as its node works with it (`SessionModel`, from `Sessions.get`): where it runs, what a
 * call that may open its runtime carries (`SessionContext`), its attachments and its Pi storage, the only
 * copy of the session (ADR-015). Who may make these calls (the session's own node) is checked by the
 * caller.
 */
import { z } from "zod";
import { BACKGROUND_CONTEXT, list as listAddress, value as valueAddress, type Storage, type StoredValue, type Write } from "@earendil-works/pi-agent-core";
import type { LaneSeed, NodeSessionBinding, SessionRuntime, StorageCommit, StorageCommitResult, StorageRead, StorageReadResult } from "@reins/node-protocol";
import type { SessionRow } from "../session-store.js";
import type { Source } from "../node-store.js";
import { getTask } from "../task-store.js";
import { getSessionAttachment, storeSessionAttachment, type SessionAttachmentRow, type StoreSessionAttachmentInput } from "../session-attachments-store.js";
import { PiStorageAdapter } from "../pi-storage.js";
import { getDb } from "../db.js";
import { sessionKind } from "../sessions/session-kinds.js";
import { piModelSetting } from "./model-settings.js";
import { sessionSource } from "./sources.js";

/** The session's context as its node needs it to run the session, carried by every call that may open
 * its runtime (its outbox commands, `session.resumePending`): the binding, the lane seed, and what the
 * session's kind resolves, the runtime configuration (with the server's system prompt) and the branch the
 * node checks out first (null: none). No server DB handle reaches node code. */
export interface SessionContext { binding: NodeSessionBinding; branch: string | null; lane: LaneSeed; runtime: SessionRuntime }

/** One session, as its row was when it was read. */
export class SessionModel {
  constructor(readonly row: SessionRow) {}

  get id(): string { return this.row.id; }
  get projectId(): number { return this.row.project_id; }

  /** Where the session runs: its source, or null when that is gone. */
  source(): Source | null {
    return sessionSource(this.row);
  }

  /** The node binding every session call carries: where the session runs (its source's checkout) and the
   * identity Pi's session is created with. Product identity and path resolution stay server-side. */
  binding(source: Source): NodeSessionBinding {
    return { sourceId: source.id, cwd: source.path, createdAt: this.row.created_at, parentSessionId: this.row.parent_session_id };
  }

  /** The session's context (`SessionContext`) in `source`, built from the rows now, so task and prompt edits
   * reach the node the next time it opens the runtime; throws when the lane seed cannot be built (an
   * unusable `default_model`) or the session's kind is unknown. */
  context(source: Source): SessionContext {
    const task = this.row.task_id === null ? null : getTask(this.row.task_id);
    const { branch = null, ...runtime } = sessionKind(this.row.kind)({ session: this.row, task });
    return { binding: this.binding(source), branch, lane: laneSeed(this.row), runtime };
  }

  /** The session's attachment `attachmentId`, its bytes null once pruned; null when it has none by that ID. */
  attachment(attachmentId: string): SessionAttachmentRow | null {
    return getSessionAttachment(this.id, attachmentId);
  }

  /** Stores an attachment under the ID its node assigned. The store enforces the MIME allowlist and size
   * limit and rejects an ID held with different content or by another session. */
  storeAttachment(attachment: StoreSessionAttachmentInput & { id: string }): void {
    storeSessionAttachment(this.id, attachment);
  }

  /** One `storage.read` of the session's Pi storage, as its wire result (`Map`s as arrays, no value as
   * null). Every call gets a fresh adapter on the server database: nothing is held between calls. */
  readStorage(read: StorageRead): Promise<StorageReadResult> {
    return readPiStorage(new PiStorageAdapter(getDb(), this.id), read);
  }

  /** Pi's writes as the node produced them, committed once: Pi's prepareStorageCommit and
   * validateCommittedWrites run inside the adapter's transaction. A resend of the session's last applied
   * commit (its `commitId`) is answered with that commit's result. */
  commitStorage({ commitId, writes }: Omit<StorageCommit, "sessionId">): Promise<StorageCommitResult> {
    return new PiStorageAdapter(getDb(), this.id).commitOnce(commitId, z.custom<Write[]>().parse(writes));
  }
}

/** A stored thinking level as the wire carries it: `off` is null. */
const thinking = (level: string | null) => level && level !== "off" ? level : null;

/** The model Pi's main lane starts with if the session has none yet (the node seeds it when it opens the
 * runtime): the row's, else the current `default_model` setting's (with its thinking level); a null model
 * when neither resolves. The server does not validate it: the node's model registry does. */
function laneSeed(row: SessionRow): LaneSeed {
  if (row.model_provider && row.model_id) return { model: { provider: row.model_provider, modelId: row.model_id }, thinkingLevel: thinking(row.thinking_level) };
  const defaultModel = piModelSetting("default_model");
  if (!defaultModel) return { model: null, thinkingLevel: null };
  return { model: { provider: defaultModel.provider, modelId: defaultModel.modelId }, thinkingLevel: thinking(defaultModel.thinkingLevel) };
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
