# Stored message metadata persistence

Status: **implemented; awaiting parent review**

## Scope and implementation

Application annotations live in `metadata?: Record<string, unknown>` on stored message JSON. `attachStoredMessageMetadata()` mutates one current SQLite row; runtime snapshots cannot supply metadata and model-facing projections exclude it.

Metadata continuity uses only the normalized optional `logicalId`. Pi backs this with native `SessionEntry.id`, exposes it on finalized runtime snapshots, and reconstructs its active in-memory entry chain with retained IDs on reopen. Pi strips continuity/application fields from native model messages. Active messages are associated with native entries by object identity, so append-only failed retry entries cannot donate identity to replacement responses. Compaction summaries use the active `CompactionEntry.id`; retained messages keep their message-entry IDs.

Legacy Pi rows without IDs receive native IDs during hydration and persist those IDs at the next checkpoint. There is deliberately no role/timestamp/content migration bridge, so legacy metadata cannot silently move to a guessed message. Runtimes without proven stable message identity conservatively lose metadata on rewritten snapshots. Existing summary-text comparison remains only to recognize repeated legacy compaction boundaries; it never transfers metadata.

No schema/table, plugin registry, HTTP/UI, queue, or Claude runtime redesign is included.

## Validation

Focused tests cover SQLite metadata continuity and exclusion plus real in-memory Pi reopen, duplicate timestamps, retry replacement filtering, compaction identities, and legacy hydration. Full validation is recorded in the implementation report.
