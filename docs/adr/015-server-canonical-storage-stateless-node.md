# ADR-015: Server-Canonical Session Storage and a Stateless Node

- **Status:** Accepted
- **Date:** 2026-09-29
- **Author:** Will (with Claude)
- **Supersedes:** [ADR-008](008-server-hub-session-relocation.md), [ADR-009](009-node-canonical-storage-server-replica.md), [ADR-011](011-placement-status-single-source-of-truth.md); narrows [ADR-010](010-state-derived-idempotency.md)

## Context

The local process split ([node-local-process-split](../plans/completed/node-local-process-split.md)) gave the node canonical AgentHarness storage in its own SQLite and made the server keep an exact ordered replica (ADR-009). Keeping two copies consistent without receipts is what most of the node code does: sequence watermarks and batch hashes, a durable node outbox, hydrate and snapshot paging for relocation, a five-state `placement_status`, `not_owner` fencing, deletion propagation to every node, and node-owned migrations. Roughly 8,000 non-test lines and 10,000 test lines exist to serve it, and the open items it left (crash recovery, cross-node moves, moving active sessions, node backups) are all consequences of the second copy.

ADR-009 rejected server-canonical storage because "every Pi commit and read during a run would cross the link; a slow or dropped link would stall or fail runs". Measurements on the current adapter (see the [node architecture plan](../plans/node-architecture.md) *Measurements*) show what that costs: a run with three tool calls makes 40 to 70 storage calls, most of them sub-kilobyte commits. Over the local Unix socket that is 10 to 30 ms per run. At 40 ms per call it is 3.8 s. Pi's `Storage` interface is fully asynchronous and Pi ships `MemoryStorage`, `StorageDecorator` and a storage conformance suite, so a remote adapter needs no changes to Pi.

## Decision

**The server's SQLite is the only canonical session storage. The node holds no durable session state.**

- The node's Pi runtime uses a `Storage` implementation that forwards every read and every commit to the server over the existing link (`storage.read`, `storage.commit`). The server applies commits with Pi's own `prepareStorageCommit`/`validateCommittedWrites` inside one transaction, so the sequence check that rejects a stale or concurrent writer runs where the data lives.
- A run needs its server. A rejected commit or a lost link fails the run; the node drops the runtime; the server's copy is consistent through the last applied commit. This is the same failure class as losing the model provider mid-run.
- The node keeps only in-memory state for open runtimes, an attachment cache and an in-memory credential cache. It has no SQLite, no migrations and no outbox. Closing an idle runtime frees everything it held.
- Session creation writes the main lane on the server. There is no `session.provision`. Placement is the session's `source_id`; moving a session is one `UPDATE` when it is idle, plus a `session.close` to the node that held it.
- Forks and tree navigation are server-side operations over the canonical copy (Pi's `createForkSnapshot` needs only a `SessionReader`); no node is involved.
- Idempotency of server→node commands (ADR-010: prompt/steer converge on Pi's durable input keyed by `reinsId`) stays. Replica watermarks, report hashes and hydrate convergence go away with the copies they reconciled.

**Deferred, recorded so it is not rediscovered:** for high-latency remote links, a second node-side `Storage` decorator may serve reads from an in-memory copy of what Pi has read (the node is the sole writer while it holds the session, and entries are immutable) and forward commits asynchronously in order over the same wire method. It is a write-behind cache with crash semantics, not a second source of truth: nothing durable, no replay, a rejected commit aborts the run. It is not built until a remote node exists and its latency is measured.

## Consequences

- Deleted: node SQLite, node migrations, `session_outbox`, `session.committed`, `node-replica.ts`, watermarks, `session.hydrate`, `session.snapshot` paging and digests, relocation, `revertTo`, `not_owner` fencing and drop, `node_session_deletions`, `session.delete`, `session.provision`, the placement state machine, the move dialog and move-targets endpoint, `@reins/pi-sql-storage` as a separate package (it returns to the backend).
- Per-turn storage traffic crosses the link: negligible locally, about one extra second per tool round at 40 ms round trips until the deferred decorator exists.
- Node crash recovery becomes simple: a reconnecting node lists its live sessions and the server settles the rest as interrupted.
- Idle runtime eviction is a `close` and a map delete, and is needed to bound node memory and to pick up new code.
- The switch is a single cutover, not a migration: the server replica is already exact and ordered for every session whose node outbox is empty, so the new node simply runs every session through the server. Undelivered node outbox rows at the moment of cutover are lost, which is why runs are allowed to settle first.
- Details and slices: [node architecture plan](../plans/node-architecture.md).
