# ADR-009: Node-Owned Canonical Session Storage with a Server Replica

- **Status:** Accepted
- **Date:** 2026-09-27
- **Author:** Will (with Claude)
- **Refines:** [ADR-002](002-sqlite-sessions.md)

## Context

Moving agent execution out of the server into node processes (eventually on other machines) requires deciding which side holds a session's canonical AgentHarness storage. Pi's `PiStorageAdapter` commits are synchronous transactions with sequence checks and local reads during a run. The server still needs every session's history for browsing, search, the context resource and scripting, including while a node is offline.

Alternatives considered:

- **Server-canonical storage behind a networked adapter.** Every Pi commit and read during a run would cross the link; a slow or dropped link would stall or fail runs, and the adapter's transactional guarantees would have to be rebuilt over the network.
- **Rebuilding node state from server display messages.** Display messages omit lane operation/inbox state, branch ancestry and usage, so they cannot faithfully resume Pi.

## Decision

**The node that runs a session owns its canonical storage; the server keeps an exact, ordered replica.**

- Each node stores its sessions in its own SQLite (`~/.reins/node/storage.db`) through the same Pi storage adapter. Every commit records its exact write batch in the node's ordered outbox inside the Pi commit transaction.
- The node delivers batches to the server (`session.committed`), which applies them to its own Pi tables in sequence, keyed by a per-session sequence watermark, and acknowledges; the node deletes a batch only after acknowledgement. A delivery failure never fails the commit.
- Server readers use their usual tables. On the server nothing but replica application writes Pi tables.
- A session at rest on the server (from before nodes) has canonical server tables but never runs there; moving is a copy of the server's rows ([ADR-008](008-server-hub-session-relocation.md)).

## Consequences

- Runs never wait on the network for storage; the server's history can lag while delivery is pending.
- Node data is recoverable from the replica up to what was delivered: undelivered commits are lost with a node's disk.
- Replica application must be idempotent without receipts ([ADR-010](010-state-derived-idempotency.md)).
- Batches are not chunked; a batch larger than a capped remote link's frame limit would block its session's outbox (open work for remote nodes).
