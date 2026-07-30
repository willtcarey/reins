# Session Message Persistence

Runtime checkpoints are **complete snapshots**, not append-only message events. A runtime may rewrite or shorten its array—for example, Pi removes a failed partial assistant response before inserting a successful retry at the same position.

## Ordering

The runtime persistence observer serializes checkpoint handling in event order. It does not start `getMessages()` for a later checkpoint until the preceding checkpoint has been stored. This is the concurrency boundary: the messages store does not infer whether one valid snapshot is newer than another from message contents.

Non-checkpoint activity events remain immediate.

## Active transcript projection

`persistMessages(sessionId, messages)` treats its input as the authoritative runtime snapshot. The rows in the active transcript window are a mutable projection of that snapshot:

- matching prefix rows remain unchanged;
- changed positions are updated in place;
- additional positions are inserted;
- positions removed from the snapshot are deleted.

The synchronization occurs in one SQLite transaction. Updating by position retains row IDs and sequence values where possible, preserving display parent links and pagination cursors. Attachment references removed by a rewrite are pruned after the projection is updated.

Persistence deliberately does not inspect `stopReason` or tool-call IDs to decide which snapshot should win. Those are message-domain details and cannot reliably establish checkpoint ordering.

## Compaction

Rows before the latest compaction summary are archived history and remain append-only. A new compaction summary and its retained tail are appended as a new active window. Later snapshots with that same summary synchronize only that active window.

As before, storing a compaction boundary replaces pre-boundary tool-result content with `[pruned]`, and `loadMessagesForLLM()` returns only the latest summary and its tail. Paginated display APIs continue to include archived rows.
