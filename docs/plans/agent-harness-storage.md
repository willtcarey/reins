# AgentHarness storage migration

Status: **active — step 1 complete**

## Direction

1. Add the public Pi `Storage` adapter against Reins SQLite without changing either runtime. **Implemented in `runtimes/pi/storage-adapter.ts`; not wired.**
2. At a later unified cutover, migrate every existing Pi and Claude history into the harness representation and switch the active writers/readers together. Claude SDK execution remains inert after that cutover, but its stored histories remain available.
3. Remove superseded snapshot persistence only after migration validation.

## Step 1 boundaries

`session_messages` is the only harness entry store. Its integer `id` remains Reins identity; `harness_id` is the exact AgentHarness entry ID and `parent_id` references the actual parent row. Existing `seq` is the AgentHarness global write sequence for entry rows, including intentional gaps for non-entry writes. `message_json` contains the typed entry envelope, including exact commit timestamp, entry type, optional custom type, and the complete message, compaction, branch-summary, or custom payload.

Only contract-required non-entry state is separate in `pi_values`, `pi_lists`, and `pi_usage`: scalar values, list elements, and usage ledger rows. `sessions.harness_next_seq` durably allocates sequences even when deletes leave no row. Mixed commits use one SQLite transaction.

`PiStorageAdapter` is canonical-only storage and assumes every row in an attached session has already been migrated: every entry has a `harness_id`, parent links are real, and `harness_next_seq` is initialized beyond every imported write sequence. It has no legacy classification, fallback, storage-format marker, or dual-mode persistence. Because it remains disconnected, those prerequisites are established only by the future all-session migration before activation.

Reins continues to own session creation, open coalescing, parent relationships, deletion, and lifecycle. At cutover it can construct the supported public session directly with `new StorageBackedSession(metadata, new PiStorageAdapter(db, sessionId))`; closing the harness closes that session and adapter. This step does not add a parallel `SessionRepo` or session factory. The adapter reuses public commit validation/preparation and list option resolution from `@earendil-works/pi-agent-core`.

## Deferred

No runtime wiring, legacy import, UI/API changes, provider behavior, Claude disablement, or production-data operation belongs to this step. The future cutover must migrate all existing sessions before changing runtime writers and readers.
