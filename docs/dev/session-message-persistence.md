# Session Message Persistence

Runtime checkpoints are **complete snapshots**, not append-only message events. A runtime may rewrite or shorten its array—for example, Pi removes a failed partial assistant response before inserting a successful retry at the same position.

## Ordering

The runtime persistence observer serializes checkpoint handling in event order. It does not start `getMessages()` for a later checkpoint until the preceding checkpoint has been stored. Terminal non-checkpoint boundaries such as settlement-aware `agent_settled` also wait behind that queue before broadcasting finished activity. This is the concurrency boundary: the messages store does not infer whether one valid snapshot is newer than another from message contents.

Non-checkpoint activity events remain immediate. All sessions, including parented sessions with or without a task, persist and broadcast their own running/finished activity. Parent links do not suppress lifecycle updates; active child-session views need terminal metadata for reconciliation.

The observer exposes `flush()` on its detach handle to await the current checkpoint queue. Session-ID waits call it after runtime settlement and recheck runtime activity before returning a result. Runtime close flushes checkpoints before detaching observers. Neither operation adds synthetic transcript entries or a separate execution-result store.

## Stored ancestry and identity

`session_messages.id` remains the SQLite integer row identity used by message pages and pagination. Each row also has:

- nullable `parent_id`, a self-referencing foreign key with `ON DELETE SET NULL`;
- nullable `harness_id`, protected by a partial unique index within its session when present.

Existing rows are migrated into a linear chain per session in `seq` order. New persistence writes explicitly link each row to the preceding row in that session. Reins does not currently populate `harness_id`: existing and newly persisted messages leave it null rather than deriving an identity from runtime fields. Message pages project the stored parent relationship while continuing to expose integer row IDs as strings, so public UI identity is unchanged.

The foreign key prevents dangling parent references. Deleting an individual parent makes its direct children parentless rather than recursively deleting their subtree. Current production transcript deletion remains limited to active-window suffix truncation and whole-session/task cleanup; this change does not add arbitrary message or branch deletion behavior.

## Active transcript projection

`persistMessages(sessionId, messages)` treats its input as the authoritative runtime snapshot. The rows in the active transcript window are a mutable projection of that snapshot:

- matching prefix rows remain unchanged;
- changed positions are updated in place without changing stored ancestry;
- additional positions are inserted and linked from the existing tail;
- positions removed from the snapshot are deleted as one suffix.

The synchronization occurs in one SQLite transaction. Updating by position retains row IDs, parent IDs, and sequence values where possible, preserving display relationships and pagination cursors. Suffix deletion removes descendants in the stored linear active window; the foreign-key policy prevents dangling ancestry if other direct children ever exist. Attachment references removed by a rewrite are pruned after the projection is updated.

Persistence deliberately does not inspect `stopReason` or tool-call IDs to decide which snapshot should win. Those are message-domain details and cannot reliably establish checkpoint ordering.

## Stored message metadata

`metadata?: Record<string, unknown>` is application-owned stored JSON, with feature keys directly inside it. `attachStoredMessageMetadata(sessionId, messageId, namespace, value)` attaches a JSON-serializable value by current SQLite row ID; existing full-message/display reads expose it. There is no registry, separate table, or metadata reader. Runtime snapshots cannot write this field, and `loadMessagesForLLM()` removes it before provider hydration. Pi uses that shared projection; Claude additionally constructs SDK entries from explicit provider fields.

Ordinary reconciliation restores metadata only at the same position with an exact matching `logicalId`. Changed content or stop reason does not break continuity. Different or absent identities do not inherit metadata, despite retaining SQLite row IDs; truncation deletes metadata with its row. Attachment requires a non-empty `logicalId`.

Pi supplies `logicalId` from its native `SessionEntry.id`. On reopen, Reins reconstructs Pi's active entry chain with those IDs and strips `logicalId` before messages enter model context. Legacy Pi messages receive fresh native IDs during hydration and gain stable identity at the next finalized snapshot; no timestamp/content bridge transfers existing metadata. Other runtimes currently lack a proven stable identity and therefore conservatively do not preserve metadata through snapshot rewrites.

## Compaction

Rows before the latest compaction summary are archived history and remain append-only. A new compaction summary and its retained tail are appended as a new active window. Later snapshots with that same summary synchronize only that active window.

When a new summary is appended, metadata follows retained messages by exact `logicalId`. Omitted messages keep metadata on their archived display rows. Messages without IDs never receive transferred metadata. Archived JSON otherwise remains unchanged, apart from the existing pre-boundary tool-result pruning.

As before, storing a compaction boundary replaces pre-boundary tool-result content with `[pruned]`, and `loadMessagesForLLM()` returns only the latest summary and its tail. Paginated display APIs continue to include archived rows.
