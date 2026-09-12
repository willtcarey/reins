# Session Message Persistence

Runtime checkpoints are **complete snapshots**, not append-only message events. A runtime may rewrite or shorten its array—for example, Pi removes a failed partial assistant response before inserting a successful retry at the same position.

## Ordering

The runtime persistence observer serializes checkpoint handling in event order. It does not start `getMessages()` for a later checkpoint until the preceding checkpoint has been stored. Terminal non-checkpoint boundaries such as settlement-aware `agent_settled` also wait behind that queue before broadcasting finished activity. This is the concurrency boundary: the messages store does not infer whether one valid snapshot is newer than another from message contents.

Non-checkpoint activity events remain immediate. All sessions, including parented sessions with or without a task, persist and broadcast their own running/finished activity. Parent links do not suppress lifecycle updates; active child-session views need terminal metadata for reconciliation.

The observer exposes `flush()` on its detach handle to await the current checkpoint queue. Session-ID waits call it after runtime settlement and recheck runtime activity before returning a result. Runtime close flushes checkpoints before detaching observers. Neither operation adds synthetic transcript entries or a separate execution-result store.

## Active transcript projection

`persistMessages(sessionId, messages)` treats its input as the authoritative runtime snapshot. The rows in the active transcript window are a mutable projection of that snapshot:

- matching prefix rows remain unchanged;
- changed positions are updated in place;
- additional positions are inserted;
- positions removed from the snapshot are deleted.

The synchronization occurs in one SQLite transaction. Updating by position retains row IDs and sequence values where possible, preserving display parent links and pagination cursors. Attachment references removed by a rewrite are pruned after the projection is updated.

Persistence deliberately does not inspect `stopReason` or tool-call IDs to decide which snapshot should win. Those are message-domain details and cannot reliably establish checkpoint ordering.

## Stored message metadata

`metadata?: Record<string, unknown>` is application-owned stored JSON, with feature keys directly inside it. `attachStoredMessageMetadata(sessionId, messageId, namespace, value)` attaches a JSON-serializable value by current SQLite row ID; existing full-message/display reads expose it. There is no registry, separate table, or metadata reader. Runtime snapshots cannot write this field, and `loadMessagesForLLM()` removes it before provider hydration. Pi uses that shared projection; Claude additionally constructs SDK entries from explicit provider fields.

Ordinary reconciliation restores metadata only at the same position with an exact matching `logicalId`. Changed content or stop reason does not break continuity. Different or absent identities do not inherit metadata, despite retaining SQLite row IDs; truncation deletes metadata with its row. Attachment requires a non-empty `logicalId`.

Pi supplies `logicalId` from its native `SessionEntry.id`. On reopen, Reins reconstructs Pi's active entry chain with those IDs and strips `logicalId` before messages enter model context. Legacy Pi messages receive fresh native IDs during hydration and gain stable identity at the next finalized snapshot; no timestamp/content bridge transfers existing metadata. Other runtimes currently lack a proven stable identity and therefore conservatively do not preserve metadata through snapshot rewrites.

## Compaction

Rows before the latest compaction summary are archived history and remain append-only. A new compaction summary and its retained tail are appended as a new active window. Later snapshots with that same summary synchronize only that active window.

When a new summary is appended, metadata follows retained messages by exact `logicalId`. Omitted messages keep metadata on their archived display rows. Messages without IDs never receive transferred metadata. Archived JSON otherwise remains unchanged, apart from the existing pre-boundary tool-result pruning.

As before, storing a compaction boundary replaces pre-boundary tool-result content with `[pruned]`, and `loadMessagesForLLM()` returns only the latest summary and its tail. Paginated display APIs continue to include archived rows.
